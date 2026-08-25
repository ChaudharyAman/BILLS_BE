const Proforma = require('../models/Proforma');
const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const Counter = require('../models/Counter');
const Settings = require('../models/Settings');
const escapeRegex = require('../utils/escapeRegex');
const User = require('../models/User');
const mongoose = require('mongoose');
const { buildAutoDocumentNumber, buildCustomDocumentNumber } = require('../utils/documentNumber');
const { syncIncomeFromInvoice } = require('../services/invoiceIncomeSync');
const { isInterStateSupply, processDocumentItems } = require('../utils/gstCalculator');
const { buildUserCounterId } = require('../utils/counterKey');
const { parseImportedDate } = require('../utils/dateRange');

function processItems(items, invoiceType, isIntraState) {
  return processDocumentItems(items, { invoiceType, isIntraState, includeExcise: true });
}

function isProformaNumberDuplicateError(error) {
  return (
    error?.code === 11000 &&
    (error?.keyPattern?.proformaNo || String(error?.message || '').includes('proformaNo'))
  );
}

async function generateNextUniqueProformaNumber({ userId, proformaPrefix }) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const counter = await Counter.findOneAndUpdate(
      { id: buildUserCounterId(userId, 'proformaNo') },
      { $inc: { seq: 1 } },
      { returnDocument: 'after', upsert: true }
    );
    const candidate = buildAutoDocumentNumber(proformaPrefix || 'PRF', counter.seq);
    const exists = await Proforma.exists({ user: userId, proformaNo: candidate });
    if (!exists) return candidate;
  }

  throw new Error('Could not reserve a unique proforma number.');
}

