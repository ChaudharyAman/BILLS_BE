/**
 * submissionReviewController.js
 *
 * Authenticated review actions for the business owner's inbox.
 * All handlers are scoped to companyId = req.companyId || req.user._id — a user can never see or modify
 * another user's submissions (mismatch → 404, not 403, to avoid leaking existence).
 *
 * Approve flow calls internal create-helpers that reuse the same
 * resolveParty / GST / TDS / document-numbering logic already in the existing
 * expense/invoice/income/purchaseOrder controllers, without going through
 * Express req/res.
 */

const mongoose        = require('mongoose');
const crypto          = require('crypto');
const PublicSubmission = require('../models/PublicSubmission');
const AuditLog        = require('../models/AuditLog');
const Settings        = require('../models/Settings');
const Counter         = require('../models/Counter');
const escapeRegex     = require('../utils/escapeRegex');
const { buildAutoDocumentNumber } = require('../utils/documentNumber');

// ── Lazy-loaded models (same pattern used in expenseController) ───────────────
const getExpense         = () => require('../models/Expense');
const getInvoice         = () => require('../models/Invoice');
const getIncome          = () => require('../models/Income');
const getPurchaseOrder   = () => require('../models/PurchaseOrder');
const getClient          = () => require('../models/Client');
const getCategory        = () => require('../models/Category');

// ── Internal helpers ──────────────────────────────────────────────────────────

// Mirrors resolveParty from expenseController without touching req/res
async function resolveParty({
  userId, partyRef, partyName, isVendor, isClient,
  partyGST, partyAddressObject, partyPhone, partyEmail, partyPAN, placeOfSupply,
}) {
  const ClientModel = getClient();

  if (partyRef && mongoose.Types.ObjectId.isValid(partyRef)) {
    const party = await ClientModel.findOne({ _id: partyRef, user: userId });
    if (party) return party;
  }

  const name = String(partyName || '').trim();
  const gstinClean = partyGST ? String(partyGST).trim().toUpperCase() : null;
  const panClean = partyPAN ? String(partyPAN).trim().toUpperCase() : null;

  if (!name && !gstinClean && !panClean) return null;

  let existing = null;
  if (gstinClean) {
    existing = await ClientModel.findOne({ user: userId, gstin: gstinClean });
  }
  if (!existing && panClean) {
    existing = await ClientModel.findOne({ user: userId, pan: panClean });
  }
  if (!existing && name) {
    const escaped = escapeRegex(name).replace(/\s+/g, '\\s+');
    const regex   = new RegExp(`^\\s*${escaped}\\s*$`, 'i');
    existing = await ClientModel.findOne({ user: userId, name: { $regex: regex } });
  }

  if (existing) {
    let dirty = false;
    if (isVendor && !existing.isVendor)   { existing.isVendor = true; dirty = true; }
    if (isClient && !existing.isClient)   { existing.isClient = true; dirty = true; }
    if (!existing.gstin && gstinClean) {
      existing.gstin = gstinClean;
      existing.gstTreatment = 'Registered Business';
      dirty = true;
    }
    if (!existing.pan && panClean) {
      existing.pan = panClean;
      dirty = true;
    }
    if (dirty) await existing.save();
    return existing;
  }

  const gstin = String(partyGST || '').trim().toUpperCase();
  const state  = String(partyAddressObject?.state || placeOfSupply || '').trim();

  const party = new ClientModel({
    user: userId, name, isVendor: !!isVendor, isClient: !!isClient,
    gstin: gstin || undefined,
    gstTreatment: gstin ? 'Registered Business' : 'Unregistered Business',
    placeOfSupply: state || 'Delhi',
    billingAddress: {
      line1: partyAddressObject?.line1 || '',
      line2: partyAddressObject?.line2 || '',
      city:  partyAddressObject?.city  || '',
      state: state || '',
      zip:   partyAddressObject?.zip   || '',
      country: partyAddressObject?.country || 'India',
    },
    phone: partyPhone ? String(partyPhone).trim() : undefined,
    email: partyEmail ? String(partyEmail).trim().toLowerCase() : undefined,
    pan:   partyPAN   ? String(partyPAN).trim().toUpperCase()   : undefined,
  });
  return party.save();
}

// Auto-generate next document number using existing Counter pattern
async function nextDocNumber(userId, settings, modelName) {
  const prefixMap = {
    expenses:       settings?.expensePrefix       || 'EXP',
    invoices:       settings?.invoicePrefix        || 'INV',
    incomes:        'INC',
    purchaseorders: settings?.purchaseOrderPrefix  || 'PO',
  };
  const prefix = prefixMap[modelName] || 'DOC';
  const counterKey = `${modelName}_${userId}`;

  const counter = await Counter.findOneAndUpdate(
    { id: counterKey },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );
  return buildAutoDocumentNumber(prefix, counter.seq);
}

