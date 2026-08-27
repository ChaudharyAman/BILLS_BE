const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const Item = require('../models/Item');
const Counter = require('../models/Counter');
const Settings = require('../models/Settings');
const PurchaseOrder = require('../models/PurchaseOrder');
const CashLedgerEntry = require('../models/CashLedgerEntry');
const { recordCashMovement, roundTwo } = require('../utils/cashLedgerHelper');
const mongoose = require('mongoose');
const escapeRegex = require('../utils/escapeRegex');
const { buildAutoDocumentNumber } = require('../utils/documentNumber');
const { syncIncomeFromInvoice, removeIncomeForInvoice } = require('../services/invoiceIncomeSync');
const { isInterStateSupply, processDocumentItems } = require('../utils/gstCalculator');
const { calculateTds } = require('../utils/tdsCalculator');
const { buildUserCounterId } = require('../utils/counterKey');
const { parseOptionalDateRange, parseImportedDate } = require('../utils/dateRange');
const { processIncomingAttachments, sanitizeAttachments, streamAttachment } = require('../utils/attachmentHelper');

const User = require('../models/User');
const PDF_IMPORT_SOURCE = 'pdf';
const ACTIVE_INVOICE_STATUSES = ['SENT', 'PAID', 'RECEIVED', 'PARTIAL', 'UNPAID'];
const TDS_SECTION_LABELS = {
  '194C': 'Contractor',
  '194J': 'Professional/Technical Fees',
  '194I': 'Rent',
  '194A': 'Interest',
  'Manual': 'Manual Custom Rate'
};

async function syncInvoiceCashMovement(invoice, paymentDate = new Date(), session = null) {
  if (!invoice || !invoice.user || !invoice._id) return;
  const companyId = invoice.user;
  const grandTotal = Number(invoice.grandTotal) || 0;
  const finalTds = Number(invoice.tds) || 0;
  const status = invoice.status || 'DRAFT';

  let paidAmount = 0;
  if (status === 'PAID') {
    paidAmount = Math.max(0, roundTwo(grandTotal - finalTds));
  } else if (status === 'PARTIAL') {
    paidAmount = Math.max(0, roundTwo(Number(invoice.advancePaid) || 0));
  }

  const match = {
    user: new mongoose.Types.ObjectId(String(companyId)),
    sourceModel: 'Invoice',
    sourceId: new mongoose.Types.ObjectId(String(invoice._id)),
    isDeleted: { $ne: true },
  };

  const existing = await CashLedgerEntry.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const previouslyPosted = roundTwo(existing[0]?.total || 0);
  const delta = roundTwo(paidAmount - previouslyPosted);

  if (Math.abs(delta) >= 0.01) {
    await recordCashMovement({
      user: companyId,
      amount: delta,
      type: 'invoice_payment',
      sourceModel: 'Invoice',
      sourceId: invoice._id,
      date: paymentDate || invoice.date || new Date(),
      notes: `Payment for Invoice #${invoice.invoiceNo || invoice._id}`,
      session,
    });
  }
}

function hasValidGstin(gstin) {
  return /^[0-9A-Z]{15}$/.test(String(gstin || '').trim().toUpperCase());
}

function determineInvoiceType({ items = [], placeOfSupply = '', client } = {}) {
  const invoiceItems = Array.isArray(items) ? items : [];
  if (invoiceItems.length && invoiceItems.every((item) => item.isNilRated === true || Number(item.taxRate) === 0)) {
    return 'NilRated';
  }
  if (/international|export/i.test(String(placeOfSupply || ''))) {
    return 'Export';
  }
  if (hasValidGstin(client?.gstin || client?.client?.gstin)) {
    return 'B2B';
  }
  return 'B2C';
}

function isInvoiceNumberDuplicateError(error) {
  return (
    error?.code === 11000 &&
    (error?.keyPattern?.invoiceNo || String(error?.message || '').includes('invoiceNo'))
  );
}