function roundToTwo(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function formatDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function isSameImportedProforma(existingProforma, importedDate, importedGrandTotal) {
  return (
    formatDateKey(existingProforma?.date) === formatDateKey(importedDate) &&
    roundToTwo(existingProforma?.grandTotal) === roundToTwo(importedGrandTotal)
  );
}

exports.getProformas = async (req, res) => {
  try {
    const companyId = req.companyId || req.user?._id;
    if (!companyId) return res.status(401).json({ message: 'Not authorized' });

    const exportAll = req.query.all === 'true';
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    let query = { user: companyId };

    if (search) {
      const safeSearch = escapeRegex(search);
      const Client = require('../models/Client');
      const matchedClients = await Client.find({
        user: companyId,
        name: { $regex: safeSearch, $options: 'i' }
      }).select('_id').lean();

      query.$or = [
        { proformaNo: { $regex: safeSearch, $options: 'i' } },
        { 'client.clientRef': { $in: matchedClients.map(c => c._id) } }
      ];
    }

    if (req.query.businessUnit && mongoose.Types.ObjectId.isValid(req.query.businessUnit)) {
      query.businessUnit = req.query.businessUnit;
    }

    const total = await Proforma.countDocuments(query);
    const proformasQuery = Proforma.find(query)
      .select('-items -notes -terms -shippingAddress')
      .lean()
      .sort({ createdAt: -1 });

    if (!exportAll) {
      proformasQuery.skip(skip).limit(limit);
    }

    const proformas = await proformasQuery;

    res.json({
      data: proformas,
      total,
      page: exportAll ? 1 : page,
      limit: exportAll ? total : limit,
      totalPages: exportAll ? 1 : Math.ceil(total / limit)
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.getProformaById = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Proforma not found' });
    }
    const proforma = await Proforma.findOne({ _id: req.params.id, user: companyId });
    if (!proforma) return res.status(404).json({ message: 'Proforma not found' });
    res.json(proforma);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.createProforma = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const { clientRef, invoiceType, items, date, validUntil, shippingAddress, transport,
      poNumber, poDate,
      placeOfSupply, paymentMode, paymentTerms, shippingCharges, packagingCharges,
      customChargeLabel, discountTotal, status, notes, terms, reverseCharge } = req.body;

    // --- Subscription Plan Check (BEFORE counter increment to avoid wasting sequence numbers) ---
    const userObj = await User.findById(companyId);
    const plan = userObj?.subscription?.plan || 'free';
    if (plan === 'free') {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const proformaCount = await Proforma.countDocuments({
        user: companyId,
        createdAt: { $gte: startOfMonth }
      });
      let quoteCount = 0;
      try {
        const QuoteModel = require('../models/Quote');
        quoteCount = await QuoteModel.countDocuments({ user: companyId, createdAt: { $gte: startOfMonth } });
      } catch(e) {}
      if (quoteCount + proformaCount >= 15) {
        return res.status(403).json({ message: 'Free plan limit reached. You can only create 15 Quotes & Proformas per month. Please upgrade to Pro.' });
      }
    }
    // -------------------------------

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
    const proformaPrefix = userSettings?.proformaPrefix || 'PRF';
    let proformaNo = buildCustomDocumentNumber({
      prefix: proformaPrefix,
      explicitNumber: req.body.proformaNo,
      docNo: req.body.docNo,
      docNoSuffix: req.body.docNoSuffix,
    });

    if (proformaNo) {
      const existing = await Proforma.findOne({ user: companyId, proformaNo });
      if (existing) {
        return res.status(400).json({ message: `Proforma number "${proformaNo}" already exists.` });
      }
    } else {
      const counter = await Counter.findOneAndUpdate(
        { id: buildUserCounterId(companyId, 'proformaNo') }, { $inc: { seq: 1 } }, { returnDocument: 'after', upsert: true }
      );
      proformaNo = buildAutoDocumentNumber(proformaPrefix, counter.seq);
    }

    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';
    const COMPANY_GSTIN = userSettings?.gstin || process.env.COMPANY_GSTIN || '';
    const clientState = placeOfSupply || client.billingAddress?.state || '';
    const isIntraState = !isInterStateSupply(clientState, COMPANY_STATE, COMPANY_GSTIN);

    const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST } =
      processItems(items || [], invoiceType || 'Tax Invoice', isIntraState);

    const finalShipping = Number(shippingCharges) || 0;
    const finalPackaging = Number(packagingCharges) || 0;
    const finalDiscount = Number(discountTotal) || 0;
    const grandTotal = subTotal + taxTotal + finalShipping + finalPackaging - finalDiscount;

    const effectiveTransport = {
      ...(transport || {}),
      ...(poNumber !== undefined ? { poNumber } : {}),
      ...(poDate !== undefined ? { poDate } : {}),
    };

    const proforma = new Proforma({
      user: companyId, proformaNo, invoiceType: invoiceType || 'Tax Invoice',
      date, validUntil, paymentMode, paymentTerms,
      client: clientSnapshot, items: processedItems,
      subTotal, taxTotal, totalCGST, totalSGST, totalIGST,
      shippingCharges: finalShipping, packagingCharges: finalPackaging,
      customChargeLabel: customChargeLabel || 'Custom Amount',
      discountTotal: finalDiscount, grandTotal,
      status: status || 'DRAFT', shippingAddress, transport: effectiveTransport,
      placeOfSupply: clientState, reverseCharge: !!reverseCharge, notes, terms,
      bankDetails: userSettings?.bankDetails || {},
    });

    const saved = await proforma.save();
    res.status(201).json(saved);
  } catch (e) {
    console.error('createProforma error:', e);
    res.status(400).json({ message: e.message });
  }
};

exports.updateProforma = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const { clientRef, invoiceType, items, date, validUntil, shippingAddress, transport,
      poNumber, poDate,
      placeOfSupply, paymentMode, paymentTerms, shippingCharges, packagingCharges,
      customChargeLabel, discountTotal, status, notes, terms, reverseCharge } = req.body;

    const proforma = await Proforma.findOne({ _id: req.params.id, user: companyId });
    if (!proforma) return res.status(404).json({ message: 'Proforma not found' });

    // --- Subscription Plan Check for Edits ---
    const userObj = await User.findById(companyId);
    const plan = userObj?.subscription?.plan || 'free';
    if (plan === 'free') {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const conditions = {
        user: companyId,
        updatedAt: { $gte: startOfMonth },
        $expr: { $gt: ["$updatedAt", "$createdAt"] } 
      };
      
      const editedProformasCount = await Proforma.countDocuments(conditions);

      let otherEditsCount = 0;
      try {
        const InvoiceModel = require('../models/Invoice');
        const QuoteModel = require('../models/Quote');
        const POModel = require('../models/PurchaseOrder');
        const [inv, qt, po] = await Promise.all([
          InvoiceModel.countDocuments(conditions),
          QuoteModel.countDocuments(conditions),
          POModel.countDocuments(conditions)
        ]);
        otherEditsCount = inv + qt + po;
      } catch (e) {}
      
      const totalEditsThisMonth = editedProformasCount + otherEditsCount;
      const isAlreadyEditedThisMonth = proforma.updatedAt && proforma.updatedAt >= startOfMonth && proforma.updatedAt > proforma.createdAt;

      if (totalEditsThisMonth >= 5 && !isAlreadyEditedThisMonth) {
        return res.status(403).json({ message: 'You have reached the free plan limit of 5 document edits per month. Please upgrade to Pro.' });
      }
    }
    // -----------------------------------------

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
    const proformaPrefix = userSettings?.proformaPrefix || 'PRF';
    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';
    const COMPANY_GSTIN = userSettings?.gstin || process.env.COMPANY_GSTIN || '';
    const clientState = placeOfSupply || client.billingAddress?.state || '';
    const isIntraState = !isInterStateSupply(clientState, COMPANY_STATE, COMPANY_GSTIN);
    const effectiveType = invoiceType || proforma.invoiceType || 'Tax Invoice';

    const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST } =
      processItems(items || [], effectiveType, isIntraState);

    const finalShipping = Number(shippingCharges) || 0;
    const finalPackaging = Number(packagingCharges) || 0;
    const finalDiscount = Number(discountTotal) || 0;
    const grandTotal = subTotal + taxTotal + finalShipping + finalPackaging - finalDiscount;

    const requestedProformaNo = buildCustomDocumentNumber({
      prefix: proformaPrefix,
      explicitNumber: req.body.proformaNo,
      docNo: req.body.docNo,
      docNoSuffix: req.body.docNoSuffix,
    });

    if (requestedProformaNo && requestedProformaNo !== proforma.proformaNo) {
      const duplicate = await Proforma.findOne({ user: companyId, proformaNo: requestedProformaNo, _id: { $ne: proforma._id } });
      if (duplicate) {
        return res.status(400).json({ message: `Proforma number "${requestedProformaNo}" already exists.` });
      }
      proforma.proformaNo = requestedProformaNo;
    }

    const effectiveTransport = {
      ...(transport || proforma.transport || {}),
      ...(poNumber !== undefined ? { poNumber } : {}),
      ...(poDate !== undefined ? { poDate } : {}),
    };

    Object.assign(proforma, {
      invoiceType: effectiveType,
      client: clientSnapshot, items: processedItems, date, validUntil,
      paymentMode, paymentTerms, subTotal, taxTotal, totalCGST, totalSGST, totalIGST,
      shippingCharges: finalShipping, packagingCharges: finalPackaging,
      customChargeLabel: customChargeLabel || 'Custom Amount',
      discountTotal: finalDiscount, grandTotal, shippingAddress, transport: effectiveTransport,
      placeOfSupply: clientState, reverseCharge: !!reverseCharge, notes, terms,
    });
    if (status) proforma.status = status;

    const saved = await proforma.save();
    res.json(saved);
  } catch (e) {
    console.error('updateProforma error:', e);
    res.status(400).json({ message: e.message });
  }
};

