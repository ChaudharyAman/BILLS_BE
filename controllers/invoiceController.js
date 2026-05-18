const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const Item = require('../models/Item');
const Counter = require('../models/Counter');
const Settings = require('../models/Settings');
const mongoose = require('mongoose');
const escapeRegex = require('../utils/escapeRegex');
const { buildAutoDocumentNumber } = require('../utils/documentNumber');
const { syncIncomeFromInvoice, removeIncomeForInvoice } = require('../services/invoiceIncomeSync');
const { isInterStateSupply, processDocumentItems } = require('../utils/gstCalculator');
const { buildUserCounterId } = require('../utils/counterKey');

const User = require('../models/User');
const PDF_IMPORT_SOURCE = 'pdf';

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
    if (!req.user || !req.user._id) {
      return res.status(401).json({ message: 'Not authorized' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    let query = { user: req.user._id };

    if (search) {
      const safeSearch = escapeRegex(search);
      // Find clients that match the search term
      const Client = require('../models/Client'); // Lazy load if needed
      const matchedClients = await Client.find({
        user: req.user._id,
        name: { $regex: safeSearch, $options: 'i' }
      }).select('_id').lean();

      const clientIds = matchedClients.map(c => c._id);

      // Search either by invoice number OR matching clients
      query.$or = [
        { invoiceNo: { $regex: safeSearch, $options: 'i' } },
        { 'client.clientRef': { $in: clientIds } }
      ];
    }

    const total = await Invoice.countDocuments(query);
    const invoices = await Invoice.find(query)
      .populate('user', 'username').select('-items -terms -shippingAddress')
      .lean()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      data: invoices,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── GET single invoice ───────────────────────────────────────────────────────
exports.getInvoiceById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Invoice not found' });
    }
    const invoice = await Invoice.findOne({ _id: req.params.id, user: req.user._id });
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── CREATE invoice ───────────────────────────────────────────────────────────
exports.createInvoice = async (req, res) => {
  try {
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
      tcs,
      drCr,
    } = req.body;
    const resolvedImportSource = importSource || (req.body._fromPdfImport ? PDF_IMPORT_SOURCE : '');

    // --- Subscription Plan Check ---
    const userObj = await User.findById(req.user._id);
    const isPro = userObj?.subscription?.plan === 'pro' && userObj?.subscription?.status === 'active';
    if (!isPro) {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const invoiceCount = await Invoice.countDocuments({
        user: req.user._id,
        createdAt: { $gte: startOfMonth }
      });
      if (invoiceCount >= 15) {
        return res.status(403).json({ message: 'Free plan limit reached. You can only create 15 Invoices per month. Please upgrade to Pro.' });
      }
    }
    // -------------------------------
    const userSettings = await Settings.findOne({ user: req.user._id });
    const invoicePrefix = userSettings?.invoicePrefix || 'INV';
    let invoiceNo = req.body.invoiceNo;
    const isAuto = !invoiceNo || invoiceNo === 'Auto-generated';

    if (!isAuto) {
      // Validate Custom Invoice Number Uniqueness for this user
      const existing = await Invoice.findOne({ user: req.user._id, invoiceNo });
      if (existing) {
        return res.status(400).json({ message: `Invoice number "${invoiceNo}" already exists.` });
      }
    } else {
      // Generate Invoice Number
      const counter = await Counter.findOneAndUpdate(
        { id: buildUserCounterId(req.user._id, 'invoiceNo') },
        { $inc: { seq: 1 } },
        { returnDocument: 'after', upsert: true }
      );
      invoiceNo = buildAutoDocumentNumber(invoicePrefix, counter.seq);
    }

    const client = await resolveClientForInvoice({
      userId: req.user._id,
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
    // Normalize: extract state name before parenthesis for comparison e.g. "HR (06)" → "HR", "Haryana (06)" → "Haryana"
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
      ? await resolvePdfImportItems(req.user._id, items || [])
      : (items || []);

    // Process items
    const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST, totalExcise } =
      processItems(resolvedItems, invoiceType, isIntraState);

    const finalShipping = Number(shippingCharges) || 0;
    const finalPackaging = Number(packagingCharges) || 0;
    const finalDiscountTotal = Number(discountTotal) || 0;
    const grandTotal = subTotal + (reverseCharge ? 0 : taxTotal) + totalExcise + finalShipping + finalPackaging - finalDiscountTotal + (Number(tcs) || 0);
    const finalTcs = Number(tcs) || 0;
    const finalTds = Number(tds) || 0;
    const finalAdvance = Number(advancePaid) || 0;
    const finalBalance = Math.max(0, grandTotal - finalAdvance - finalTds);

    const invoice = new Invoice({
      user: req.user._id,
      invoiceNo,
      invoiceType,
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
      status: status || 'DRAFT',
      shippingAddress: resolvedShippingAddress,
      transport,
      bankDetails,
      placeOfSupply: clientState,
      reverseCharge: !!reverseCharge,
      fy: fy || getFinancialYear(date),
      currency: currency || 'INR',
      tds: finalTds,
      tcs: finalTcs,
      drCr: drCr || 'Dr.',
      notes,
      terms,
      exciseDuty: buildExciseDutySnapshot(exciseDuty, totalExcise),
    });

    const newInvoice = await invoice.save();
    await syncIncomeFromInvoice(newInvoice);
    res.status(201).json(newInvoice);

  } catch (error) {
    console.error('createInvoice error:', error);
    res.status(400).json({ message: error.message });
  }
};

// ─── UPDATE invoice ───────────────────────────────────────────────────────────
exports.updateInvoice = async (req, res) => {
  try {
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
      tcs,
      drCr,
    } = req.body;

    const invoice = await Invoice.findOne({ _id: req.params.id, user: req.user._id });
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

    // --- Subscription Plan Check for Edits ---
    const userObj = await User.findById(req.user._id);
    const isPro = userObj?.subscription?.plan === 'pro' && userObj?.subscription?.status === 'active';
    if (!isPro) {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const conditions = {
        user: req.user._id,
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
    const client = await Client.findOne({ _id: clientRef, user: req.user._id });
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

    const userSettings = await Settings.findOne({ user: req.user._id });
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

    const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST, totalExcise } =
      processItems(items || [], effectiveType, isIntraState);

    const finalShipping = Number(shippingCharges) || 0;
    const finalPackaging = Number(packagingCharges) || 0;
    const finalDiscountTotal = Number(discountTotal) || 0;
    const grandTotal = subTotal + (reverseCharge ? 0 : taxTotal) + totalExcise + finalShipping + finalPackaging - finalDiscountTotal + (Number(tcs) || 0);
    const finalTcs = Number(tcs) || 0;
    const finalTds = Number(tds) || 0;
    const finalAdvance = Number(advancePaid) || 0;
    const finalBalance = Math.max(0, grandTotal - finalAdvance - finalTds);

    // Apply updates
    invoice.invoiceType = effectiveType;
    // Allow updating invoiceNo only if a custom value was provided and it differs
    if (req.body.invoiceNo && req.body.invoiceNo !== 'Auto-generated' && req.body.invoiceNo !== invoice.invoiceNo) {
      const duplicate = await Invoice.findOne({ user: req.user._id, invoiceNo: req.body.invoiceNo, _id: { $ne: invoice._id } });
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
    invoice.shippingAddress = resolvedShippingAddress;
    invoice.transport = transport;
    invoice.bankDetails = bankDetails;
    invoice.placeOfSupply = clientState;
    invoice.reverseCharge = !!reverseCharge;
    invoice.fy = fy || getFinancialYear(date);
    invoice.currency = currency || 'INR';
    invoice.tds = finalTds;
    invoice.tcs = finalTcs;
    invoice.drCr = drCr || 'Dr.';
    invoice.notes = notes;
    invoice.terms = terms;
    invoice.exciseDuty = buildExciseDutySnapshot(exciseDuty || invoice.exciseDuty, totalExcise);
    if (status) invoice.status = status;

    const updatedInvoice = await invoice.save();
    await syncIncomeFromInvoice(updatedInvoice);
    res.json(updatedInvoice);

  } catch (error) {
    console.error('updateInvoice error:', error);
    res.status(400).json({ message: error.message });
  }
};

// ─── DELETE invoice ───────────────────────────────────────────────────────────
exports.deleteInvoice = async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, user: req.user._id });
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });

    // --- Subscription Plan Check for Deletes ---
    const userObj = await User.findById(req.user._id);
    const isPro = userObj?.subscription?.plan === 'pro' && userObj?.subscription?.status === 'active';
    if (!isPro) {
       return res.status(403).json({ message: 'Free users cannot delete documents. Please upgrade to Pro.' });
    }
    // -------------------------------------------
    await invoice.deleteOne();
    await removeIncomeForInvoice(invoice._id, invoice.user);
    res.json({ message: 'Invoice deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── BULK create invoices ───────────────────────────────────────────────────
exports.bulkCreateInvoices = async (req, res) => {
  try {
    const invoices = req.body.invoices;
    if (!Array.isArray(invoices) || invoices.length === 0) {
      return res.status(400).json({ message: 'No invoices provided for bulk creation.' });
    }

    // --- Subscription Plan Check ---
    const userObj = await User.findById(req.user._id);
    const isPro = userObj?.subscription?.plan === 'pro' && userObj?.subscription?.status === 'active';
    if (!isPro) {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const invoiceCount = await Invoice.countDocuments({
        user: req.user._id,
        createdAt: { $gte: startOfMonth }
      });
      if (invoiceCount + invoices.length > 15) {
        return res.status(403).json({ message: `Free plan limit reached. You can only create 15 Invoices per month. You currently have ${invoiceCount} and are trying to add ${invoices.length}.` });
      }
    }
    // -------------------------------

    const userSettings = await Settings.findOne({ user: req.user._id });
    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';
    const COMPANY_GSTIN = userSettings?.gstin || process.env.COMPANY_GSTIN || '';

    const createdInvoices = [];
    for (const invData of invoices) {
      const clientName = String(invData.clientName || '').trim();
      if (!clientName) {
        throw new Error('Client name is required for each imported invoice.');
      }

      let client = await Client.findOne({
        user: req.user._id,
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
          user: req.user._id,
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

      let invoiceNo = String(invData.invoiceNo || '').trim();
      if (!invoiceNo || invoiceNo === 'Auto-generated') {
        const counter = await Counter.findOneAndUpdate(
          { id: buildUserCounterId(req.user._id, 'invoiceNo') },
          { $inc: { seq: 1 } },
          { returnDocument: 'after', upsert: true }
        );
        invoiceNo = buildAutoDocumentNumber(userSettings?.invoicePrefix || 'INV', counter.seq);
      } else {
        const existingInvoice = await Invoice.findOne({ user: req.user._id, invoiceNo });
        if (existingInvoice) {
          throw new Error(`Invoice number "${invoiceNo}" already exists.`);
        }
      }

      const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST, totalExcise } =
        processItems(invData.items || [], invData.invoiceType || 'Tax Invoice', isIntraState);

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
      const advancePaid = importedAdvancePaid !== null ? importedAdvancePaid : 0;
      const balanceDue = importedBalanceDue !== null
        ? importedBalanceDue
        : Math.max(0, roundToTwo(finalGrandTotal - advancePaid - finalTds));
      const finalTaxBreakdown = importedTaxTotal !== null
        ? deriveImportedTaxBreakdown(finalTaxTotal, invData.invoiceType || 'Tax Invoice', isIntraState)
        : { totalCGST, totalSGST, totalIGST };
      const finalStatus = parseImportedStatus(invData.status, balanceDue);
        const invoice = new Invoice({
          invoiceNo,
          invoiceType: invData.invoiceType || 'Tax Invoice',
          date: invData.date || new Date(),
          dueDate: invData.dueDate || new Date(),
        paymentMode: invData.paymentMode || '',
        paymentTerms: invData.paymentTerms || '',
        shippingAddress: invData.shippingAddress,
        transport: invData.transport,
        bankDetails: invData.bankDetails,
        placeOfSupply: invData.placeOfSupply || clientState,
        reverseCharge: !!invData.reverseCharge,
        fy: invData.fy || getFinancialYear(invData.date || new Date()),
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
          advancePaid,
          balanceDue,
          paymentDate: invData.paymentDate || undefined,
          status: finalStatus,
          notes: String(invData.notes || '').trim(),
          terms: invData.terms || '',
          exciseDuty: buildExciseDutySnapshot(invData.exciseDuty, finalExciseTotal),
          user: req.user._id
        });
      
      const savedInvoice = await invoice.save();
      await syncIncomeFromInvoice(savedInvoice);
      createdInvoices.push(savedInvoice);
    }

    res.status(201).json({ message: `Successfully imported ${createdInvoices.length} invoices.`, count: createdInvoices.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── GET GST Report ───────────────────────────────────────────────────────────
exports.getGSTReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    // Filter by user
    const matchStage = { user: req.user._id };

    // Apply date filters if provided
    if (startDate || endDate) {
      matchStage.date = {};
      if (startDate) matchStage.date.$gte = new Date(startDate);
      if (endDate) matchStage.date.$lte = new Date(endDate);
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
    res.status(500).json({ message: 'Error fetching GST Report', error: error.message });
  }
};

// ─── GET Revenue Report ───────────────────────────────────────────────────────
exports.getRevenueReport = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    // Filter by user
    const matchStage = { user: req.user._id };

    // Apply date filters if provided
    if (startDate || endDate) {
      matchStage.date = {};
      if (startDate) matchStage.date.$gte = new Date(startDate);
      if (endDate) matchStage.date.$lte = new Date(endDate);
    }

    const report = await Invoice.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: "$client.clientRef",
          clientName: { $first: "$client.name" },
          clientEmail: { $first: "$client.email" },
          clientPhone: { $first: "$client.phone" },
          totalInvoices: { $sum: 1 },
          totalRevenue: { $sum: "$grandTotal" },
          totalAdvancePaid: { $sum: "$advancePaid" },
          totalBalanceDue: { $sum: "$balanceDue" }
        }
      },
      { $sort: { totalRevenue: -1 } } // Sort by highest revenue
    ]);

    res.json(report);
  } catch (error) {
    console.error('Error fetching Revenue Report:', error);
    res.status(500).json({ message: 'Error fetching Revenue Report', error: error.message });
  }
};

// ─── GET Payment Collection (Unpaid Invoices) ─────────────────────────────────
exports.getPaymentCollection = async (req, res) => {
  try {
    // Find all invoices where balance is > 0
    const matchStage = { 
      user: req.user._id,
      balanceDue: { $gt: 0 }
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
    const { clientId, startDate, endDate } = req.query;

    if (!clientId) {
      return res.status(400).json({ message: 'clientId is required for an account statement.' });
    }

    const matchStage = { 
      user: req.user._id,
      "client.clientRef": new mongoose.Types.ObjectId(clientId)
    };

    if (startDate || endDate) {
      matchStage.date = {};
      if (startDate) matchStage.date.$gte = new Date(startDate);
      if (endDate) matchStage.date.$lte = new Date(endDate);
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
    res.status(500).json({ message: 'Error fetching Account Statement', error: error.message });
  }
};