function escapeRegexLiteral(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function generateNextUniqueInvoiceNumber({ userId, invoicePrefix }) {
  const counterId = buildUserCounterId(userId, 'invoiceNo');
  const normalizedPrefix = String(invoicePrefix || 'INV').trim().replace(/[-/\s]+$/g, '') || 'INV';
  const pattern = new RegExp(`^${escapeRegexLiteral(normalizedPrefix)}-(\\d+)$`);

  const existingInvoiceNumbers = await Invoice.find({
    user: userId,
    invoiceNo: { $regex: `^${escapeRegexLiteral(normalizedPrefix)}-\\d+$` },
  })
    .select('invoiceNo -_id')
    .lean();

  let maxExistingSeq = 0;
  for (const entry of existingInvoiceNumbers) {
    const match = pattern.exec(String(entry.invoiceNo || '').trim());
    if (!match) continue;
    const seq = Number(match[1]);
    if (Number.isFinite(seq) && seq > maxExistingSeq) {
      maxExistingSeq = seq;
    }
  }

  await Counter.findOneAndUpdate(
    { id: counterId },
    { $max: { seq: maxExistingSeq } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const counter = await Counter.findOneAndUpdate(
      { id: counterId },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    const candidate = buildAutoDocumentNumber(normalizedPrefix, counter.seq);
    const exists = await Invoice.exists({ user: userId, invoiceNo: candidate });
    if (!exists) {
      return candidate;
    }
  }

  throw new Error('Could not reserve a unique invoice number.');
}

function formatDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function isSameImportedInvoice(existingInvoice, importedDate, importedGrandTotal) {
  return (
    formatDateKey(existingInvoice?.date) === formatDateKey(importedDate) &&
    roundToTwo(existingInvoice?.grandTotal) === roundToTwo(importedGrandTotal)
  );
}

// Helper to calculate Financial Year (April - March)
function getFinancialYear(date) {
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  const year = d.getFullYear();
  const month = d.getMonth() + 1; // 1-12
  if (month >= 4) {
    return `${year}-${(year + 1).toString().slice(-2)}`;
  } else {
    return `${year - 1}-${year.toString().slice(-2)}`;
  }
}

function normalizeLookupText(value = '') {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function buildExactNameRegex(value = '') {
  const escaped = escapeRegex(String(value || '').trim()).replace(/\s+/g, '\\s+');
  return new RegExp(`^${escaped}$`, 'i');
}

function buildClientSnapshot(client) {
  return {
    clientRef: client._id,
    name: client.name,
    address: {
      line1: client.billingAddress?.line1 || '',
      line2: client.billingAddress?.line2 || '',
      city: client.billingAddress?.city || '',
      state: client.billingAddress?.state || '',
      zip: client.billingAddress?.zip || '',
      country: client.billingAddress?.country || 'India',
    },
    gstin: client.gstin || '',
    phone: client.phone || '',
    email: client.email || '',
  };
}

async function resolveClientForInvoice({
  userId,
  clientRef,
  clientName,
  clientGST,
  placeOfSupply,
  importSource,
}) {
  if (clientRef && mongoose.Types.ObjectId.isValid(clientRef)) {
    const client = await Client.findOne({ _id: clientRef, user: userId });
    if (!client) throw new Error('Client not found');
    return client;
  }

  if (importSource !== PDF_IMPORT_SOURCE) {
    throw new Error('Client not found');
  }

  const normalizedClientName = normalizeLookupText(clientName);
  if (!normalizedClientName) {
    throw new Error('Client not found');
  }

  const existingClient = await Client.findOne({
    user: userId,
    name: { $regex: buildExactNameRegex(clientName) },
  });

  if (existingClient) {
    return existingClient;
  }

  const normalizedPlaceOfSupply = String(placeOfSupply || '').trim();
  const normalizedClientGST = String(clientGST || '').trim().toUpperCase();

  const client = new Client({
    user: userId,
    name: String(clientName).trim(),
    gstin: normalizedClientGST || undefined,
    gstTreatment: normalizedClientGST ? 'Registered Business' : 'Unregistered Business',
    placeOfSupply: normalizedPlaceOfSupply || 'Delhi',
    billingAddress: {
      state: normalizedPlaceOfSupply || '',
      country: 'India',
    },
    isClient: true,
  });

  return client.save();
}

async function resolvePdfImportItems(userId, items = []) {
  const resolvedItems = [];

  for (const rawItem of items) {
    const item = { ...rawItem };

    if (item.itemRef && mongoose.Types.ObjectId.isValid(item.itemRef)) {
      const existingItem = await Item.findById(item.itemRef).lean();
      if (existingItem && existingItem.user.toString() === userId.toString()) {
        resolvedItems.push(item);
        continue;
      }
    }

    const normalizedItemName = normalizeLookupText(item.name);
    if (!normalizedItemName) {
      resolvedItems.push(item);
      continue;
    }

    let catalogItem = await Item.findOne({
      user: userId,
      name: { $regex: buildExactNameRegex(item.name) },
    });

    if (!catalogItem) {
      const unit = String(item.unit || '').trim() || 'pcs';
      const rate = Number(item.rate) || 0;
      const taxRate = Number(item.taxRate) || 0;

      catalogItem = await Item.create({
        user: userId,
        name: String(item.name).trim(),
        description: item.description || '',
        hsnCode: item.hsnCode || '',
        unit,
        rate,
        sellingPrice: rate,
        purchasePrice: rate,
        taxRate,
        defaultTaxRate: taxRate,
        salesInfo: {
          price: rate,
          currency: 'INR',
          cessPercent: 0,
          cessAmount: 0,
        },
        purchaseInfo: {
          price: rate,
          currency: 'INR',
          cessPercent: 0,
          cessAmount: 0,
        },
      });
    }

    resolvedItems.push({
      ...item,
      itemRef: catalogItem._id,
    });
  }

  return resolvedItems;
}



// ─── Shared: process items based on invoice type ──────────────────────────────
function processItems(items, invoiceType, isIntraState) {
  return processDocumentItems(items, { invoiceType, isIntraState, includeExcise: true });
}

function buildExciseDutySnapshot(exciseDuty = {}, totalExcise = 0) {
  return {
    ...(exciseDuty || {}),
    totalExcise: Number(totalExcise) || 0,
  };
}

function roundToTwo(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function hasImportValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function parseImportedStatus(status, balanceDue) {
  const text = String(status || '').trim().toUpperCase();

  if (['PAID', 'PAYMENT RECEIVED'].includes(text)) return 'PAID';
  if (['PARTIAL', 'PARTIALLY PAID'].includes(text)) return 'PARTIAL';
  if (['SENT'].includes(text)) return 'SENT';
  if (['DRAFT'].includes(text)) return 'DRAFT';
  if (['CANCELLED', 'CANCELED', 'VOID'].includes(text)) return 'CANCELLED';
  if (['UNPAID', 'OVERDUE', 'PENDING'].includes(text)) return 'UNPAID';

  return Number(balanceDue) > 0 ? 'UNPAID' : 'PAID';
}

function deriveImportedTaxBreakdown(taxTotal, invoiceType, isIntraState) {
  const normalizedTaxTotal = roundToTwo(taxTotal);
  if (normalizedTaxTotal <= 0) {
    return { totalCGST: 0, totalSGST: 0, totalIGST: 0 };
  }

  if (invoiceType === 'Tax Invoice' || invoiceType === 'Excise Invoice') {
    if (isIntraState) {
      const half = roundToTwo(normalizedTaxTotal / 2);
      return {
        totalCGST: half,
        totalSGST: roundToTwo(normalizedTaxTotal - half),
        totalIGST: 0,
      };
    }

    return {
      totalCGST: 0,
      totalSGST: 0,
      totalIGST: normalizedTaxTotal,
    };
  }

  return {
    totalCGST: 0,
    totalSGST: 0,
    totalIGST: 0,
  };
}

// ─── GET all invoices ─────────────────────────────────────────────────────────
exports.getInvoices = async (req, res) => {
  try {
    const companyId = req.companyId || req.user?._id;
    if (!companyId) {
      return res.status(401).json({ message: 'Not authorized' });
    }

    const exportAll = req.query.all === 'true';
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const search = req.query.search || '';
    const status = req.query.status || '';
    const invoiceType = req.query.invoiceType || '';
    const startDate = req.query.startDate || '';
    const endDate = req.query.endDate || '';
    const dateType = req.query.dateType || 'date'; // 'date' or 'dueDate'
    const sortBy = req.query.sortBy || 'createdAt';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
    const skip = (page - 1) * limit;

    let query = { user: companyId };

    if (search) {
      const safeSearch = escapeRegex(search);
      // Find clients that match the search term
      const Client = require('../models/Client'); // Lazy load if needed
      const matchedClients = await Client.find({
        user: companyId,
        name: { $regex: safeSearch, $options: 'i' }
      }).select('_id').lean();

      const clientIds = matchedClients.map(c => c._id);

      // Search either by invoice number OR matching clients
      query.$or = [
        { invoiceNo: { $regex: safeSearch, $options: 'i' } },
        { 'client.clientRef': { $in: clientIds } }
      ];
    }

    // Status Filter
    if (status) {
      query.status = status;
    }

    // Invoice Type Filter
    if (invoiceType) {
      query.invoiceType = invoiceType;
    }

    // Business Unit Filter
    if (req.query.businessUnit && mongoose.Types.ObjectId.isValid(req.query.businessUnit)) {
      query.businessUnit = req.query.businessUnit;
    }

    // Date Range Filter
    if (startDate || endDate) {
      const dateField = dateType === 'dueDate' ? 'dueDate' : 'date';
      query[dateField] = {};
      if (startDate) {
        const start = new Date(startDate);
        if (!isNaN(start.getTime())) {
          query[dateField].$gte = start;
        }
      }
      if (endDate) {
        const end = new Date(endDate);
        if (!isNaN(end.getTime())) {
          end.setHours(23, 59, 59, 999);
          query[dateField].$lte = end;
        }
      }
    }

    const total = await Invoice.countDocuments(query);

    // Sorting structure
    let sortObj = {};
    if (sortBy === 'clientName') {
      sortObj['client.name'] = sortOrder;
    } else {
      sortObj[sortBy] = sortOrder;
    }
    // Stabilize sorting
    if (sortBy !== 'createdAt') {
      sortObj['createdAt'] = -1;
    }

    const invoicesQuery = Invoice.find(query)
      .populate('user', 'username')
      .select('-items -terms -shippingAddress -attachments.buffer')
      .lean()
      .sort(sortObj);

    if (!exportAll) {
      invoicesQuery.skip(skip).limit(limit);
    }

    const invoices = await invoicesQuery;

    res.json({
      data: invoices,
      total,
      page: exportAll ? 1 : page,
      limit: exportAll ? total : limit,
      totalPages: exportAll ? 1 : Math.ceil(total / limit)
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── GET single invoice ───────────────────────────────────────────────────────
exports.getInvoiceById = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Invoice not found' });
    }
    const invoice = await Invoice.findOne({ _id: req.params.id, user: companyId }).select('-attachments.buffer');
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── CREATE invoice ───────────────────────────────────────────────────────────
exports.createInvoice = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const {
      clientRef,
      clientName,
      clientGST,
      importSource,
      invoiceType = 'Tax Invoice',
      items,
      date,
      dueDate,
      shippingAddress,
      transport,
      bankDetails,
      placeOfSupply,
      paymentMode,
      paymentTerms,
      shippingCharges,
      packagingCharges,
      customChargeLabel,
      discountTotal,
      advancePaid,
      status,
      notes,
      terms,
      reverseCharge,
      exciseDuty,
      fy,
      currency,
      tds,
      tdsApplicable,
      tdsSection,
      tdsRate,
      tcs,
      drCr,
      purchaseOrderRef,
    } = req.body;
    const resolvedImportSource = importSource || (req.body._fromPdfImport ? PDF_IMPORT_SOURCE : '');

    // --- Subscription Plan Check ---
    const userObj = await User.findById(companyId);
    const isPro = userObj?.subscription?.plan === 'pro' && userObj?.subscription?.status === 'active';
    if (!isPro) {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const invoiceCount = await Invoice.countDocuments({
        user: companyId,
        createdAt: { $gte: startOfMonth }
      });
      if (invoiceCount >= 15) {
        return res.status(403).json({ message: 'Free plan limit reached. You can only create 15 Invoices per month. Please upgrade to Pro.' });
      }
    }
    // -------------------------------
    const userSettings = await Settings.findOne({ user: companyId });
    const invoicePrefix = userSettings?.invoicePrefix || 'INV';
    let invoiceNo = req.body.invoiceNo;
    const isAuto = !invoiceNo || invoiceNo === 'Auto-generated';

    if (!isAuto) {
      // Validate Custom Invoice Number Uniqueness for this user
      const existing = await Invoice.findOne({ user: companyId, invoiceNo });
      if (existing) {
        return res.status(400).json({ message: `Invoice number "${invoiceNo}" already exists.` });
      }
    } else {
      // Generate Invoice Number
      invoiceNo = await generateNextUniqueInvoiceNumber({
        userId: companyId,
        invoicePrefix,
      });
    }

    const client = await resolveClientForInvoice({
      userId: companyId,
      clientRef,
      clientName,
      clientGST,
      placeOfSupply,
      importSource: resolvedImportSource,
    });
    const clientSnapshot = buildClientSnapshot(client);

    // GST intra/inter state logic
    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';
    const COMPANY_GSTIN = userSettings?.gstin || process.env.COMPANY_GSTIN || '';
    const clientState = placeOfSupply || client.placeOfSupply || client.billingAddress?.state || '';
    // Normalize: extract state name before parenthesis e.g. "HR (06)" → "HR", "Haryana (06)" → "Haryana"
    const normalizeState = (s) => s.trim().split('(')[0].trim().toLowerCase();
    const isIntraState = !isInterStateSupply(clientState, COMPANY_STATE, COMPANY_GSTIN);

    // Auto-use client's shipping address if not overridden in form
    const resolvedShippingAddress = (shippingAddress?.line1)
      ? shippingAddress
      : (client.shippingAddress?.line1 ? {
          line1: client.shippingAddress.line1,
          line2: client.shippingAddress.line2 || '',
          city: client.shippingAddress.city || '',
          state: client.shippingAddress.state || '',
          zip: client.shippingAddress.zip || '',
          country: client.shippingAddress.country || 'India',
        } : null);

    const resolvedItems = resolvedImportSource === PDF_IMPORT_SOURCE
      ? await resolvePdfImportItems(companyId, items || [])
      : (items || []);

    const documentInvoiceType = ['Invoice', 'Retail Invoice', 'Tax Invoice', 'Excise Invoice'].includes(invoiceType)
      ? invoiceType
      : 'Tax Invoice';

    // Process items
    const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST, totalExcise } =
      processItems(resolvedItems, documentInvoiceType, isIntraState);

    const autoInvoiceType = determineInvoiceType({ items: processedItems, placeOfSupply: clientState, client });
    const storedGstInvoiceType = req.body.overrideInvoiceType && ['B2B', 'B2C', 'Export', 'NilRated'].includes(invoiceType)
      ? invoiceType
      : autoInvoiceType;

    const finalShipping = Number(shippingCharges) || 0;
    const finalPackaging = Number(packagingCharges) || 0;
    const finalDiscountTotal = Number(discountTotal) || 0;
    const grandTotal = subTotal + (reverseCharge ? 0 : taxTotal) + totalExcise + finalShipping + finalPackaging - finalDiscountTotal + (Number(tcs) || 0);
    const finalTcs = Number(tcs) || 0;

    // TDS is calculated on taxable/base amount only, excluding GST.
    const clientTdsApplies = storedGstInvoiceType === 'B2B' && client.tds_applicable === true;
    const activeTdsApplicable = req.body.tds_applicable !== undefined ? !!req.body.tds_applicable : (tdsApplicable !== undefined ? !!tdsApplicable : clientTdsApplies);
    const requestedTdsSection = req.body.tds_section || tdsSection || client.tds_default_section || client.default_tds_section || '194J';
    const requestedTdsRate = req.body.tds_rate !== undefined ? req.body.tds_rate : (tdsRate !== undefined ? tdsRate : (client.tds_default_rate || client.default_tds_rate || 10));
    const tdsCalc = activeTdsApplicable
      ? calculateTds({ baseAmount: subTotal, section: requestedTdsSection, rate: requestedTdsRate })
      : calculateTds({ baseAmount: 0, section: requestedTdsSection, rate: 0 });
    const activeTdsSection = activeTdsApplicable ? tdsCalc.section : '';
    const activeTdsRate = activeTdsApplicable ? tdsCalc.rate : 0;
    const activeTdsSectionLabel = req.body.tds_section_label || TDS_SECTION_LABELS[activeTdsSection] || tdsCalc.sectionLabel || '';
    const activeTdsBaseAmount = activeTdsApplicable ? tdsCalc.baseAmount : 0;
    const activeTdsAmount = activeTdsApplicable ? tdsCalc.amount : 0;
    const activeNetPayable = roundToTwo(subTotal + (reverseCharge ? 0 : taxTotal) - activeTdsAmount);

    const finalTds = activeTdsApplicable ? activeTdsAmount : (Number(tds) || 0);

    const activeClientWillDeductTds = req.body.client_will_deduct_tds !== undefined 
      ? !!req.body.client_will_deduct_tds 
      : activeTdsApplicable;
    const activeTdsReceivableAmount = activeClientWillDeductTds 
      ? tdsCalc.receivable
      : 0;
    const activeExpectedReceipt = roundToTwo(grandTotal - activeTdsReceivableAmount);

    let linkedPo = null;
    if (purchaseOrderRef && mongoose.Types.ObjectId.isValid(purchaseOrderRef)) {
      linkedPo = await PurchaseOrder.findOne({ _id: purchaseOrderRef, user: companyId });
      if (!linkedPo) {
        return res.status(404).json({ message: 'Linked Purchase Order not found' });
      }
    }

    let finalStatus = status || 'DRAFT';
    let finalAdvance = Number(advancePaid) || 0;
    if (finalStatus === 'PAID') {
      finalAdvance = grandTotal - finalTds;
    }
    let finalBalance = Math.max(0, grandTotal - finalAdvance - finalTds);
    if (finalBalance === 0 && finalStatus !== 'DRAFT' && finalStatus !== 'CANCELLED') {
      finalStatus = 'PAID';
    } else if (finalBalance > 0 && finalAdvance > 0 && finalStatus !== 'CANCELLED') {
      finalStatus = 'PARTIAL';
    }

    let newInvoice = null;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const invoice = new Invoice({
        user: companyId,
        invoiceNo,
        invoiceType: documentInvoiceType,
        gstInvoiceType: storedGstInvoiceType,
        overrideInvoiceType: !!req.body.overrideInvoiceType,
        date,
        dueDate,
        paymentMode,
        paymentTerms,
        client: clientSnapshot,
        items: processedItems,
        subTotal,
        taxTotal,
        totalCGST,
        totalSGST,
        totalIGST,
        shippingCharges: finalShipping,
        packagingCharges: finalPackaging,
        customChargeLabel: customChargeLabel || 'Custom Amount',
        discountTotal: finalDiscountTotal,
        grandTotal,
        advancePaid: finalAdvance,
        balanceDue: finalBalance,
        paymentDate: req.body.paymentDate ? new Date(req.body.paymentDate) : (finalAdvance > 0 ? (date || new Date()) : null),
        status: finalStatus,
        shippingAddress: resolvedShippingAddress,
        transport,
        bankDetails,
        placeOfSupply: clientState,
        reverseCharge: !!reverseCharge,
        fy: fy || getFinancialYear(date),
        currency: currency || 'INR',
        tds: finalTds,
        tdsApplicable: activeTdsApplicable,
        tdsSection: activeTdsSection,
        tdsRate: activeTdsRate,
        tdsAmount: activeTdsAmount,
        tdsReceivable: activeTdsReceivableAmount,
        tds_applicable: activeTdsApplicable,
        tds_section: activeTdsSection,
        tds_section_label: activeTdsSectionLabel,
        tds_rate: activeTdsRate,
        tds_base_amount: activeTdsBaseAmount,
        tds_amount: activeTdsAmount,
        net_payable: activeNetPayable,
        client_will_deduct_tds: activeClientWillDeductTds,
        tds_receivable_amount: activeTdsReceivableAmount,
        expected_receipt: activeExpectedReceipt,
        tcs: finalTcs,
        drCr: drCr || 'Dr.',
        notes,
        terms,
        exciseDuty: buildExciseDutySnapshot(exciseDuty, totalExcise),
        purchaseOrderRef: linkedPo ? linkedPo._id : undefined,
        attachments: processIncomingAttachments(req.body.attachments, []),
      });

      try {
        newInvoice = await invoice.save();
        break;
      } catch (error) {
        if (!isInvoiceNumberDuplicateError(error)) {
          throw error;
        }
        if (!isAuto) {
          return res.status(400).json({ message: `Invoice number "${invoiceNo}" already exists.` });
        }
        invoiceNo = await generateNextUniqueInvoiceNumber({
          userId: req.user._id,
          invoicePrefix,
        });
      }
    }

    if (linkedPo) {
      try {
        linkedPo.billedAmount = roundToTwo((linkedPo.billedAmount || 0) + grandTotal);
        if (linkedPo.billedAmount >= linkedPo.grandTotal) {
          linkedPo.status = 'BILLED';
        } else {
          linkedPo.status = 'PARTIAL';
        }
        await linkedPo.save();
      } catch (error) {
        if (newInvoice) {
          await Invoice.updateOne({ _id: newInvoice._id }, { $set: { isDeleted: true, deletedAt: new Date() } });
        }
        throw error;
      }
    }

    await syncIncomeFromInvoice(newInvoice);
    await syncInvoiceCashMovement(newInvoice, newInvoice.date);
    res.status(201).json(newInvoice);

  } catch (error) {
    console.error('createInvoice error:', error);
    res.status(400).json({ message: error.message });
  }
};

// ─── UPDATE invoice ───────────────────────────────────────────────────────────
exports.updateInvoice = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const {
      clientRef,
      invoiceType,
      items,
      date,
      dueDate,
      shippingAddress,
      transport,
      bankDetails,
      placeOfSupply,
      paymentMode,
      paymentTerms,
      shippingCharges,
      packagingCharges,
      customChargeLabel,
      discountTotal,
      advancePaid,
      status,
      notes,
      terms,
      reverseCharge,
      exciseDuty,
      fy,
      currency,
      tds,
      tdsApplicable,
      tdsSection,
      tdsRate,
      tcs,
      drCr,
      purchaseOrderRef,
    } = req.body;

    const invoice = await Invoice.findOne({ _id: req.params.id, user: companyId });
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

    const oldPoId = invoice.purchaseOrderRef;
    const oldGrandTotal = invoice.grandTotal || 0;
    const oldStatus = invoice.status || 'DRAFT';
    const oldIsActive = ACTIVE_INVOICE_STATUSES.includes(oldStatus);

    // --- Subscription Plan Check for Edits ---
    const userObj = await User.findById(companyId);
    const isPro = userObj?.subscription?.plan === 'pro' && userObj?.subscription?.status === 'active';
    if (!isPro) {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const conditions = {
        user: companyId,
        updatedAt: { $gte: startOfMonth },
        $expr: { $gt: ["$updatedAt", "$createdAt"] } 
      };
      
      const editedInvoicesCount = await Invoice.countDocuments(conditions);

      let otherEditsCount = 0;
      try {
        const QuoteModel = require('../models/Quote');
        const ProformaModel = require('../models/Proforma');
        const POModel = require('../models/PurchaseOrder');
        const [qt, prf, po] = await Promise.all([
          QuoteModel.countDocuments(conditions),
          ProformaModel.countDocuments(conditions),
          POModel.countDocuments(conditions)
        ]);
        otherEditsCount = qt + prf + po;
      } catch (e) {
         // ignore if model not loaded yet
      }
      
      const totalEditsThisMonth = editedInvoicesCount + otherEditsCount;

      const isAlreadyEditedThisMonth = invoice.updatedAt && invoice.updatedAt >= startOfMonth && invoice.updatedAt > invoice.createdAt;

      if (totalEditsThisMonth >= 5 && !isAlreadyEditedThisMonth) {
        return res.status(403).json({ message: 'You have reached the free plan limit of 5 document edits per month. Please upgrade to Pro.' });
      }
    }
    // -----------------------------------------

    // Fetch Client Snapshot
    const client = await Client.findOne({ _id: clientRef, user: companyId });
    if (!client) return res.status(404).json({ message: 'Client not found' });

    const clientSnapshot = {
      clientRef: client._id,
      name: client.name,
      address: {
        line1: client.billingAddress?.line1 || '',
        line2: client.billingAddress?.line2 || '',
        city: client.billingAddress?.city || '',
        state: client.billingAddress?.state || '',
        zip: client.billingAddress?.zip || '',
        country: client.billingAddress?.country || 'India',
      },
      gstin: client.gstin || '',
      phone: client.phone || '',
      email: client.email || '',
    };

    const userSettings = await Settings.findOne({ user: companyId });
    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';
    const COMPANY_GSTIN = userSettings?.gstin || process.env.COMPANY_GSTIN || '';
    const clientState = placeOfSupply || client.placeOfSupply || client.billingAddress?.state || '';
    // Normalize: extract state name before parenthesis e.g. "HR (06)" → "HR", "Haryana (06)" → "Haryana"
    const normalizeState = (s) => s.trim().split('(')[0].trim().toLowerCase();
    const isIntraState = !isInterStateSupply(clientState, COMPANY_STATE, COMPANY_GSTIN);

    const resolvedShippingAddress = (shippingAddress?.line1)
      ? shippingAddress
      : (client.shippingAddress?.line1 ? {
          line1: client.shippingAddress.line1,
          line2: client.shippingAddress.line2 || '',
          city: client.shippingAddress.city || '',
          state: client.shippingAddress.state || '',
          zip: client.shippingAddress.zip || '',
          country: client.shippingAddress.country || 'India',
        } : null);

    const effectiveType = invoiceType || invoice.invoiceType || 'Tax Invoice';
    const documentInvoiceType = ['Invoice', 'Retail Invoice', 'Tax Invoice', 'Excise Invoice'].includes(effectiveType)
      ? effectiveType
      : 'Tax Invoice';

    const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST, totalExcise } =
      processItems(items || [], documentInvoiceType, isIntraState);

    const autoInvoiceType = determineInvoiceType({ items: processedItems, placeOfSupply: clientState, client });
    const storedGstInvoiceType = req.body.overrideInvoiceType && ['B2B', 'B2C', 'Export', 'NilRated'].includes(effectiveType)
      ? effectiveType
      : autoInvoiceType;

    const finalShipping = Number(shippingCharges) || 0;
    const finalPackaging = Number(packagingCharges) || 0;
    const finalDiscountTotal = Number(discountTotal) || 0;
    const grandTotal = subTotal + (reverseCharge ? 0 : taxTotal) + totalExcise + finalShipping + finalPackaging - finalDiscountTotal + (Number(tcs) || 0);
    const finalTcs = Number(tcs) || 0;

    // TDS is calculated on taxable/base amount only, excluding GST.
    const clientTdsApplies = storedGstInvoiceType === 'B2B' && client.tds_applicable === true;
    const activeTdsApplicable = req.body.tds_applicable !== undefined ? !!req.body.tds_applicable : (tdsApplicable !== undefined ? !!tdsApplicable : clientTdsApplies);
    const requestedTdsSection = req.body.tds_section || tdsSection || client.tds_default_section || client.default_tds_section || '194J';
    const requestedTdsRate = req.body.tds_rate !== undefined ? req.body.tds_rate : (tdsRate !== undefined ? tdsRate : (client.tds_default_rate || client.default_tds_rate || 10));
    const tdsCalc = activeTdsApplicable
      ? calculateTds({ baseAmount: subTotal, section: requestedTdsSection, rate: requestedTdsRate })
      : calculateTds({ baseAmount: 0, section: requestedTdsSection, rate: 0 });
    const activeTdsSection = activeTdsApplicable ? tdsCalc.section : '';
    const activeTdsRate = activeTdsApplicable ? tdsCalc.rate : 0;
    const activeTdsSectionLabel = req.body.tds_section_label || TDS_SECTION_LABELS[activeTdsSection] || tdsCalc.sectionLabel || '';
    const activeTdsBaseAmount = activeTdsApplicable ? tdsCalc.baseAmount : 0;
    const activeTdsAmount = activeTdsApplicable ? tdsCalc.amount : 0;
    const activeNetPayable = roundToTwo(subTotal + (reverseCharge ? 0 : taxTotal) - activeTdsAmount);

    const finalTds = activeTdsApplicable ? activeTdsAmount : (Number(tds) || 0);

    const activeClientWillDeductTds = req.body.client_will_deduct_tds !== undefined 
      ? !!req.body.client_will_deduct_tds 
      : activeTdsApplicable;
    const activeTdsReceivableAmount = activeClientWillDeductTds 
      ? tdsCalc.receivable
      : 0;
    const activeExpectedReceipt = roundToTwo(grandTotal - activeTdsReceivableAmount);

    let finalStatus = status || invoice.status || 'DRAFT';
    let finalAdvance = Number(advancePaid) || 0;
    if (finalStatus === 'PAID') {
      finalAdvance = grandTotal - finalTds;
    }
    let finalBalance = Math.max(0, grandTotal - finalAdvance - finalTds);
    if (finalBalance === 0 && finalStatus !== 'DRAFT' && finalStatus !== 'CANCELLED') {
      finalStatus = 'PAID';
    } else if (finalBalance > 0 && finalAdvance > 0 && finalStatus !== 'CANCELLED') {
      finalStatus = 'PARTIAL';
    }

    // Apply updates
    invoice.invoiceType = documentInvoiceType;
    invoice.gstInvoiceType = storedGstInvoiceType;
    invoice.overrideInvoiceType = !!req.body.overrideInvoiceType;
    // Allow updating invoiceNo only if a custom value was provided and it differs
    if (req.body.invoiceNo && req.body.invoiceNo !== 'Auto-generated' && req.body.invoiceNo !== invoice.invoiceNo) {
      const duplicate = await Invoice.findOne({ user: companyId, invoiceNo: req.body.invoiceNo, _id: { $ne: invoice._id } });
      if (duplicate) return res.status(400).json({ message: `Invoice number "${req.body.invoiceNo}" already exists.` });
      invoice.invoiceNo = req.body.invoiceNo;
    }
    invoice.client = clientSnapshot;
    invoice.items = processedItems;
    invoice.date = date;
    invoice.dueDate = dueDate;
    invoice.paymentMode = paymentMode;
    invoice.paymentTerms = paymentTerms;
    invoice.subTotal = subTotal;
    invoice.taxTotal = taxTotal;
    invoice.totalCGST = totalCGST;
    invoice.totalSGST = totalSGST;
    invoice.totalIGST = totalIGST;
    invoice.shippingCharges = finalShipping;
    invoice.packagingCharges = finalPackaging;
    invoice.customChargeLabel = customChargeLabel || 'Custom Amount';
    invoice.discountTotal = finalDiscountTotal;
    invoice.grandTotal = grandTotal;
    invoice.advancePaid = finalAdvance;
    invoice.balanceDue = finalBalance;
    if (req.body.paymentDate !== undefined) {
      invoice.paymentDate = req.body.paymentDate ? new Date(req.body.paymentDate) : null;
    } else if (finalAdvance > 0 && !invoice.paymentDate) {
      invoice.paymentDate = date || new Date();
    }
    invoice.shippingAddress = resolvedShippingAddress;
    invoice.transport = transport;
    invoice.bankDetails = bankDetails;
    invoice.placeOfSupply = clientState;
    invoice.reverseCharge = !!reverseCharge;
    invoice.fy = fy || getFinancialYear(date);
    invoice.currency = currency || 'INR';
    invoice.tds = finalTds;
    invoice.tdsApplicable = activeTdsApplicable;
    invoice.tdsSection = activeTdsSection;
    invoice.tdsRate = activeTdsRate;
    invoice.tdsAmount = activeTdsAmount;
    invoice.tdsReceivable = activeTdsReceivableAmount;
    invoice.tds_applicable = activeTdsApplicable;
    invoice.tds_section = activeTdsSection;
    invoice.tds_section_label = activeTdsSectionLabel;
    invoice.tds_rate = activeTdsRate;
    invoice.tds_base_amount = activeTdsBaseAmount;
    invoice.tds_amount = activeTdsAmount;
    invoice.net_payable = activeNetPayable;
    invoice.client_will_deduct_tds = activeClientWillDeductTds;
    invoice.tds_receivable_amount = activeTdsReceivableAmount;
    invoice.expected_receipt = activeExpectedReceipt;
    invoice.tcs = finalTcs;
    invoice.drCr = drCr || 'Dr.';
    invoice.notes = notes;
    invoice.terms = terms;
    invoice.exciseDuty = buildExciseDutySnapshot(exciseDuty || invoice.exciseDuty, totalExcise);
    invoice.status = finalStatus;

    if (req.body.attachments !== undefined) {
      invoice.attachments = processIncomingAttachments(req.body.attachments, invoice.attachments);
    }

    const newPoId = purchaseOrderRef;
    const newIsActive = ACTIVE_INVOICE_STATUSES.includes(finalStatus);

    if (String(oldPoId || '') === String(newPoId || '')) {
      // Linked PO remains the same
      if (oldPoId && mongoose.Types.ObjectId.isValid(oldPoId)) {
        const linkedPo = await PurchaseOrder.findOne({ _id: oldPoId, user: companyId });
        if (linkedPo) {
          let updated = false;
          if (oldIsActive && newIsActive) {
            // Amount changed
            if (oldGrandTotal !== grandTotal) {
              linkedPo.billedAmount = Math.max(0, roundToTwo((linkedPo.billedAmount || 0) - oldGrandTotal + grandTotal));
              updated = true;
            }
          } else if (oldIsActive && !newIsActive) {
            // Reverted from active to draft/cancelled
            linkedPo.billedAmount = Math.max(0, roundToTwo((linkedPo.billedAmount || 0) - oldGrandTotal));
            updated = true;
          } else if (!oldIsActive && newIsActive) {
            // Activated from draft/cancelled
            linkedPo.billedAmount = roundToTwo((linkedPo.billedAmount || 0) + grandTotal);
            updated = true;
          }

          if (updated) {
            if (linkedPo.billedAmount >= linkedPo.grandTotal) {
              linkedPo.status = 'BILLED';
            } else if (linkedPo.billedAmount > 0) {
              linkedPo.status = 'PARTIAL';
            } else {
              linkedPo.status = 'RECEIVED';
            }
            await linkedPo.save();
          }
        }
      }
    } else {
      // Linked PO has changed
      // 1. Revert Old PO if it was active
      if (oldPoId && mongoose.Types.ObjectId.isValid(oldPoId) && oldIsActive) {
        const oldPo = await PurchaseOrder.findOne({ _id: oldPoId, user: companyId });
        if (oldPo) {
          oldPo.billedAmount = Math.max(0, roundToTwo((oldPo.billedAmount || 0) - oldGrandTotal));
          if (oldPo.billedAmount >= oldPo.grandTotal) {
            oldPo.status = 'BILLED';
          } else if (oldPo.billedAmount > 0) {
            oldPo.status = 'PARTIAL';
          } else {
            oldPo.status = 'RECEIVED';
          }
          await oldPo.save();
        }
      }

      // 2. Apply to New PO if new invoice is active
      if (newPoId && mongoose.Types.ObjectId.isValid(newPoId) && newIsActive) {
        const newPo = await PurchaseOrder.findOne({ _id: newPoId, user: companyId });
        if (!newPo) {
          return res.status(404).json({ message: 'New Purchase Order not found' });
        }
        
        newPo.billedAmount = roundToTwo((newPo.billedAmount || 0) + grandTotal);
        if (newPo.billedAmount >= newPo.grandTotal) {
          newPo.status = 'BILLED';
        } else {
          newPo.status = 'PARTIAL';
        }
        await newPo.save();
      }
    }

    invoice.purchaseOrderRef = purchaseOrderRef || undefined;

    const updatedInvoice = await invoice.save();
    await syncIncomeFromInvoice(updatedInvoice);
    await syncInvoiceCashMovement(updatedInvoice, updatedInvoice.date);
    res.json(updatedInvoice);

  } catch (error) {
    console.error('updateInvoice error:', error);
    res.status(400).json({ message: error.message });
  }
};

// ─── DELETE invoice ───────────────────────────────────────────────────────────
exports.deleteInvoice = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const invoice = await Invoice.findOne({ _id: req.params.id, user: companyId });
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

    // --- Subscription Plan Check for Deletes ---
    const userObj = await User.findById(companyId);
    const isPro = userObj?.subscription?.plan === 'pro' && userObj?.subscription?.status === 'active';
    if (!isPro) {
       return res.status(403).json({ message: 'Free users cannot delete documents. Please upgrade to Pro.' });
    }
    // -------------------------------------------
    const oldPoId = invoice.purchaseOrderRef;
    const oldGrandTotal = invoice.grandTotal;
    const isOldActive = ACTIVE_INVOICE_STATUSES.includes(invoice.status || 'DRAFT');

    if (oldPoId && mongoose.Types.ObjectId.isValid(oldPoId) && isOldActive) {
      const oldPo = await PurchaseOrder.findOne({ _id: oldPoId, user: companyId });
      if (oldPo) {
        oldPo.billedAmount = Math.max(0, roundToTwo((oldPo.billedAmount || 0) - oldGrandTotal));
        if (oldPo.billedAmount >= oldPo.grandTotal) {
          oldPo.status = 'BILLED';
        } else if (oldPo.billedAmount > 0) {
          oldPo.status = 'PARTIAL';
        } else {
          oldPo.status = 'RECEIVED';
        }
        await oldPo.save();
      }
    }

    await Invoice.updateOne({ _id: invoice._id }, { $set: { isDeleted: true, deletedAt: new Date() } });
    await CashLedgerEntry.updateMany(
      { sourceModel: 'Invoice', sourceId: invoice._id, user: companyId },
      { $set: { isDeleted: true, deletedAt: new Date() } }
    );
    await removeIncomeForInvoice(invoice._id, invoice.user);
    res.json({ message: 'Invoice deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── UPDATE invoice status ───────────────────────────────────────────────────
exports.updateInvoiceStatus = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ message: 'Status is required' });
    }

    const invoice = await Invoice.findOne({ _id: req.params.id, user: companyId });
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

    const oldStatus = invoice.status || 'DRAFT';
    const oldIsActive = ACTIVE_INVOICE_STATUSES.includes(oldStatus);
    const grandTotal = invoice.grandTotal || 0;
    const finalTds = invoice.tds || 0;

    invoice.status = status;

    if (status === 'PAID') {
      invoice.advancePaid = grandTotal - finalTds;
      invoice.balanceDue = 0;
    } else if (status === 'UNPAID' || status === 'SENT') {
      invoice.advancePaid = 0;
      invoice.balanceDue = Math.max(0, grandTotal - finalTds);
    } else if (status === 'DRAFT' || status === 'CANCELLED') {
      invoice.balanceDue = Math.max(0, grandTotal - (invoice.advancePaid || 0) - finalTds);
    }

    const newIsActive = ACTIVE_INVOICE_STATUSES.includes(status);
    const oldPoId = invoice.purchaseOrderRef;
    if (oldPoId && mongoose.Types.ObjectId.isValid(oldPoId)) {
      const linkedPo = await PurchaseOrder.findOne({ _id: oldPoId, user: companyId });
      if (linkedPo) {
        let updated = false;
        if (oldIsActive && newIsActive) {
          // Both active
        } else if (oldIsActive && !newIsActive) {
          // Reverted from active to inactive
          linkedPo.billedAmount = Math.max(0, roundToTwo((linkedPo.billedAmount || 0) - grandTotal));
          updated = true;
        } else if (!oldIsActive && newIsActive) {
          // Activated from inactive to active
          linkedPo.billedAmount = roundToTwo((linkedPo.billedAmount || 0) + grandTotal);
          updated = true;
        }

        if (updated) {
          if (linkedPo.billedAmount >= linkedPo.grandTotal) {
            linkedPo.status = 'BILLED';
          } else if (linkedPo.billedAmount > 0) {
            linkedPo.status = 'PARTIAL';
          } else {
            linkedPo.status = 'RECEIVED';
          }
          await linkedPo.save();
        }
      }
    }

    const updatedInvoice = await invoice.save();
    await syncIncomeFromInvoice(updatedInvoice);
    await syncInvoiceCashMovement(updatedInvoice, updatedInvoice.date);
    res.json(updatedInvoice);
  } catch (error) {
    console.error('updateInvoiceStatus error:', error);
    res.status(500).json({ message: error.message });
  }
};