exports.deleteProforma = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const proforma = await Proforma.findOne({ _id: req.params.id, user: companyId });
    if (!proforma) return res.status(404).json({ message: 'Proforma not found' });
    
    // --- Subscription Check ---
    const userObj = await User.findById(companyId);
    if (userObj?.subscription?.plan === 'free') {
       return res.status(403).json({ message: 'Free users cannot delete documents. Please upgrade to Pro.' });
    }
    // --------------------------

    await Proforma.updateOne({ _id: proforma._id }, { $set: { isDeleted: true, deletedAt: new Date() } });
    res.json({ message: 'Proforma deleted' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.convertToInvoice = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const proforma = await Proforma.findOne({ _id: req.params.id, user: companyId });
    if (!proforma) return res.status(404).json({ message: 'Proforma not found' });
    if (proforma.status === 'CONVERTED') return res.status(400).json({ message: 'Already converted' });

    const userSettings = await Settings.findOne({ user: companyId });
    const counter = await Counter.findOneAndUpdate(
      { id: buildUserCounterId(companyId, 'invoiceNo') }, { $inc: { seq: 1 } }, { returnDocument: 'after', upsert: true }
    );
    const invoiceNo = buildAutoDocumentNumber(userSettings?.invoicePrefix || 'INV', counter.seq);

    // Fetch fresh client data to ensure correct address format specially for old proformas
    const client = await Client.findOne({ _id: proforma.client.clientRef, user: companyId });
    let clientSnapshot = proforma.client;
    let resolvedShipping = proforma.shippingAddress;

    if (client) {
      // Rebuild snapshot from fresh data
      clientSnapshot = {
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

      // Auto-resolve shipping address if missing in proforma
      if (!resolvedShipping?.line1 && client.shippingAddress?.line1) {
        resolvedShipping = {
          line1: client.shippingAddress.line1,
          line2: client.shippingAddress.line2 || '',
          city: client.shippingAddress.city || '',
          state: client.shippingAddress.state || '',
          zip: client.shippingAddress.zip || '',
          country: client.shippingAddress.country || 'India',
        };
      }
    }

    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';
    const COMPANY_GSTIN = userSettings?.gstin || process.env.COMPANY_GSTIN || '';
    const clientState = proforma.placeOfSupply || clientSnapshot.address.state || '';
    const isIntraState = !isInterStateSupply(clientState, COMPANY_STATE, COMPANY_GSTIN);

    const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST, totalExcise } = processItems(proforma.items, proforma.invoiceType, isIntraState);
    const finalShipping = Number(proforma.shippingCharges) || 0;
    const finalPackaging = Number(proforma.packagingCharges) || 0;
    const finalDiscount = Number(proforma.discountTotal) || 0;
    const grandTotal = subTotal + taxTotal + totalExcise + finalShipping + finalPackaging - finalDiscount;

    const invoice = new Invoice({
      user: proforma.user, invoiceNo, invoiceType: proforma.invoiceType,
      date: new Date(), dueDate: proforma.validUntil,
      paymentMode: proforma.paymentMode, paymentTerms: proforma.paymentTerms,
      client: clientSnapshot, items: processedItems,
      subTotal, taxTotal,
      totalCGST, totalSGST, totalIGST,
      shippingCharges: finalShipping, packagingCharges: finalPackaging,
      customChargeLabel: proforma.customChargeLabel, discountTotal: finalDiscount,
      exciseDuty: { totalExcise },
      totalAmount: grandTotal, grandTotal, balanceDue: grandTotal,
      shippingAddress: resolvedShipping, transport: proforma.transport,
      placeOfSupply: proforma.placeOfSupply, reverseCharge: proforma.reverseCharge,
      notes: proforma.notes, terms: proforma.terms, status: 'DRAFT',
    });

    const savedInvoice = await invoice.save();
    let syncError = null;
    try {
      await syncIncomeFromInvoice(savedInvoice);
    } catch (syncErr) {
      syncError = syncErr;
      console.error('syncIncomeFromInvoice failed for proforma:', syncErr);
    }

    proforma.status = 'CONVERTED';
    proforma.convertedToInvoice = savedInvoice._id;
    await proforma.save();

    if (syncError) {
      return res.status(201).json({
        invoice: savedInvoice,
        proforma,
        warning: 'Invoice created but income sync failed',
        syncError: syncError.message,
      });
    }

    res.status(201).json({ invoice: savedInvoice, proforma });
  } catch (e) {
    console.error('convertToInvoice error:', e);
    res.status(400).json({ message: e.message });
  }
};