// Write AuditLog entry (same pattern as payrollController)
async function writeAuditLog({ userId, actorId, action, changes, submissionId }) {
  try {
    await AuditLog.create({
      user:    userId,
      actor:   actorId,
      action,
      changes: { submissionId, ...changes },
    });
  } catch (err) {
    // Never block the main flow if audit logging fails
    console.error('[Submission AuditLog] Failed to write:', err.message);
  }
}

// Strip file buffers from submission before sending to client
function formatSubmission(sub) {
  if (!sub) return null;
  const obj = sub.toObject ? sub.toObject({ virtuals: true }) : { ...sub };
  obj.referenceNumber = `SUB-${(sub._id || obj._id).toString().slice(-8).toUpperCase()}`;
  if (Array.isArray(obj.files)) {
    obj.files = obj.files.map((f, idx) => {
      const plainFile = f.toObject ? f.toObject() : { ...f };
      delete plainFile.buffer;
      if (idx === 0 && !plainFile.parsedData && obj.parsedData) {
        plainFile.parsedData = obj.parsedData;
      }
      plainFile.status = plainFile.status || (obj.status === 'approved' ? 'approved' : 'pending');
      plainFile.resultingRecord = plainFile.resultingRecord || (obj.status === 'approved' ? obj.resultingRecord : null);
      return plainFile;
    });
  }
  delete obj.ipAddress; // never expose IP to any API response
  return obj;
}

// ── Internal create helpers ───────────────────────────────────────────────────
// These call the same logic the Express controllers use, without needing req/res.

function formatLineItems(rawItems = [], grandTotal = 0, defaultItemName = 'Item') {
  let items = (rawItems || []).map((item) => {
    const qty = Number(item.quantity || item.qty || 1);
    const rate = Number(item.price || item.rate || 0);
    const amount = Number(item.amount !== undefined && item.amount !== null ? item.amount : (qty * rate));
    return {
      name:      String(item.name || defaultItemName).trim(),
      qty:       qty > 0 ? qty : 1,
      unit:      item.unit || 'PCS',
      rate,
      taxRate:   Number(item.gst || item.taxRate || 0),
      taxAmount: Number(item.taxAmount || 0),
      amount,
    };
  });

  if (items.length === 0 && grandTotal > 0) {
    items = [{
      name:      defaultItemName,
      qty:       1,
      unit:      'PCS',
      rate:      grandTotal,
      taxRate:   0,
      taxAmount: 0,
      amount:    grandTotal,
    }];
  }
  return items;
}

async function createExpenseFromSubmission(userId, parsedData, overrides, settings, attachments = [], fallbackName = 'Vendor') {
  const Expense    = getExpense();

  const vendorName = String(overrides?.vendorName || parsedData?.vendorName || fallbackName || 'Vendor').trim();
  const vendor = await resolveParty({
    userId,
    partyName: vendorName,
    partyGST:  parsedData?.vendorGST  || '',
    isVendor: true, isClient: false,
  });

  const docNumber = await nextDocNumber(userId, settings, 'expenses');
  const grandTotal = Number(overrides?.grandTotal || parsedData?.totalAmount || 0);
  const subTotal   = Number(overrides?.subTotal   || parsedData?.subTotal    || 0);
  const taxTotal   = Number(overrides?.taxAmount  || parsedData?.taxAmount   || 0);
  const balanceDue = overrides?.balanceDue !== undefined ? Number(overrides.balanceDue) : grandTotal;

  const expense = await Expense.create({
    user: userId,
    expenseNumber: overrides?.expenseNumber || docNumber,
    date:          overrides?.date          || parsedData?.invoiceDate || new Date(),
    vendor:        vendor ? { vendorRef: vendor._id, name: vendor.name } : { name: vendorName },
    items:         formatLineItems(overrides?.items || parsedData?.items, grandTotal, 'Expense Item'),
    subTotal,
    taxTotal,
    grandTotal,
    balanceDue,
    status: 'UNPAID',
    attachments: attachments || [],
    privateNotes: `Imported from public submission`,
  });
  return expense;
}