// ─── BULK create invoices ───────────────────────────────────────────────────
exports.bulkCreateInvoices = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const invoices = req.body.invoices;
    if (!Array.isArray(invoices) || invoices.length === 0) {
      return res.status(400).json({ message: 'No invoices provided for bulk creation.' });
    }

    // --- Subscription Plan Check ---
    const userObj = await User.findById(companyId);
    const isPro = userObj?.subscription?.plan === 'pro' && userObj?.subscription?.status === 'active';
    if (!isPro) {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const invoiceCount = await Invoice.countDocuments({
        user: companyId,
        createdAt: { $gte: startOfMonth }
      });
      if (invoiceCount + invoices.length > 15) {
        return res.status(403).json({ message: `Free plan limit reached. You can only create 15 Invoices per month. You currently have ${invoiceCount} and are trying to add ${invoices.length}.` });
      }
    }
    // -------------------------------

    const userSettings = await Settings.findOne({ user: companyId });
    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';
    const COMPANY_GSTIN = userSettings?.gstin || process.env.COMPANY_GSTIN || '';

    const createdInvoices = [];
    const skippedInvoices = [];
    const renumberedInvoices = [];
    const importedInvoices = [];
    const failedInvoices = [];
    for (const [index, invData] of invoices.entries()) {
      let rowInvoiceNo = String(invData?.invoiceNo || '').trim();
      let rowClientName = String(invData?.clientName || '').trim();
      const importRowId = invData?._importRowId || String(index);

      try {
      const clientName = rowClientName;
      if (!clientName) {
        throw new Error('Client name is required for each imported invoice.');
      }

      let client = await Client.findOne({
        user: companyId,
        name: { $regex: buildExactNameRegex(clientName) },
      });

      if (!client) {
        client = new Client({
          name: clientName || 'Unknown Client',
          email: invData.clientEmail || '',
          phone: invData.clientPhone || '',
          gstin: invData.clientGST || '',
          gstTreatment: invData.clientGST ? 'Registered Business' : 'Unregistered Business',
          billingAddress: {
            city: invData.clientCity || '',
            state: invData.clientState || '',
            country: 'India',
          },
          placeOfSupply: invData.placeOfSupply || invData.clientState || 'Delhi',
          user: companyId,
        });
        await client.save();
      } else {
        let shouldSaveClient = false;

        if (invData.clientEmail && !client.email) {
          client.email = invData.clientEmail;
          shouldSaveClient = true;
        }
        if (invData.clientPhone && !client.phone) {
          client.phone = invData.clientPhone;
          shouldSaveClient = true;
        }
        if (invData.clientGST && !client.gstin) {
          client.gstin = String(invData.clientGST).trim().toUpperCase();
          client.gstTreatment = 'Registered Business';
          shouldSaveClient = true;
        }
        if (invData.clientCity && !client.billingAddress?.city) {
          client.billingAddress = {
            ...(client.billingAddress || {}),
            city: invData.clientCity,
            country: client.billingAddress?.country || 'India',
          };
          shouldSaveClient = true;
        }
        if (invData.clientState && !client.billingAddress?.state) {
          client.billingAddress = {
            ...(client.billingAddress || {}),
            state: invData.clientState,
            country: client.billingAddress?.country || 'India',
          };
          shouldSaveClient = true;
        }
        if (invData.placeOfSupply && !client.placeOfSupply) {
          client.placeOfSupply = invData.placeOfSupply;
          shouldSaveClient = true;
        }

        if (shouldSaveClient) {
          await client.save();
        }
      }

      const clientState = invData.placeOfSupply || client.billingAddress?.state || '';
      const isIntraState = !isInterStateSupply(clientState, COMPANY_STATE, COMPANY_GSTIN);

      let invoiceNo = rowInvoiceNo;
      const originalInvoiceNo = invoiceNo;
      const isAuto = !invoiceNo || invoiceNo === 'Auto-generated';
      if (isAuto) {
        invoiceNo = await generateNextUniqueInvoiceNumber({
          userId: companyId,
          invoicePrefix: userSettings?.invoicePrefix || 'INV',
        });
      }

      let invoiceType = invData.invoiceType || 'Tax Invoice';
      if (!['Invoice', 'Retail Invoice', 'Tax Invoice', 'Excise Invoice'].includes(invoiceType)) {
        invoiceType = 'Tax Invoice';
      }

      const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST, totalExcise } =
        processItems(invData.items || [], invoiceType, isIntraState);

      const finalShipping = Number(invData.shippingCharges) || 0;
      const finalPackaging = Number(invData.packagingCharges) || 0;
      const finalDiscount = Number(invData.discountTotal) || 0;
      const finalTcs = Number(invData.tcs) || 0;
      const finalTds = Number(invData.tds) || 0;
      const computedGrandTotal = subTotal + (invData.reverseCharge ? 0 : taxTotal) + totalExcise + finalShipping + finalPackaging - finalDiscount + finalTcs;
      const importedSubTotal = hasImportValue(invData.importedSubTotal) ? roundToTwo(invData.importedSubTotal) : null;
      const importedTaxTotal = hasImportValue(invData.importedTaxTotal) ? roundToTwo(invData.importedTaxTotal) : null;
      const importedGrandTotal = hasImportValue(invData.importedGrandTotal) ? roundToTwo(invData.importedGrandTotal) : null;
      const importedBalanceDue = hasImportValue(invData.importedBalanceDue) ? roundToTwo(invData.importedBalanceDue) : null;
      const importedAdvancePaid = hasImportValue(invData.advancePaid) ? roundToTwo(invData.advancePaid) : null;

      const finalSubTotal = importedSubTotal !== null ? importedSubTotal : subTotal;
      const finalTaxTotal = importedTaxTotal !== null ? importedTaxTotal : taxTotal;
      const finalExciseTotal = totalExcise;
      const finalGrandTotal = importedGrandTotal !== null ? importedGrandTotal : roundToTwo(computedGrandTotal);
      const finalDate = parseImportedDate(invData.date);

      if (!isAuto) {
        const existingInvoice = await Invoice.findOne({ user: companyId, invoiceNo });
        if (existingInvoice && isSameImportedInvoice(existingInvoice, finalDate, finalGrandTotal)) {
          skippedInvoices.push({
            importRowId,
            invoiceNo,
            clientName,
            date: finalDate,
            grandTotal: finalGrandTotal,
            reason: 'same invoice number, date, and amount already exist',
          });
          continue;
        }

        if (existingInvoice) {
          invoiceNo = await generateNextUniqueInvoiceNumber({
            userId: companyId,
            invoicePrefix: 'INV',
          });
          renumberedInvoices.push({
            importRowId,
            originalInvoiceNo,
            invoiceNo,
            clientName,
            date: finalDate,
            grandTotal: finalGrandTotal,
            reason: 'same invoice number exists with different date or amount',
          });
        }
      }
      
      let tempAdvancePaid = importedAdvancePaid !== null ? importedAdvancePaid : 0;
      let tempBalanceDue = importedBalanceDue !== null
        ? importedBalanceDue
        : Math.max(0, roundToTwo(finalGrandTotal - tempAdvancePaid - finalTds));
      
      let finalStatus = parseImportedStatus(invData.status, tempBalanceDue);
      if (finalStatus === 'PAID') {
        tempAdvancePaid = finalGrandTotal - finalTds;
        tempBalanceDue = 0;
      } else if (tempBalanceDue === 0 && finalStatus !== 'DRAFT' && finalStatus !== 'CANCELLED') {
        finalStatus = 'PAID';
      } else if (tempBalanceDue > 0 && tempAdvancePaid > 0 && finalStatus !== 'CANCELLED') {
        finalStatus = 'PARTIAL';
      }

      const finalTaxBreakdown = importedTaxTotal !== null
        ? deriveImportedTaxBreakdown(finalTaxTotal, invoiceType, isIntraState)
        : { totalCGST, totalSGST, totalIGST };
        let savedInvoice = null;
        for (let attempt = 0; attempt < 25; attempt += 1) {
          const invoice = new Invoice({
            invoiceNo,
            invoiceType,
            date: finalDate,
            dueDate: parseImportedDate(invData.dueDate),
            paymentMode: invData.paymentMode || '',
            paymentTerms: invData.paymentTerms || '',
            shippingAddress: invData.shippingAddress,
            transport: invData.transport,
            bankDetails: invData.bankDetails,
            placeOfSupply: invData.placeOfSupply || clientState,
            reverseCharge: !!invData.reverseCharge,
            fy: invData.fy || getFinancialYear(parseImportedDate(invData.date)),
            currency: invData.currency || 'INR',
            tds: finalTds,
            tcs: Number(invData.tcs) || 0,
            drCr: invData.drCr || 'Dr.',
            customChargeLabel: invData.customChargeLabel || 'Custom Amount',
            clientRef: client._id,
            client: {
               clientRef: client._id,
               name: client.name,
               email: client.email,
               phone: client.phone,
               address: {
                 line1: client.billingAddress?.line1 || '',
                 line2: client.billingAddress?.line2 || '',
                 city: client.billingAddress?.city || '',
                 state: client.billingAddress?.state || '',
                 zip: client.billingAddress?.zip || '',
                 country: client.billingAddress?.country || 'India',
               },
               gstin: client.gstin || '',
            },
            items: processedItems,
            subTotal: finalSubTotal,
            taxTotal: finalTaxTotal,
            totalCGST: finalTaxBreakdown.totalCGST,
            totalSGST: finalTaxBreakdown.totalSGST,
            totalIGST: finalTaxBreakdown.totalIGST,
            shippingCharges: finalShipping, packagingCharges: finalPackaging,
            discountTotal: finalDiscount,
            grandTotal: finalGrandTotal,
            advancePaid: tempAdvancePaid,
            balanceDue: tempBalanceDue,
            paymentDate: invData.paymentDate ? parseImportedDate(invData.paymentDate) : undefined,
            status: finalStatus,
            notes: String(invData.notes || '').trim(),
            terms: invData.terms || '',
            exciseDuty: buildExciseDutySnapshot(invData.exciseDuty, finalExciseTotal),
            user: companyId
          });

          try {
            savedInvoice = await invoice.save();
            break;
          } catch (error) {
            if (!isInvoiceNumberDuplicateError(error)) {
              throw error;
            }
            const previousInvoiceNo = invoiceNo;
            invoiceNo = await generateNextUniqueInvoiceNumber({
              userId: companyId,
              invoicePrefix: 'INV',
            });
            renumberedInvoices.push({
              importRowId,
              originalInvoiceNo: originalInvoiceNo || previousInvoiceNo,
              invoiceNo,
              clientName,
              date: finalDate,
              grandTotal: finalGrandTotal,
              reason: 'invoice number was already used during import',
            });
          }
        }
      await syncIncomeFromInvoice(savedInvoice);
      await syncInvoiceCashMovement(savedInvoice, savedInvoice.date);
      createdInvoices.push(savedInvoice);
      importedInvoices.push({
        importRowId,
        invoiceNo: savedInvoice.invoiceNo,
        originalInvoiceNo: originalInvoiceNo || savedInvoice.invoiceNo,
        clientName: savedInvoice.client?.name || clientName,
        date: savedInvoice.date,
        grandTotal: savedInvoice.grandTotal,
        status: savedInvoice.status,
        renumbered: savedInvoice.invoiceNo !== originalInvoiceNo && !!originalInvoiceNo,
      });
      } catch (rowError) {
        failedInvoices.push({
          importRowId,
          row: index + 1,
          invoiceNo: rowInvoiceNo,
          clientName: rowClientName,
          reason: rowError.message || 'Failed to import invoice row',
        });
      }
    }

    const messageParts = [`Successfully imported ${createdInvoices.length} invoices.`];
    if (skippedInvoices.length) messageParts.push(`${skippedInvoices.length} duplicate invoices skipped.`);
    if (renumberedInvoices.length) messageParts.push(`${renumberedInvoices.length} invoices renumbered with INV prefix.`);
    if (failedInvoices.length) messageParts.push(`${failedInvoices.length} invoices failed.`);

    res.status(201).json({
      message: messageParts.join(' '),
      count: createdInvoices.length,
      imported: createdInvoices.length,
      updated: 0,
      skipped: skippedInvoices.length,
      renumbered: renumberedInvoices.length,
      failed: failedInvoices.length,
      importedInvoices,
      skippedInvoices,
      renumberedInvoices,
      failedInvoices,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── GET GST Report ───────────────────────────────────────────────────────────
exports.getGSTReport = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const { startDate, endDate } = req.query;
    const parsedDateRange = parseOptionalDateRange(req.query);
    
    // Filter by user
    const matchStage = {
      user: companyId,
      status: { $in: ACTIVE_INVOICE_STATUSES },
    };

    // Apply date filters if provided
    if (startDate || endDate) {
      matchStage.date = {};
      if (parsedDateRange.startDate) matchStage.date.$gte = parsedDateRange.startDate;
      if (parsedDateRange.endDate) matchStage.date.$lte = parsedDateRange.endDate;
    }

    const report = await Invoice.aggregate([
      { $match: matchStage },
      { $sort: { date: -1, createdAt: -1 } },
      { 
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                totalTaxableAmount: { $sum: "$subTotal" },
                totalCGST: { $sum: "$totalCGST" },
                totalSGST: { $sum: "$totalSGST" },
                totalIGST: { $sum: "$totalIGST" },
                totalTax: { $sum: "$taxTotal" },
                totalGrandTotal: { $sum: "$grandTotal" }
              }
            }
          ],
          details: [
            {
              $project: {
                invoiceNo: 1,
                date: 1,
                clientName: "$client.name",
                clientState: "$client.address.state",
                taxableAmount: "$subTotal",
                cgst: "$totalCGST",
                sgst: "$totalSGST",
                igst: "$totalIGST",
                totalTax: "$taxTotal",
                grandTotal: 1,
                status: 1
              }
            }
          ]
        }
      }
    ]);

    const result = report[0];
    const totals = result.totals.length > 0 ? result.totals[0] : {
      totalTaxableAmount: 0,
      totalCGST: 0,
      totalSGST: 0,
      totalIGST: 0,
      totalTax: 0,
      totalGrandTotal: 0
    };

    res.json({
      totals,
      details: result.details
    });
  } catch (error) {
    console.error('Error fetching GST Report:', error);
    if (error.message === 'Invalid startDate' || error.message === 'Invalid endDate') {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Error fetching GST Report', error: error.message });
  }
};

