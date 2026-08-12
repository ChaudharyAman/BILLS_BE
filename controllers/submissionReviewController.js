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
  if (!name) return null;

  const escaped = escapeRegex(name).replace(/\s+/g, '\\s+');
  const regex   = new RegExp(`^\\s*${escaped}\\s*$`, 'i');

  const existing = await ClientModel.findOne({ user: userId, name: { $regex: regex } });
  if (existing) {
    let dirty = false;
    if (isVendor && !existing.isVendor)   { existing.isVendor = true; dirty = true; }
    if (isClient && !existing.isClient)   { existing.isClient = true; dirty = true; }
    if (!existing.gstin && partyGST) {
      existing.gstin = String(partyGST).trim().toUpperCase();
      existing.gstTreatment = 'Registered Business';
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
    obj.files = obj.files.map((f) => {
      const plainFile = f.toObject ? f.toObject() : { ...f };
      delete plainFile.buffer;
      return plainFile;
    });
  }
  delete obj.ipAddress; // never expose IP to any API response
  return obj;
}

// ── Internal create helpers ───────────────────────────────────────────────────
// These call the same logic the Express controllers use, without needing req/res.

async function createExpenseFromSubmission(userId, parsedData, overrides, settings) {
  const Expense    = getExpense();

  const vendor = await resolveParty({
    userId,
    partyName: parsedData?.vendorName || '',
    partyGST:  parsedData?.vendorGST  || '',
    isVendor: true, isClient: false,
  });

  const docNumber = await nextDocNumber(userId, settings, 'expenses');
  const grandTotal = Number(overrides?.grandTotal || parsedData?.totalAmount || 0);
  const subTotal   = Number(overrides?.subTotal   || parsedData?.subTotal    || 0);
  const taxTotal   = Number(overrides?.taxAmount  || parsedData?.taxAmount   || 0);

  const expense = await Expense.create({
    user: userId,
    expenseNumber: overrides?.expenseNumber || docNumber,
    date:          overrides?.date          || parsedData?.invoiceDate || new Date(),
    vendor:        vendor ? { vendorRef: vendor._id, name: vendor.name } : { name: parsedData?.vendorName || '' },
    items:         (overrides?.items || parsedData?.items || []).map((item) => ({
      name:     item.name || 'Item',
      qty:      Number(item.quantity || item.qty || 1),
      unit:     item.unit || '',
      rate:     Number(item.price || item.rate || 0),
      taxRate:  Number(item.gst   || item.taxRate || 0),
      taxAmount: 0,
      amount:   Number(item.amount || 0),
    })),
    subTotal,
    taxTotal,
    grandTotal,
    status: 'UNPAID',
    privateNotes: `Imported from public submission`,
  });
  return expense;
}

async function createInvoiceFromSubmission(userId, parsedData, overrides, settings) {
  const Invoice = getInvoice();

  const client = await resolveParty({
    userId,
    partyName: parsedData?.clientName || '',
    partyGST:  parsedData?.clientGST  || '',
    isVendor: false, isClient: true,
  });

  const docNumber  = await nextDocNumber(userId, settings, 'invoices');
  const grandTotal = Number(overrides?.grandTotal || parsedData?.totalAmount || 0);
  const subTotal   = Number(overrides?.subTotal   || parsedData?.subTotal    || 0);
  const taxTotal   = Number(overrides?.taxAmount  || parsedData?.taxAmount   || 0);

  const invoice = await Invoice.create({
    user: userId,
    invoiceNo:   overrides?.invoiceNo || parsedData?.invoiceNumber || docNumber,
    date:        overrides?.date      || parsedData?.invoiceDate   || new Date(),
    dueDate:     overrides?.dueDate   || parsedData?.dueDate       || null,
    client:      client ? { clientRef: client._id, name: client.name } : { name: parsedData?.clientName || '' },
    items:       (overrides?.items || parsedData?.items || []).map((item) => ({
      name:    item.name || 'Item',
      qty:     Number(item.quantity || item.qty || 1),
      unit:    item.unit || '',
      rate:    Number(item.price || item.rate || 0),
      taxRate: Number(item.gst   || item.taxRate || 0),
      taxAmount: 0,
      amount:  Number(item.amount || 0),
    })),
    subTotal,
    taxTotal,
    grandTotal,
    status: 'DRAFT',
    notes: `Imported from public submission`,
  });
  return invoice;
}