async function createInvoiceFromSubmission(userId, parsedData, overrides, settings, attachments = [], fallbackName = 'Customer') {
  const Invoice = getInvoice();

  const clientName = String(overrides?.clientName || parsedData?.clientName || fallbackName || 'Customer').trim();
  const client = await resolveParty({
    userId,
    partyName: clientName,
    partyGST:  parsedData?.clientGST  || '',
    isVendor: false, isClient: true,
  });

  const docNumber  = await nextDocNumber(userId, settings, 'invoices');
  const grandTotal = Number(overrides?.grandTotal || parsedData?.totalAmount || 0);
  const subTotal   = Number(overrides?.subTotal   || parsedData?.subTotal    || 0);
  const taxTotal   = Number(overrides?.taxAmount  || parsedData?.taxAmount   || 0);
  const balanceDue = overrides?.balanceDue !== undefined ? Number(overrides.balanceDue) : grandTotal;
  const roundOff   = overrides?.roundOff !== undefined ? Number(overrides.roundOff) : Number(parsedData?.roundOff || 0);

  const invoice = await Invoice.create({
    user: userId,
    invoiceNo:   overrides?.invoiceNo || parsedData?.invoiceNumber || docNumber,
    date:        overrides?.date      || parsedData?.invoiceDate   || new Date(),
    dueDate:     overrides?.dueDate   || parsedData?.dueDate       || null,
    client:      client ? { clientRef: client._id, name: client.name } : { name: clientName },
    items:       formatLineItems(overrides?.items || parsedData?.items, grandTotal, 'Invoice Item'),
    subTotal,
    taxTotal,
    grandTotal,
    totalAmount: grandTotal,
    balanceDue,
    roundOff,
    status: 'DRAFT',
    attachments: attachments || [],
    notes: `Imported from public submission`,
  });
  return invoice;
}

async function createIncomeFromSubmission(userId, parsedData, overrides, settings, attachments = [], fallbackName = 'Customer') {
  const Income = getIncome();

  const clientName = String(overrides?.clientName || parsedData?.clientName || parsedData?.vendorName || fallbackName || 'Customer').trim();
  const client = await resolveParty({
    userId,
    partyName: clientName,
    partyGST:  parsedData?.clientGST  || '',
    isVendor: false, isClient: true,
  });

  const docNumber  = await nextDocNumber(userId, settings, 'incomes');
  const grandTotal = Number(overrides?.grandTotal || parsedData?.totalAmount || 0);
  const subTotal   = Number(overrides?.subTotal   || parsedData?.subTotal    || 0);
  const taxTotal   = Number(overrides?.taxAmount  || parsedData?.taxAmount   || 0);
  const balanceDue = overrides?.balanceDue !== undefined ? Number(overrides.balanceDue) : grandTotal;

  const income = await Income.create({
    user: userId,
    incomeNumber: overrides?.incomeNumber || docNumber,
    date:         overrides?.date         || parsedData?.invoiceDate || new Date(),
    client:       client ? { clientRef: client._id, name: client.name } : { name: clientName },
    items:        formatLineItems(overrides?.items || parsedData?.items, grandTotal, 'Income Item'),
    subTotal,
    taxTotal,
    grandTotal,
    balanceDue,
    status: 'UNPAID',
    attachments: attachments || [],
    privateNotes: `Imported from public submission`,
  });
  return income;
}