// ─── GET Revenue Report ───────────────────────────────────────────────────────
exports.getRevenueReport = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const { startDate, endDate, businessUnit, groupBy } = req.query;
    const parsedDateRange = parseOptionalDateRange(req.query);
    
    // Filter by user
    const matchStage = {
      user: companyId,
      status: { $in: ACTIVE_INVOICE_STATUSES },
    };

    if (businessUnit && mongoose.Types.ObjectId.isValid(businessUnit)) {
      matchStage.businessUnit = new mongoose.Types.ObjectId(businessUnit);
    }

    // Apply date filters if provided
    if (startDate || endDate) {
      matchStage.date = {};
      if (parsedDateRange.startDate) matchStage.date.$gte = parsedDateRange.startDate;
      if (parsedDateRange.endDate) matchStage.date.$lte = parsedDateRange.endDate;
    }

    let groupStage = {
      _id: "$client.clientRef",
      clientName: { $first: "$client.name" },
      clientEmail: { $first: "$client.email" },
      clientPhone: { $first: "$client.phone" },
      totalInvoices: { $sum: 1 },
      totalRevenue: { $sum: "$grandTotal" },
      totalAdvancePaid: { $sum: "$advancePaid" },
      totalBalanceDue: { $sum: "$balanceDue" }
    };

    if (groupBy === 'businessUnit') {
      groupStage = {
        _id: "$businessUnit",
        businessUnitId: { $first: "$businessUnit" },
        clientName: { $first: "$businessUnit" },
        totalInvoices: { $sum: 1 },
        totalRevenue: { $sum: "$grandTotal" },
        totalAdvancePaid: { $sum: "$advancePaid" },
        totalBalanceDue: { $sum: "$balanceDue" }
      };
    }

    const report = await Invoice.aggregate([
      { $match: matchStage },
      { $group: groupStage },
      { $sort: { totalRevenue: -1 } } // Sort by highest revenue
    ]);

    res.json(report);
  } catch (error) {
    console.error('Error fetching Revenue Report:', error);
    if (error.message === 'Invalid startDate' || error.message === 'Invalid endDate') {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Error fetching Revenue Report', error: error.message });
  }
};