async function createIncomeFromSubmission(userId, parsedData, overrides, settings) {
  const Income = getIncome();

  const client = await resolveParty({
    userId,
    partyName: parsedData?.clientName || parsedData?.vendorName || '',
    partyGST:  parsedData?.clientGST  || '',
    isVendor: false, isClient: true,
  });

  const docNumber  = await nextDocNumber(userId, settings, 'incomes');
  const grandTotal = Number(overrides?.grandTotal || parsedData?.totalAmount || 0);
  const subTotal   = Number(overrides?.subTotal   || parsedData?.subTotal    || 0);
  const taxTotal   = Number(overrides?.taxAmount  || parsedData?.taxAmount   || 0);

  const income = await Income.create({
    user: userId,
    incomeNumber: overrides?.incomeNumber || docNumber,
    date:         overrides?.date         || parsedData?.invoiceDate || new Date(),
    client:       client ? { clientRef: client._id, name: client.name } : { name: parsedData?.clientName || '' },
    items:        (overrides?.items || parsedData?.items || []).map((item) => ({
      name:    item.name || 'Item',
      qty:     Number(item.quantity || item.qty || 1),
      unit:    item.unit || '',
      rate:    Number(item.price || item.rate || 0),
      taxRate: Number(item.gst   || item.taxRate || 0),
      taxAmount: 0,
      amount:  Number(item.amount || 0),
    })),
    subTotal,
    taxTotal,
    grandTotal,
    status: 'UNPAID',
    privateNotes: `Imported from public submission`,
  });
  return income;
}

async function createPurchaseOrderFromSubmission(userId, parsedData, overrides, settings) {
  const PurchaseOrder = getPurchaseOrder();

  const vendor = await resolveParty({
    userId,
    partyName: parsedData?.vendorName || '',
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
    vendor:      vendor ? { vendorRef: vendor._id, name: vendor.name } : { name: parsedData?.vendorName || '' },
    items:       (overrides?.items || parsedData?.items || []).map((item) => ({
      name:    item.name || 'Item',
      qty:     Number(item.quantity || item.qty || 1),
      unit:    item.unit || '',
      rate:    Number(item.price || item.rate || 0),
      taxRate: Number(item.gst   || item.taxRate || 0),
      taxAmount: 0,
      amount:  Number(item.amount || 0),
    })),
    subTotal,
    taxTotal,
    grandTotal,
    status: 'DRAFT',
    notes: `Imported from public submission`,
  });
  return po;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/submissions
// Paginated list filtered by companyId.
// File buffers are excluded. Pending count included in response.
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

    const [submissions, total, pendingCount] = await Promise.all([
      PublicSubmission.find(query)
        .select('-files.buffer -ipAddress')   // never send buffer or IP over the wire
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean({ virtuals: true }),
      PublicSubmission.countDocuments(query),
      status ? PublicSubmission.countDocuments({ user: companyId, status: 'pending' }) : Promise.resolve(null),
    ]);

    return res.json({
      data:         submissions.map(formatSubmission),
      total,
      page,
      limit,
      totalPages:   Math.ceil(total / limit),
      pendingCount: pendingCount ?? total,
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

    res.set('Content-Type', file.mimeType || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${file.originalName}"`);
    res.set('Content-Length', file.sizeBytes);
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

    const before = { ...submission.parsedData };
    const incoming = req.body.parsedData;

    if (incoming && typeof incoming === 'object') {
      submission.parsedData = { ...submission.parsedData, ...incoming };
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
      changes:      { before, after: submission.parsedData },
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
// Body: { category, ...fieldOverrides }
// Creates the real Expense/Invoice/Income/PO record via internal helpers.
// Sets resultingRecord + status=approved.
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

    if (submission.status === 'approved') {
      return res.status(400).json({ message: 'This submission has already been approved.' });
    }

    const category = String(req.body.category || submission.suggestedCategory || 'expense').toLowerCase();
    const validCategories = ['invoice', 'expense', 'income', 'purchaseorder'];
    if (!validCategories.includes(category)) {
      return res.status(400).json({ message: `Invalid category "${category}". Must be one of: ${validCategories.join(', ')}` });
    }

    // Load user settings for document numbering prefixes
    const settings = await Settings.findOne({ user: companyId }).lean();
    const parsedData = submission.parsedData || {};
    const overrides  = req.body.overrides   || {};

    let record;
    let collectionName;

    switch (category) {
      case 'expense':
        record = await createExpenseFromSubmission(companyId, parsedData, overrides, settings);
        collectionName = 'expenses';
        break;
      case 'invoice':
        record = await createInvoiceFromSubmission(companyId, parsedData, overrides, settings);
        collectionName = 'invoices';
        break;
      case 'income':
        record = await createIncomeFromSubmission(companyId, parsedData, overrides, settings);
        collectionName = 'incomes';
        break;
      case 'purchaseorder':
        record = await createPurchaseOrderFromSubmission(companyId, parsedData, overrides, settings);
        collectionName = 'purchaseorders';
        break;
      default:
        return res.status(400).json({ message: 'Unknown category' });
    }

    // Update submission
    submission.status          = 'approved';
    submission.decidedBy       = req.user._id;
    submission.decidedAt       = new Date();
    submission.resultingRecord = { collection: collectionName, recordId: record._id };
    await submission.save();

    // Audit log
    await writeAuditLog({
      userId:       submission.user,
      actorId:      req.user._id,
      action:       'SUBMISSION_APPROVED',
      submissionId: submission._id,
      changes:      { category, resultingRecord: { collection: collectionName, recordId: record._id } },
    });

    return res.json({
      success: true,
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
