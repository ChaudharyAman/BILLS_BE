const Quote = require('../models/Quote');
const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const Counter = require('../models/Counter');
const Settings = require('../models/Settings');
const escapeRegex = require('../utils/escapeRegex');
const { buildAutoDocumentNumber, buildCustomDocumentNumber } = require('../utils/documentNumber');
const { syncIncomeFromInvoice } = require('../services/invoiceIncomeSync');
const { isInterStateSupply, processDocumentItems } = require('../utils/gstCalculator');
const { buildUserCounterId } = require('../utils/counterKey');

const User = require('../models/User');
const mongoose = require('mongoose');

// ─── Shared item processor ────────────────────────────────────────────────────
function processItems(items, invoiceType, isIntraState) {
  return processDocumentItems(items, { invoiceType, isIntraState });
}

// ─── GET all quotes ───────────────────────────────────────────────────────────
exports.getQuotes = async (req, res) => {
  try {
    if (!req.user?._id) return res.status(401).json({ message: 'Not authorized' });

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    let query = { user: req.user._id };

    if (search) {
      const safeSearch = escapeRegex(search);
      const Client = require('../models/Client');
      const matchedClients = await Client.find({
        user: req.user._id,
        name: { $regex: safeSearch, $options: 'i' }
      }).select('_id').lean();

      query.$or = [
        { quoteNo: { $regex: safeSearch, $options: 'i' } },
        { 'client.clientRef': { $in: matchedClients.map(c => c._id) } }
      ];
    }

    const total = await Quote.countDocuments(query);
    const quotes = await Quote.find(query)
      .select('-items -notes -terms -shippingAddress')
      .lean()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      data: quotes,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ─── GET single quote ─────────────────────────────────────────────────────────
exports.getQuoteById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Quote not found' });
    }
    const quote = await Quote.findOne({ _id: req.params.id, user: req.user._id });
    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    res.json(quote);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ─── CREATE quote ─────────────────────────────────────────────────────────────
exports.createQuote = async (req, res) => {
  try {
    const { clientRef, invoiceType, items, date, validUntil, shippingAddress, transport,
      poNumber, poDate,
      placeOfSupply, paymentMode, paymentTerms, shippingCharges, packagingCharges,
      customChargeLabel, discountTotal, status, notes, terms, reverseCharge } = req.body;

    // --- Subscription Plan Check ---
    const userObj = await User.findById(req.user._id);
    const plan = userObj?.subscription?.plan || 'free';
    
    if (plan === 'free') {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const quoteCount = await Quote.countDocuments({
        user: req.user._id,
        createdAt: { $gte: startOfMonth }
      });
      let proformaCount = 0;
      try {
        const ProformaModel = require('../models/Proforma');
        proformaCount = await ProformaModel.countDocuments({ user: req.user._id, createdAt: { $gte: startOfMonth } });
      } catch(e) {}
      if (quoteCount + proformaCount >= 15) {
        return res.status(403).json({ message: 'Free plan limit reached. You can only create 15 Quotes & Proformas per month.' });
      }
    }
    // -------------------------------

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
    const quotePrefix = userSettings?.quotePrefix || 'QT';
    let quoteNo = buildCustomDocumentNumber({
      prefix: quotePrefix,
      explicitNumber: req.body.quoteNo,
      docNo: req.body.docNo,
      docNoSuffix: req.body.docNoSuffix,
    });

    if (quoteNo) {
      const existing = await Quote.findOne({ user: req.user._id, quoteNo });
      if (existing) {
        return res.status(400).json({ message: `Quote number "${quoteNo}" already exists.` });
      }
    } else {
      const counter = await Counter.findOneAndUpdate(
        { id: buildUserCounterId(req.user._id, 'quoteNo') }, { $inc: { seq: 1 } }, { returnDocument: 'after', upsert: true }
      );
      quoteNo = buildAutoDocumentNumber(quotePrefix, counter.seq);
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

    const quote = new Quote({
      user: req.user._id, quoteNo, invoiceType: invoiceType || 'Tax Invoice',
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

    const saved = await quote.save();
    res.status(201).json(saved);
  } catch (e) {
    console.error('createQuote error:', e);
    res.status(400).json({ message: e.message });
  }
};

// ─── UPDATE quote ─────────────────────────────────────────────────────────────
exports.updateQuote = async (req, res) => {
  try {
    const { clientRef, invoiceType, items, date, validUntil, shippingAddress, transport,
      poNumber, poDate,
      placeOfSupply, paymentMode, paymentTerms, shippingCharges, packagingCharges,
      customChargeLabel, discountTotal, status, notes, terms, reverseCharge } = req.body;

    const quote = await Quote.findOne({ _id: req.params.id, user: req.user._id });
    if (!quote) return res.status(404).json({ message: 'Quote not found' });

    // --- Subscription Plan Check for Edits ---
    const userObj = await User.findById(req.user._id);
    const plan = userObj?.subscription?.plan || 'free';
    
    if (plan === 'free') {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const conditions = {
        user: req.user._id,
        updatedAt: { $gte: startOfMonth },
        $expr: { $gt: ["$updatedAt", "$createdAt"] } 
      };
      
      const editedQuotesCount = await Quote.countDocuments(conditions);

      let otherEditsCount = 0;
      try {
        const InvoiceModel = require('../models/Invoice');
        const ProformaModel = require('../models/Proforma');
        const POModel = require('../models/PurchaseOrder');
        const [inv, prf, po] = await Promise.all([
          InvoiceModel.countDocuments(conditions),
          ProformaModel.countDocuments(conditions),
          POModel.countDocuments(conditions)
        ]);
        otherEditsCount = inv + prf + po;
      } catch (e) {}
      
      const totalEditsThisMonth = editedQuotesCount + otherEditsCount;

      const isAlreadyEditedThisMonth = quote.updatedAt && quote.updatedAt >= startOfMonth && quote.updatedAt > quote.createdAt;

      if (totalEditsThisMonth >= 5 && !isAlreadyEditedThisMonth) {
        return res.status(403).json({ message: 'You have reached the free plan limit of 5 document edits per month. Please upgrade to Pro.' });
      }
    }
    // -----------------------------------------

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
    const quotePrefix = userSettings?.quotePrefix || 'QT';
    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';
    const COMPANY_GSTIN = userSettings?.gstin || process.env.COMPANY_GSTIN || '';
    const clientState = placeOfSupply || client.billingAddress?.state || '';
    const isIntraState = !isInterStateSupply(clientState, COMPANY_STATE, COMPANY_GSTIN);
    const effectiveType = invoiceType || quote.invoiceType || 'Tax Invoice';

    const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST } =
      processItems(items || [], effectiveType, isIntraState);

    const finalShipping = Number(shippingCharges) || 0;
    const finalPackaging = Number(packagingCharges) || 0;
    const finalDiscount = Number(discountTotal) || 0;
    const grandTotal = subTotal + taxTotal + finalShipping + finalPackaging - finalDiscount;

    const requestedQuoteNo = buildCustomDocumentNumber({
      prefix: quotePrefix,
      explicitNumber: req.body.quoteNo,
      docNo: req.body.docNo,
      docNoSuffix: req.body.docNoSuffix,
    });

    if (requestedQuoteNo && requestedQuoteNo !== quote.quoteNo) {
      const duplicate = await Quote.findOne({ user: req.user._id, quoteNo: requestedQuoteNo, _id: { $ne: quote._id } });
      if (duplicate) {
        return res.status(400).json({ message: `Quote number "${requestedQuoteNo}" already exists.` });
      }
      quote.quoteNo = requestedQuoteNo;
    }

    const effectiveTransport = {
      ...(transport || quote.transport || {}),
      ...(poNumber !== undefined ? { poNumber } : {}),
      ...(poDate !== undefined ? { poDate } : {}),
    };

    Object.assign(quote, {
      invoiceType: effectiveType,
      client: clientSnapshot, items: processedItems, date, validUntil,
      paymentMode, paymentTerms, subTotal, taxTotal, totalCGST, totalSGST, totalIGST,
      shippingCharges: finalShipping, packagingCharges: finalPackaging,
      customChargeLabel: customChargeLabel || 'Custom Amount',
      discountTotal: finalDiscount, grandTotal, shippingAddress, transport: effectiveTransport,
      placeOfSupply: clientState, reverseCharge: !!reverseCharge, notes, terms,
    });
    if (status) quote.status = status;

    const saved = await quote.save();
    res.json(saved);
  } catch (e) {
    console.error('updateQuote error:', e);
    res.status(400).json({ message: e.message });
  }
};

// ─── DELETE quote ─────────────────────────────────────────────────────────────
exports.deleteQuote = async (req, res) => {
  try {
    const quote = await Quote.findOne({ _id: req.params.id, user: req.user._id });
    if (!quote) return res.status(404).json({ message: 'Quote not found' });

    // --- Subscription Plan Check for Deletes ---
    const userObj = await User.findById(req.user._id);
    const plan = userObj?.subscription?.plan || 'free';
    if (plan === 'free') {
       return res.status(403).json({ message: 'Free users cannot delete documents. Please upgrade to Pro.' });
    }
    // -------------------------------------------
    await quote.deleteOne();
    res.json({ message: 'Quote deleted' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ─── CONVERT quote → invoice ──────────────────────────────────────────────────
exports.convertToInvoice = async (req, res) => {
  try {
    const quote = await Quote.findOne({ _id: req.params.id, user: req.user._id });
    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    if (quote.status === 'CONVERTED') return res.status(400).json({ message: 'Already converted' });

    const userSettings = await Settings.findOne({ user: req.user._id });
    const counter = await Counter.findOneAndUpdate(
      { id: buildUserCounterId(req.user._id, 'invoiceNo') }, { $inc: { seq: 1 } }, { returnDocument: 'after', upsert: true }
    );
    const invoiceNo = buildAutoDocumentNumber(userSettings?.invoicePrefix || 'INV', counter.seq);

    // Fetch fresh client data to ensure correct address format specially for old quotes
    const client = await Client.findOne({ _id: quote.client.clientRef, user: req.user._id });
    let clientSnapshot = quote.client;
    let resolvedShipping = quote.shippingAddress;

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

      // Auto-resolve shipping address if missing in quote
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
    const clientState = quote.placeOfSupply || clientSnapshot.address.state || '';
    const isIntraState = !isInterStateSupply(clientState, COMPANY_STATE, COMPANY_GSTIN);

    const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST } = processItems(quote.items || [], quote.invoiceType, isIntraState);
    const finalShipping = Number(quote.shippingCharges) || 0;
    const finalPackaging = Number(quote.packagingCharges) || 0;
    const finalDiscount = Number(quote.discountTotal) || 0;
    const grandTotal = subTotal + taxTotal + finalShipping + finalPackaging - finalDiscount;

    const invoice = new Invoice({
      user: quote.user, invoiceNo, invoiceType: quote.invoiceType,
      date: new Date(), dueDate: quote.validUntil,
      paymentMode: quote.paymentMode, paymentTerms: quote.paymentTerms,
      client: clientSnapshot, items: processedItems,
      subTotal, taxTotal,
      totalCGST, totalSGST, totalIGST,
      shippingCharges: finalShipping, packagingCharges: finalPackaging,
      customChargeLabel: quote.customChargeLabel, discountTotal: finalDiscount,
      grandTotal, balanceDue: grandTotal,
      shippingAddress: resolvedShipping, transport: quote.transport,
      placeOfSupply: quote.placeOfSupply, reverseCharge: quote.reverseCharge,
      notes: quote.notes, terms: quote.terms, status: 'DRAFT',
    });

    const session = await mongoose.startSession();
    let savedInvoice = null;
    await session.withTransaction(async () => {
      savedInvoice = await invoice.save({ session });
      await syncIncomeFromInvoice(savedInvoice, session);
      quote.status = 'CONVERTED';
      quote.convertedToInvoice = savedInvoice._id;
      await quote.save({ session });
    });
    session.endSession();

    res.status(201).json({ invoice: savedInvoice, quote });
  } catch (e) {
    console.error('convertToInvoice error:', e);
    res.status(400).json({ message: e.message });
  }
};

// ─── BULK create quotes ───────────────────────────────────────────────────
exports.bulkCreateQuotes = async (req, res) => {
  try {
    const quotes = req.body.quotes;
    if (!Array.isArray(quotes) || quotes.length === 0) {
      return res.status(400).json({ message: 'No quotes provided for bulk creation.' });
    }

    // --- Subscription Plan Check ---
    const userObj = await User.findById(req.user._id);
    const plan = userObj?.subscription?.plan || 'free';
    
    if (plan === 'free') {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const quoteCount = await Quote.countDocuments({
        user: req.user._id,
        createdAt: { $gte: startOfMonth }
      });
      let proformaCount = 0;
      try {
        const ProformaModel = require('../models/Proforma');
        proformaCount = await ProformaModel.countDocuments({ user: req.user._id, createdAt: { $gte: startOfMonth } });
      } catch(e) {}
      
      const combined = quoteCount + proformaCount;
      if (combined + quotes.length > 15) {
        return res.status(403).json({ message: `Free plan limit reached. You can only create 15 Quotes & Proformas per month. You currently have ${combined} and are trying to add ${quotes.length}.` });
      }
    }
    // -------------------------------

    const userSettings = await Settings.findOne({ user: req.user._id });
    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';
    const COMPANY_GSTIN = userSettings?.gstin || process.env.COMPANY_GSTIN || '';

    const createdQuotes = [];
    for (const qData of quotes) {
      let client = await Client.findOne({ name: qData.clientName, user: req.user._id });
      if (!client) {
         client = new Client({
            name: qData.clientName || 'Unknown Client',
            email: qData.clientEmail || '',
            phone: qData.clientPhone || '',
            billingAddress: { state: qData.clientState || '' },
            user: req.user._id
         });
         await client.save();
      }

      const clientState = qData.placeOfSupply || client.billingAddress?.state || '';
      const isIntraState = !isInterStateSupply(clientState, COMPANY_STATE, COMPANY_GSTIN);

      const counter = await Counter.findOneAndUpdate(
        { id: buildUserCounterId(req.user._id, 'quoteNo') },
        { $inc: { seq: 1 } },
        { returnDocument: 'after', upsert: true }
      );
      const quoteNo = buildAutoDocumentNumber(userSettings?.quotePrefix || 'QT', counter.seq);

      const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST } =
        processItems(qData.items || [], qData.invoiceType || 'Tax Invoice', isIntraState);

      const finalShipping = Number(qData.shippingCharges) || 0;
      const finalPackaging = Number(qData.packagingCharges) || 0;
      const finalDiscount = Number(qData.discountTotal) || 0;
      const grandTotal = subTotal + taxTotal + finalShipping + finalPackaging - finalDiscount;

      const quote = new Quote({
        quoteNo,
        invoiceType: qData.invoiceType || 'Tax Invoice',
        date: qData.date || new Date(),
        validUntil: qData.validUntil || new Date(),
        paymentMode: qData.paymentMode || 'Cash',
        paymentTerms: qData.paymentTerms || '',
        shippingAddress: qData.shippingAddress,
        transport: qData.transport,
        placeOfSupply: qData.placeOfSupply || clientState,
        reverseCharge: !!qData.reverseCharge,
        customChargeLabel: qData.customChargeLabel || 'Custom Amount',
        notes: qData.notes || '',
        terms: qData.terms || '',
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
        user: req.user._id
      });
      
      const savedQuote = await quote.save();
      createdQuotes.push(savedQuote);
    }

    res.status(201).json({ message: `Successfully imported ${createdQuotes.length} quotes.`, count: createdQuotes.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