// ─── GET Payment Collection (Unpaid Invoices) ─────────────────────────────────
exports.getPaymentCollection = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    // Find all invoices where balance is > 0
    const matchStage = { 
      user: companyId,
      balanceDue: { $gt: 0 },
      status: { $in: ACTIVE_INVOICE_STATUSES },
    };

    const invoices = await Invoice.find(matchStage)
      .sort({ dueDate: 1 }) // Soonest or most overdue first
      .select('invoiceNo date dueDate client.name grandTotal advancePaid balanceDue status');

    // Aggregate some top-level metrics
    const totals = await Invoice.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalOutstanding: { $sum: "$balanceDue" },
          invoiceCount: { $sum: 1 }
        }
      }
    ]);

    const summary = totals.length > 0 ? totals[0] : { totalOutstanding: 0, invoiceCount: 0 };
    delete summary._id;

    res.json({ summary, invoices });
  } catch (error) {
    console.error('Error fetching Payment Collection:', error);
    res.status(500).json({ message: 'Error fetching Payment Collection', error: error.message });
  }
};

// ─── GET Account Statement (Client Ledger) ────────────────────────────────────
exports.getAccountStatement = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const { clientId, startDate, endDate } = req.query;
    const parsedDateRange = parseOptionalDateRange(req.query);

    if (!clientId) {
      return res.status(400).json({ message: 'clientId is required for an account statement.' });
    }

    const matchStage = { 
      user: companyId,
      "client.clientRef": new mongoose.Types.ObjectId(clientId),
      status: { $in: ACTIVE_INVOICE_STATUSES },
    };

    if (startDate || endDate) {
      matchStage.date = {};
      if (parsedDateRange.startDate) matchStage.date.$gte = parsedDateRange.startDate;
      if (parsedDateRange.endDate) matchStage.date.$lte = parsedDateRange.endDate;
    }

    const invoices = await Invoice.find(matchStage)
      .sort({ date: 1 }) // Chronological order
      .select('invoiceNo date invoiceType grandTotal advancePaid balanceDue paymentMode status');

    const totals = await Invoice.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalBilled: { $sum: "$grandTotal" },
          totalReceived: { $sum: { $subtract: ["$grandTotal", "$balanceDue"] } },
          totalBalance: { $sum: "$balanceDue" }
        }
      }
    ]);

    const summary = totals.length > 0 ? totals[0] : { totalBilled: 0, totalReceived: 0, totalBalance: 0 };
    delete summary._id;

    res.json({ summary, invoices });
  } catch (error) {
    console.error('Error fetching Account Statement:', error);
    if (error.message === 'Invalid startDate' || error.message === 'Invalid endDate') {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Error fetching Account Statement', error: error.message });
  }
};

exports.getInvoiceAttachment = async (req, res) => {
  try {
    const companyId = req.companyId || req.user?._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Invoice not found' });
    }

    const invoice = await Invoice.findOne({ _id: req.params.id, user: companyId });
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

    const attachment = invoice.attachments.id(req.params.attachmentId) || invoice.attachments[req.params.attachmentId];
    if (!attachment) return res.status(404).json({ message: 'Attachment not found' });

    return streamAttachment(res, attachment);
  } catch (error) {
    console.error('getInvoiceAttachment error:', error);
    res.status(500).json({ message: error.message });
  }
};