// ─── BULK create proformas ───────────────────────────────────────────────────
exports.bulkCreateProformas = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const proformas = req.body.proformas;
    if (!Array.isArray(proformas) || proformas.length === 0) {
      return res.status(400).json({ message: 'No proformas provided for bulk creation.' });
    }

    // --- Subscription Plan Check ---
    const userObj = await User.findById(companyId);
    const plan = userObj?.subscription?.plan || 'free';
    if (plan === 'free') {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const proformaCount = await Proforma.countDocuments({
        user: companyId,
        createdAt: { $gte: startOfMonth }
      });
      let quoteCount = 0;
      try {
        const QuoteModel = require('../models/Quote');
        quoteCount = await QuoteModel.countDocuments({ user: companyId, createdAt: { $gte: startOfMonth } });
      } catch(e) {}
      
      const combined = proformaCount + quoteCount;
      if (combined + proformas.length > 15) {
        return res.status(403).json({ message: `Free plan limit reached. You can only create 15 Quotes & Proformas per month. You currently have ${combined} and are trying to add ${proformas.length}.` });
      }
    }
    // -------------------------------

    const userSettings = await Settings.findOne({ user: companyId });
    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';
    const COMPANY_GSTIN = userSettings?.gstin || process.env.COMPANY_GSTIN || '';

    const createdProformas = [];
    const importedProformas = [];
    const skippedProformas = [];
    const renumberedProformas = [];
    const failedProformas = [];
    for (const [index, pData] of proformas.entries()) {
      const importRowId = pData?._importRowId || String(index);
      const rowProformaNo = String(pData?.proformaNo || '').trim();
      const rowClientName = String(pData?.clientName || '').trim();

      try {
      if (!rowClientName) {
        throw new Error('Client name is required for each imported proforma.');
      }

      let client = await Client.findOne({ name: rowClientName, user: companyId });
      if (!client) {
         client = new Client({
            name: rowClientName || 'Unknown Client',
            email: pData.clientEmail || '',
            phone: pData.clientPhone || '',
            billingAddress: { state: pData.clientState || '' },
            user: companyId
         });
         await client.save();
      }

      const clientState = pData.placeOfSupply || client.billingAddress?.state || '';
      const isIntraState = !isInterStateSupply(clientState, COMPANY_STATE, COMPANY_GSTIN);

      let proformaNo = rowProformaNo;
      const originalProformaNo = proformaNo;
      if (!proformaNo || proformaNo === 'Auto-generated') {
        proformaNo = await generateNextUniqueProformaNumber({
          userId: companyId,
          proformaPrefix: userSettings?.proformaPrefix || 'PRF',
        });
      }

      let invoiceType = pData.invoiceType || 'Tax Invoice';
      if (!['Invoice', 'Retail Invoice', 'Tax Invoice', 'Excise Invoice'].includes(invoiceType)) {
        invoiceType = 'Tax Invoice';
      }

      const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST } =
        processItems(pData.items || [], invoiceType, isIntraState);

      const finalShipping = Number(pData.shippingCharges) || 0;
      const finalPackaging = Number(pData.packagingCharges) || 0;
      const finalDiscount = Number(pData.discountTotal) || 0;
      const grandTotal = subTotal + taxTotal + finalShipping + finalPackaging - finalDiscount;
      const finalDate = parseImportedDate(pData.date);

      if (originalProformaNo) {
        const existingProforma = await Proforma.findOne({ user: companyId, proformaNo: originalProformaNo });
        if (existingProforma && isSameImportedProforma(existingProforma, finalDate, grandTotal)) {
          skippedProformas.push({
            importRowId,
            proformaNo: originalProformaNo,
            clientName: rowClientName,
            date: finalDate,
            grandTotal,
            reason: 'same proforma number, date, and amount already exist',
          });
          continue;
        }

        if (existingProforma) {
          proformaNo = await generateNextUniqueProformaNumber({
            userId: companyId,
            proformaPrefix: userSettings?.proformaPrefix || 'PRF',
          });
          renumberedProformas.push({
            importRowId,
            originalProformaNo,
            proformaNo,
            clientName: rowClientName,
            date: finalDate,
            grandTotal,
            reason: 'same proforma number exists with different date or amount',
          });
        }
      }

      let savedProforma = null;
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const proforma = new Proforma({
        proformaNo,
        invoiceType,
        date: finalDate,
        validUntil: parseImportedDate(pData.validUntil),
        paymentMode: pData.paymentMode || 'Cash',
        paymentTerms: pData.paymentTerms || '',
        shippingAddress: pData.shippingAddress,
        transport: pData.transport,
        placeOfSupply: pData.placeOfSupply || clientState,
        reverseCharge: !!pData.reverseCharge,
        customChargeLabel: pData.customChargeLabel || 'Custom Amount',
        notes: pData.notes || '',
        terms: pData.terms || '',
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
        subTotal, taxTotal, totalCGST, totalSGST, totalIGST,
        shippingCharges: finalShipping, packagingCharges: finalPackaging,
        discountTotal: finalDiscount, grandTotal,
        status: 'DRAFT',
        user: companyId
      });

        try {
          savedProforma = await proforma.save();
          break;
        } catch (error) {
          if (!isProformaNumberDuplicateError(error)) {
            throw error;
          }

          proformaNo = await generateNextUniqueProformaNumber({
            userId: companyId,
            proformaPrefix: userSettings?.proformaPrefix || 'PRF',
          });
          renumberedProformas.push({
            importRowId,
            originalProformaNo: originalProformaNo || rowProformaNo,
            proformaNo,
            clientName: rowClientName,
            date: finalDate,
            grandTotal,
            reason: 'proforma number was already used during import',
          });
        }
      }

      if (!savedProforma) {
        throw new Error('Could not generate a unique proforma number during import.');
      }

      createdProformas.push(savedProforma);
      importedProformas.push({
        importRowId,
        proformaNo: savedProforma.proformaNo,
        originalProformaNo: originalProformaNo || savedProforma.proformaNo,
        clientName: savedProforma.client?.name || rowClientName,
        date: savedProforma.date,
        grandTotal: savedProforma.grandTotal,
        status: savedProforma.status,
        renumbered: !!originalProformaNo && savedProforma.proformaNo !== originalProformaNo,
      });
      } catch (rowError) {
        failedProformas.push({
          importRowId,
          row: index + 1,
          proformaNo: rowProformaNo,
          clientName: rowClientName,
          reason: rowError.message || 'Failed to import proforma row',
        });
      }
    }

    const messageParts = [`Successfully imported ${createdProformas.length} proformas.`];
    if (skippedProformas.length) messageParts.push(`${skippedProformas.length} duplicate proformas skipped.`);
    if (renumberedProformas.length) messageParts.push(`${renumberedProformas.length} proformas renumbered.`);
    if (failedProformas.length) messageParts.push(`${failedProformas.length} proformas failed.`);

    res.status(201).json({
      message: messageParts.join(' '),
      count: createdProformas.length,
      imported: createdProformas.length,
      updated: 0,
      skipped: skippedProformas.length,
      renumbered: renumberedProformas.length,
      failed: failedProformas.length,
      importedProformas,
      skippedProformas,
      renumberedProformas,
      failedProformas,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── UPDATE proforma status ──────────────────────────────────────────────────
exports.updateProformaStatus = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ message: 'Status is required' });
    }

    const proforma = await Proforma.findOne({ _id: req.params.id, user: companyId });
    if (!proforma) return res.status(404).json({ message: 'Proforma not found' });
    if (proforma.status === 'CONVERTED' || proforma.convertedToInvoice) {
      return res.status(400).json({ message: 'Converted proformas cannot be updated.' });
    }

    proforma.status = status;
    const saved = await proforma.save();
    res.json(saved);
  } catch (error) {
    console.error('updateProformaStatus error:', error);
    res.status(500).json({ message: error.message });
  }
};