async function createPurchaseOrderFromSubmission(userId, parsedData, overrides, settings, attachments = [], fallbackName = 'Vendor') {
  const PurchaseOrder = getPurchaseOrder();

  const vendorName = String(overrides?.vendorName || parsedData?.vendorName || fallbackName || 'Vendor').trim();
  const vendor = await resolveParty({
    userId,
    partyName: vendorName,
    partyGST:  parsedData?.vendorGST  || '',
    isVendor: true, isClient: false,
  });

  const docNumber  = await nextDocNumber(userId, settings, 'purchaseorders');
  const grandTotal = Number(overrides?.grandTotal || parsedData?.totalAmount || 0);
  const subTotal   = Number(overrides?.subTotal   || parsedData?.subTotal    || 0);
  const taxTotal   = Number(overrides?.taxAmount  || parsedData?.taxAmount   || 0);

  const po = await PurchaseOrder.create({
    user: userId,
    poNumber:    overrides?.poNumber || docNumber,
    date:        overrides?.date     || parsedData?.invoiceDate || new Date(),
    vendor:      vendor ? { vendorRef: vendor._id, name: vendor.name } : { name: vendorName },
    items:       formatLineItems(overrides?.items || parsedData?.items, grandTotal, 'PO Item'),
    subTotal,
    taxTotal,
    grandTotal,
    status: 'DRAFT',
    attachments: attachments || [],
    notes: `Imported from public submission`,
  });
  return po;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/submissions
// Paginated list filtered by companyId.
// File buffers are excluded. Pending count and submitters summary included in response.
// ─────────────────────────────────────────────────────────────────────────────
exports.getSubmissions = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const page   = Math.max(parseInt(req.query.page,  10) || 1, 1);
    const limit  = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const skip   = (page - 1) * limit;
    const status = req.query.status || undefined;

    const query = { user: companyId };
    if (status) query.status = status;

    let submittersParam = req.query.submitters || req.query.submitter;
    let submitterList = [];
    if (Array.isArray(submittersParam)) {
      submitterList = submittersParam.map((s) => String(s).trim()).filter(Boolean);
    } else if (typeof submittersParam === 'string' && submittersParam.trim()) {
      submitterList = submittersParam.split(',').map((s) => s.trim()).filter(Boolean);
    }

    if (submitterList.length > 0) {
      const orConditions = [];
      for (const item of submitterList) {
        if (item.toLowerCase() === 'anonymous') {
          orConditions.push({
            $and: [
              { $or: [{ submitterName: '' }, { submitterName: null }, { submitterName: 'Anonymous' }] },
              { $or: [{ submitterEmail: '' }, { submitterEmail: null }] },
            ],
          });
        } else if (item.includes('@')) {
          orConditions.push({ submitterEmail: item.toLowerCase() });
        } else {
          orConditions.push(
            { submitterName: item },
            { submitterEmail: item.toLowerCase() }
          );
        }
      }
      if (orConditions.length > 0) {
        query.$or = orConditions;
      }
    }

    const companyObjectId = new mongoose.Types.ObjectId(companyId.toString());

    const [submissions, total, pendingCount, submittersAggregation] = await Promise.all([
      PublicSubmission.find(query)
        .select('-files.buffer -ipAddress')   // never send buffer or IP over the wire
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean({ virtuals: true }),
      PublicSubmission.countDocuments(query),
      status ? PublicSubmission.countDocuments({ user: companyId, status: 'pending' }) : Promise.resolve(null),
      PublicSubmission.aggregate([
        { $match: { user: companyObjectId } },
        {
          $group: {
            _id: {
              $cond: [
                { $and: [{ $ne: ['$submitterEmail', null] }, { $ne: ['$submitterEmail', ''] }] },
                { $toLower: '$submitterEmail' },
                {
                  $cond: [
                    { $and: [{ $ne: ['$submitterName', null] }, { $ne: ['$submitterName', ''] }] },
                    '$submitterName',
                    'Anonymous'
                  ]
                }
              ]
            },
            name: { $first: '$submitterName' },
            email: { $first: '$submitterEmail' },
            avatar: { $first: '$submitterAvatar' },
            isGoogleVerified: { $max: '$isGoogleVerified' },
            totalSubmissions: { $sum: 1 },
            pendingCount: {
              $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] }
            },
            needsChangesCount: {
              $sum: { $cond: [{ $eq: ['$status', 'needs-changes'] }, 1, 0] }
            },
            approvedCount: {
              $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] }
            },
            rejectedCount: {
              $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] }
            },
            totalAmount: {
              $sum: {
                $cond: [
                  { $and: [{ $ne: ['$parsedData.grandTotal', null] }, { $gt: ['$parsedData.grandTotal', 0] }] },
                  '$parsedData.grandTotal',
                  0
                ]
              }
            },
            latestSubmissionAt: { $max: '$createdAt' }
          }
        },
        { $sort: { latestSubmissionAt: -1 } }
      ]),
    ]);

    // Deduplicate / merge submitters if the same user submitted with/without email
    const submitterMap = new Map();
    for (const s of submittersAggregation || []) {
      const name = (s.name || '').trim();
      const email = (s.email || '').trim().toLowerCase();

      let existingKey = null;
      if (email) {
        existingKey = email;
      } else if (name && name.toLowerCase() !== 'anonymous') {
        for (const [k, val] of submitterMap.entries()) {
          if (val.name && val.name.toLowerCase() === name.toLowerCase()) {
            existingKey = k;
            break;
          }
        }
        if (!existingKey) existingKey = name;
      } else {
        existingKey = 'Anonymous';
      }

      if (submitterMap.has(existingKey)) {
        const existing = submitterMap.get(existingKey);
        if (!existing.email && email) existing.email = email;
        if (!existing.avatar && s.avatar) existing.avatar = s.avatar;
        if (s.isGoogleVerified) existing.isGoogleVerified = true;
        existing.keys.push(s._id);
        existing.totalSubmissions += (s.totalSubmissions || 0);
        existing.pendingCount += (s.pendingCount || 0);
        existing.needsChangesCount += (s.needsChangesCount || 0);
        existing.approvedCount += (s.approvedCount || 0);
        existing.rejectedCount += (s.rejectedCount || 0);
        existing.totalAmount += (s.totalAmount || 0);
        if (new Date(s.latestSubmissionAt) > new Date(existing.latestSubmissionAt)) {
          existing.latestSubmissionAt = s.latestSubmissionAt;
        }
      } else {
        submitterMap.set(existingKey, {
          key: s._id,
          keys: [s._id],
          name: name || (email ? email.split('@')[0] : 'Anonymous'),
          email: email,
          avatar: s.avatar || '',
          isGoogleVerified: !!s.isGoogleVerified,
          totalSubmissions: s.totalSubmissions || 0,
          pendingCount: s.pendingCount || 0,
          needsChangesCount: s.needsChangesCount || 0,
          approvedCount: s.approvedCount || 0,
          rejectedCount: s.rejectedCount || 0,
          totalAmount: s.totalAmount || 0,
          latestSubmissionAt: s.latestSubmissionAt,
        });
      }
    }

    const submitters = Array.from(submitterMap.values());

    return res.json({
      data:            submissions.map(formatSubmission),
      total,
      page,
      limit,
      totalPages:      Math.ceil(total / limit),
      pendingCount:    pendingCount ?? total,
      totalSubmitters: submitters.length,
      submitters,
    });
  } catch (error) {
    console.error('[Submission] getSubmissions error:', error.message);
    return res.status(500).json({ message: 'Server error fetching submissions' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/submissions/:id
// Full detail. If submission doesn't belong to companyId → 404 (not 403).
// Files returned without buffer; download via /api/submissions/:id/files/:fileIndex
// ─────────────────────────────────────────────────────────────────────────────
exports.getSubmissionById = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Submission not found' });
    }

    const submission = await PublicSubmission.findOne({
      _id:  req.params.id,
      user: companyId,
    }).select('-files.buffer -ipAddress').lean({ virtuals: true });

    if (!submission) {
      return res.status(404).json({ message: 'Submission not found' });
    }

    return res.json(formatSubmission(submission));
  } catch (error) {
    console.error('[Submission] getSubmissionById error:', error.message);
    return res.status(500).json({ message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/submissions/:id/files/:fileIndex/parse
// On-demand parser for a single file in a multi-file submission
// ─────────────────────────────────────────────────────────────────────────────
exports.parseSubmissionFile = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Submission not found' });
    }

    const submission = await PublicSubmission.findOne({
      _id:  req.params.id,
      user: companyId,
    });

    if (!submission) {
      return res.status(404).json({ message: 'Submission not found' });
    }

    const fileIndex = parseInt(req.params.fileIndex, 10);
    const file = submission.files?.[fileIndex];

    if (!file || !file.buffer) {
      return res.status(404).json({ message: 'File not found' });
    }

    const { parseFile } = require('./publicSubmissionController');
    const parsed = await parseFile({
      buffer: file.buffer,
      originalname: file.originalName,
      mimetype: file.mimeType,
      size: file.sizeBytes,
    }, submission.suggestedCategory || 'expense');

    file.parsedData = parsed;
    if (fileIndex === 0) {
      submission.parsedData = parsed;
    }
    submission.markModified('files');
    await submission.save();

    return res.json({
      success: true,
      fileIndex,
      parsedData: parsed,
      submission: formatSubmission(submission),
    });
  } catch (error) {
    console.error('[Submission] parseSubmissionFile error:', error.message);
    return res.status(500).json({ message: 'Failed to parse file' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/submissions/:id/files/:fileIndex
// Serves a single file buffer as a download. Scoped to companyId.
// ─────────────────────────────────────────────────────────────────────────────
exports.getSubmissionFile = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Submission not found' });
    }

    const submission = await PublicSubmission.findOne({
      _id:  req.params.id,
      user: companyId,
    }).select('files');

    if (!submission) {
      return res.status(404).json({ message: 'Submission not found' });
    }

    const fileIndex = parseInt(req.params.fileIndex, 10);
    const file = submission.files?.[fileIndex];

    if (!file || !file.buffer) {
      return res.status(404).json({ message: 'File not found' });
    }

    const mime = file.mimeType || 'application/pdf';
    res.set('Content-Type', mime);
    res.set('Content-Disposition', `inline; filename="${encodeURIComponent(file.originalName)}"`);
    res.set('Content-Length', file.buffer.length);
    return res.send(file.buffer);
  } catch (error) {
    console.error('[Submission] getSubmissionFile error:', error.message);
    return res.status(500).json({ message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/submissions/:id
// Reviewer edits parsedData before making a decision.
// Writes an AuditLog entry with before/after diff.
// ─────────────────────────────────────────────────────────────────────────────
exports.editParsedData = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Submission not found' });
    }

    const submission = await PublicSubmission.findOne({
      _id:  req.params.id,
      user: companyId,
    });
    if (!submission) return res.status(404).json({ message: 'Submission not found' });

    if (submission.status !== 'pending' && submission.status !== 'needs-changes') {
      return res.status(400).json({
        message: `Cannot edit a submission with status "${submission.status}".`,
      });
    }

    const incoming = req.body.parsedData;
    const fileIndex = req.body.fileIndex !== undefined ? parseInt(req.body.fileIndex, 10) : undefined;

    if (incoming && typeof incoming === 'object') {
      if (fileIndex !== undefined && submission.files?.[fileIndex]) {
        submission.files[fileIndex].parsedData = {
          ...(submission.files[fileIndex].parsedData || {}),
          ...incoming,
        };
        submission.markModified('files');
      }
      if (fileIndex === undefined || fileIndex === 0) {
        submission.parsedData = { ...submission.parsedData, ...incoming };
      }
    }
    if (req.body.suggestedCategory) {
      submission.suggestedCategory = req.body.suggestedCategory;
    }
    await submission.save();

    // Audit log
    await writeAuditLog({
      userId:       submission.user,
      actorId:      req.user._id,
      action:       'SUBMISSION_EDITED',
      submissionId: submission._id,
      changes:      { fileIndex, after: incoming },
    });

    return res.json({
      data: formatSubmission(submission),
      message: 'Submission updated.',
    });
  } catch (error) {
    console.error('[Submission] editParsedData error:', error.message);
    return res.status(500).json({ message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/submissions/:id/approve
// Body: { category, fileIndex?, mode?, ...fieldOverrides }
// Supports:
//   1. fileIndex: approves just that specific file in the drawer
//   2. mode: 'all-individual': approves each file as its own record
//   3. default (consolidated): approves all files into 1 record
// ─────────────────────────────────────────────────────────────────────────────
exports.approveSubmission = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Submission not found' });
    }

    const submission = await PublicSubmission.findOne({
      _id:  req.params.id,
      user: companyId,
    });
    if (!submission) return res.status(404).json({ message: 'Submission not found' });

    if (submission.status === 'approved' && req.body.fileIndex === undefined) {
      return res.status(400).json({ message: 'This submission has already been approved.' });
    }

    const category = String(req.body.category || submission.suggestedCategory || 'expense').toLowerCase();
    const validCategories = ['invoice', 'expense', 'income', 'purchaseorder'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({ message: `Invalid category "${category}". Must be one of: ${validCategories.join(', ')}` });
    }

    const settings = await Settings.findOne({ user: companyId }).lean();
    const overrides = req.body.overrides || {};
    const fileIndex = req.body.fileIndex !== undefined ? parseInt(req.body.fileIndex, 10) : undefined;
    const mode = req.body.mode;

    const fileToAttachment = (f) => {
      if (!f || !f.buffer) return null;
      return {
        originalName: f.originalName || 'file',
        mimeType:     f.mimeType || 'application/pdf',
        sizeBytes:    f.sizeBytes || (f.buffer ? f.buffer.length : 0),
        buffer:       f.buffer,
        uploadedAt:   f.uploadedAt || new Date(),
      };
    };

    const createRecordForData = async (data, customOverrides = {}, fileAttachments = []) => {
      const fallbackName = submission.submitterName || (category === 'invoice' || category === 'income' ? 'Customer' : 'Vendor');
      let rec, coll;
      switch (category) {
        case 'expense':
          rec = await createExpenseFromSubmission(companyId, data, customOverrides, settings, fileAttachments, fallbackName);
          coll = 'expenses';
          break;
        case 'invoice':
          rec = await createInvoiceFromSubmission(companyId, data, customOverrides, settings, fileAttachments, fallbackName);
          coll = 'invoices';
          break;
        case 'income':
          rec = await createIncomeFromSubmission(companyId, data, customOverrides, settings, fileAttachments, fallbackName);
          coll = 'incomes';
          break;
        case 'purchaseorder':
          rec = await createPurchaseOrderFromSubmission(companyId, data, customOverrides, settings, fileAttachments, fallbackName);
          coll = 'purchaseorders';
          break;
        default:
          throw new Error('Unknown category');
      }
      return { record: rec, collectionName: coll };
    };

    // Mode 1: Approve all files as separate records
    if (mode === 'all-individual' && Array.isArray(submission.files) && submission.files.length > 1) {
      const { parseFile } = require('./publicSubmissionController');
      const results = [];
      for (let i = 0; i < submission.files.length; i++) {
        const f = submission.files[i];
        if (f.status === 'approved') continue;

        // Auto-extract if parsedData is missing but buffer exists
        if (!f.parsedData && f.buffer) {
          try {
            f.parsedData = await parseFile({
              buffer: f.buffer,
              originalname: f.originalName,
              mimetype: f.mimeType,
              size: f.sizeBytes,
            }, category);
          } catch (pErr) {
            console.warn(`[Approve All] Auto-parse failed for file ${i}:`, pErr.message);
          }
        }

        const fileData = f.parsedData || (i === 0 ? submission.parsedData : {});
        const att = fileToAttachment(f);
        const { record, collectionName } = await createRecordForData(fileData, {}, att ? [att] : []);
        f.status = 'approved';
        f.resultingRecord = { collection: collectionName, recordId: record._id };
        results.push({ fileIndex: i, collection: collectionName, recordId: record._id });
      }

      submission.status = 'approved';
      submission.decidedBy = req.user._id;
      submission.decidedAt = new Date();
      if (results[0]) {
        submission.resultingRecord = { collection: results[0].collection, recordId: results[0].recordId };
      }
      submission.markModified('files');
      await submission.save();

      await writeAuditLog({
        userId: submission.user,
        actorId: req.user._id,
        action: 'SUBMISSION_APPROVED_ALL_INDIVIDUAL',
        submissionId: submission._id,
        changes: { category, count: results.length, results },
      });

      return res.json({
        success: true,
        data: formatSubmission(submission),
        createdCount: results.length,
        resultingRecord: submission.resultingRecord,
        message: `Approved ${results.length} files as individual ${category} records.`,
      });
    }

    // Mode 2: Approve a single file in the drawer
    if (fileIndex !== undefined && submission.files?.[fileIndex]) {
      const targetFile = submission.files[fileIndex];
      if (targetFile.status === 'approved') {
        return res.status(400).json({ message: 'This file has already been approved.' });
      }

      const fileData = targetFile.parsedData || (fileIndex === 0 ? submission.parsedData : {});
      const att = fileToAttachment(targetFile);
      const { record, collectionName } = await createRecordForData(fileData, overrides, att ? [att] : []);

      targetFile.status = 'approved';
      targetFile.resultingRecord = { collection: collectionName, recordId: record._id };

      const allApproved = submission.files.every(f => f.status === 'approved');
      if (allApproved) {
        submission.status = 'approved';
        submission.decidedBy = req.user._id;
        submission.decidedAt = new Date();
        submission.resultingRecord = { collection: collectionName, recordId: record._id };
      }
      submission.markModified('files');
      await submission.save();

      await writeAuditLog({
        userId: submission.user,
        actorId: req.user._id,
        action: 'SUBMISSION_FILE_APPROVED',
        submissionId: submission._id,
        changes: { fileIndex, category, resultingRecord: { collection: collectionName, recordId: record._id } },
      });

      return res.json({
        success: true,
        fileIndex,
        data: formatSubmission(submission),
        resultingRecord: { collection: collectionName, recordId: record._id },
        allApproved,
        message: `File "${targetFile.originalName}" approved and ${category} record created.`,
      });
    }

    // Mode 3: Consolidated (approve all files into one single record)
    const parsedData = submission.parsedData || {};
    const allAttachments = (submission.files || [])
      .map(fileToAttachment)
      .filter(Boolean);
    const { record, collectionName } = await createRecordForData(parsedData, overrides, allAttachments);

    submission.status = 'approved';
    submission.decidedBy = req.user._id;
    submission.decidedAt = new Date();
    submission.resultingRecord = { collection: collectionName, recordId: record._id };
    if (Array.isArray(submission.files)) {
      submission.files.forEach(f => {
        f.status = 'approved';
        f.resultingRecord = { collection: collectionName, recordId: record._id };
      });
      submission.markModified('files');
    }
    await submission.save();

    await writeAuditLog({
      userId: submission.user,
      actorId: req.user._id,
      action: 'SUBMISSION_APPROVED',
      submissionId: submission._id,
      changes: { category, resultingRecord: { collection: collectionName, recordId: record._id } },
    });

    return res.json({
      success: true,
      data: formatSubmission(submission),
      resultingRecord: { collection: collectionName, recordId: record._id },
      message: `Submission approved and ${category} record created.`,
    });
  } catch (error) {
    console.error('[Submission] approveSubmission error:', error.message);
    return res.status(error.statusCode || 500).json({
      message: error.message || 'Server error during approval',
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/submissions/:id/reject
// Body: { reason }
// ─────────────────────────────────────────────────────────────────────────────
exports.rejectSubmission = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Submission not found' });
    }

    const submission = await PublicSubmission.findOne({
      _id:  req.params.id,
      user: companyId,
    });
    if (!submission) return res.status(404).json({ message: 'Submission not found' });

    if (submission.status === 'approved') {
      return res.status(400).json({ message: 'Cannot reject an already-approved submission.' });
    }

    submission.status      = 'rejected';
    submission.reviewerNote = String(req.body.reason || '').trim().slice(0, 2000);
    submission.decidedBy   = req.user._id;
    submission.decidedAt   = new Date();
    await submission.save();

    await writeAuditLog({
      userId:       submission.user,
      actorId:      req.user._id,
      action:       'SUBMISSION_REJECTED',
      submissionId: submission._id,
      changes:      { reason: submission.reviewerNote },
    });

    return res.json({ success: true, message: 'Submission rejected.' });
  } catch (error) {
    console.error('[Submission] rejectSubmission error:', error.message);
    return res.status(500).json({ message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/submissions/:id/request-changes
// Body: { note }
// Internal flag — not visible to the submitter.
// ─────────────────────────────────────────────────────────────────────────────
exports.requestChanges = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Submission not found' });
    }

    const submission = await PublicSubmission.findOne({
      _id:  req.params.id,
      user: companyId,
    });
    if (!submission) return res.status(404).json({ message: 'Submission not found' });

    if (submission.status === 'approved') {
      return res.status(400).json({ message: 'Cannot request changes on an already-approved submission.' });
    }

    submission.status       = 'needs-changes';
    submission.reviewerNote = String(req.body.note || '').trim().slice(0, 2000);
    submission.decidedBy    = req.user._id;
    submission.decidedAt    = new Date();
    await submission.save();

    await writeAuditLog({
      userId:       submission.user,
      actorId:      req.user._id,
      action:       'SUBMISSION_CHANGES_REQUESTED',
      submissionId: submission._id,
      changes:      { note: submission.reviewerNote },
    });

    return res.json({ success: true, message: 'Submission marked as needing changes.' });
  } catch (error) {
    console.error('[Submission] requestChanges error:', error.message);
    return res.status(500).json({ message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/submissions/:id/split
// Splits a multi-file submission into individual submissions so each invoice
// can be reviewed, edited, and approved independently.
// ─────────────────────────────────────────────────────────────────────────────
exports.splitSubmission = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Submission not found' });
    }

    const submission = await PublicSubmission.findOne({
      _id: req.params.id,
      user: companyId,
    });
    if (!submission) return res.status(404).json({ message: 'Submission not found' });

    if (submission.status === 'approved') {
      return res.status(400).json({ message: 'Cannot split an already-approved submission.' });
    }

    const files = submission.files || [];
    if (files.length <= 1) {
      return res.status(400).json({ message: 'This submission only contains one file and cannot be split.' });
    }

    const { parseFile, guessSuggestedCategory } = require('./publicSubmissionController');
    const settings = await Settings.findOne({ user: companyId }).lean();
    const allowed = settings?.publicSubmissions?.allowedCategories || ['expense'];

    // Keep file 0 on the existing submission
    const primaryFile = files[0];
    const secondaryFiles = files.slice(1);

    submission.files = [primaryFile];
    await submission.save();

    // Create a separate submission for each secondary file
    const createdSubmissions = [];
    for (const file of secondaryFiles) {
      const fileForParsing = {
        buffer: file.buffer,
        originalname: file.originalName,
        mimetype: file.mimeType,
        size: file.sizeBytes,
      };

      const parsedData = (file.parsedData && Object.keys(file.parsedData).length > 0)
        ? file.parsedData
        : await parseFile(fileForParsing, submission.suggestedCategory || 'expense');
      const suggestedCategory = guessSuggestedCategory(allowed, parsedData, file.mimeType);

      const fileForNewSub = {
        originalName: file.originalName,
        mimeType:     file.mimeType,
        sizeBytes:    file.sizeBytes,
        buffer:       file.buffer,
        uploadedAt:   file.uploadedAt || new Date(),
        parsedData,
        status:       'pending',
      };

      const newSub = await PublicSubmission.create({
        user: submission.user,
        submitterName: submission.submitterName,
        submitterEmail: submission.submitterEmail,
        submitterPhone: submission.submitterPhone,
        submitterNote: submission.submitterNote,
        files: [fileForNewSub],
        parsedData,
        suggestedCategory,
        status: 'pending',
        ipAddress: submission.ipAddress,
      });
      createdSubmissions.push(newSub);
    }

    await writeAuditLog({
      userId: submission.user,
      actorId: req.user._id,
      action: 'SUBMISSION_SPLIT',
      submissionId: submission._id,
      changes: {
        originalSubmissionId: submission._id,
        createdCount: createdSubmissions.length,
        totalFiles: files.length,
      },
    });

    return res.json({
      success: true,
      message: `Successfully split into ${files.length} individual submissions.`,
      count: files.length,
    });
  } catch (error) {
    console.error('[Submission] splitSubmission error:', error.message);
    return res.status(500).json({ message: 'Server error splitting submission' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/submissions/:id/files/:fileIndex
// Removes a single file from a multi-file submission.
// ─────────────────────────────────────────────────────────────────────────────
exports.removeSubmissionFile = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Submission not found' });
    }

    const submission = await PublicSubmission.findOne({
      _id: req.params.id,
      user: companyId,
    });
    if (!submission) return res.status(404).json({ message: 'Submission not found' });

    if (submission.status === 'approved') {
      return res.status(400).json({ message: 'Cannot remove files from an approved submission.' });
    }

    const fileIndex = parseInt(req.params.fileIndex, 10);
    if (isNaN(fileIndex) || fileIndex < 0 || fileIndex >= (submission.files || []).length) {
      return res.status(404).json({ message: 'File index not found.' });
    }

    if (submission.files.length <= 1) {
      return res.status(400).json({ message: 'Cannot remove the only file from this submission.' });
    }

    submission.files.splice(fileIndex, 1);
    if (fileIndex === 0 && submission.files.length > 0) {
      submission.parsedData = submission.files[0].parsedData || {};
    }
    submission.markModified('files');
    await submission.save();

    return res.json({
      success: true,
      message: 'File removed from submission.',
      data: formatSubmission(submission),
    });
  } catch (error) {
    console.error('[Submission] removeSubmissionFile error:', error.message);
    return res.status(500).json({ message: 'Server error removing file' });
  }
};
