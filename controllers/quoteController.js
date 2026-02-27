const Quote = require('../models/Quote');
const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const Counter = require('../models/Counter');
const Settings = require('../models/Settings');

const User = require('../models/User');

// ─── Shared item processor ────────────────────────────────────────────────────
function processItems(items, isIntraState) {
  let subTotal = 0, totalCGST = 0, totalSGST = 0, totalIGST = 0, taxTotal = 0;
  const processedItems = [];

  for (const item of items) {
    const qty = Number(item.qty) || 0;
    const rate = Number(item.rate) || 0;
    const discountPct = Number(item.discount) || 0;
    const taxRate = Number(item.taxRate) || 0;

    const taxableValue = qty * rate * (1 - discountPct / 100);
    const itemTax = taxableValue * (taxRate / 100);

    let cgst = 0, sgst = 0, igst = 0;
    if (isIntraState) { cgst = itemTax / 2; sgst = itemTax / 2; }
    else { igst = itemTax; }

    const total = taxableValue + itemTax;
    subTotal += taxableValue;
    taxTotal += itemTax;
    totalCGST += cgst;
    totalSGST += sgst;
    totalIGST += igst;

    processedItems.push({
      itemRef: item.itemRef, name: item.name, description: item.description,
      hsnCode: item.hsnCode, qty, unit: item.unit, rate, discount: discountPct,
      taxRate, taxAmount: itemTax, cgst, sgst, igst, amount: total,
    });
  }
  return { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST };
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
      const Client = require('../models/Client');
      const matchedClients = await Client.find({
        user: req.user._id,
        name: { $regex: search, $options: 'i' }
      }).select('_id').lean();

      query.$or = [
        { quoteNo: { $regex: search, $options: 'i' } },
        { client: { $in: matchedClients.map(c => c._id) } }
      ];
    }

    const total = await Quote.countDocuments(query);
    const quotes = await Quote.find(query)
      .populate('client', 'name email phone gstin address placeOfSupply')
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
    const quote = await Quote.findById(req.params.id);
    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    if (quote.user.toString() !== req.user.id) return res.status(401).json({ message: 'Not authorized' });
    res.json(quote);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ─── CREATE quote ─────────────────────────────────────────────────────────────
exports.createQuote = async (req, res) => {
  try {
    const { clientRef, invoiceType, items, date, validUntil, shippingAddress, transport,
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
      if (quoteCount >= 15) {
        return res.status(403).json({ message: 'Free plan limit reached. You can only create 15 Quotes per month.' });
      }
    }
    // -------------------------------

    const counter = await Counter.findOneAndUpdate(
      { id: 'quoteNo' }, { $inc: { seq: 1 } }, { returnDocument: 'after', upsert: true }
    );
    const quoteNo = `QT-${counter.seq.toString().padStart(3, '0')}`;

    const client = await Client.findById(clientRef);
    if (!client) return res.status(404).json({ message: 'Client not found' });
    if (client.user.toString() !== req.user.id) return res.status(401).json({ message: 'Not authorized' });

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
    const clientState = placeOfSupply || client.billingAddress?.state || '';
    const isIntraState = clientState.trim().toLowerCase() === COMPANY_STATE.trim().toLowerCase();

    const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST } =
      processItems(items || [], isIntraState);

    const finalShipping = Number(shippingCharges) || 0;
    const finalPackaging = Number(packagingCharges) || 0;
    const finalDiscount = Number(discountTotal) || 0;
    const grandTotal = subTotal + taxTotal + finalShipping + finalPackaging - finalDiscount;

    const quote = new Quote({
      user: req.user._id, quoteNo, invoiceType: invoiceType || 'Tax Invoice',
      date, validUntil, paymentMode, paymentTerms,
      client: clientSnapshot, items: processedItems,
      subTotal, taxTotal, totalCGST, totalSGST, totalIGST,
      shippingCharges: finalShipping, packagingCharges: finalPackaging,
      customChargeLabel: customChargeLabel || 'Custom Amount',
      discountTotal: finalDiscount, grandTotal,
      status: status || 'DRAFT', shippingAddress, transport,
      placeOfSupply: clientState, reverseCharge: !!reverseCharge, notes, terms,
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
      placeOfSupply, paymentMode, paymentTerms, shippingCharges, packagingCharges,
      customChargeLabel, discountTotal, status, notes, terms, reverseCharge } = req.body;

    const quote = await Quote.findById(req.params.id);
    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    if (quote.user.toString() !== req.user.id) return res.status(401).json({ message: 'Not authorized' });

    // --- Subscription Plan Check for Edits ---
    const userObj = await User.findById(req.user._id);
    const plan = userObj?.subscription?.plan || 'free';
    
    if (plan === 'free') {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      
      const editedQuotesCount = await Quote.countDocuments({
        user: req.user._id,
        updatedAt: { $gte: startOfMonth },
        $expr: { $gt: ["$updatedAt", "$createdAt"] } 
      });

      let editedInvoicesCount = 0;
      try {
        const InvoiceModel = require('../models/Invoice');
        editedInvoicesCount = await InvoiceModel.countDocuments({
          user: req.user._id,
          updatedAt: { $gte: startOfMonth },
          $expr: { $gt: ["$updatedAt", "$createdAt"] }
        });
      } catch (e) {}
      
      const totalEditsThisMonth = editedInvoicesCount + editedQuotesCount;

      const isAlreadyEditedThisMonth = quote.updatedAt && quote.updatedAt >= startOfMonth && quote.updatedAt > quote.createdAt;

      if (totalEditsThisMonth >= 5 && !isAlreadyEditedThisMonth) {
        return res.status(403).json({ message: 'You have reached the free plan limit of 5 document edits per month. Please upgrade to Pro.' });
      }
    }
    // -----------------------------------------

    const client = await Client.findById(clientRef);
    if (!client) return res.status(404).json({ message: 'Client not found' });
    if (client.user.toString() !== req.user.id) return res.status(401).json({ message: 'Not authorized' });

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
    const clientState = placeOfSupply || client.billingAddress?.state || '';
    const isIntraState = clientState.trim().toLowerCase() === COMPANY_STATE.trim().toLowerCase();

    const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST } =
      processItems(items || [], isIntraState);

    const finalShipping = Number(shippingCharges) || 0;
    const finalPackaging = Number(packagingCharges) || 0;
    const finalDiscount = Number(discountTotal) || 0;
    const grandTotal = subTotal + taxTotal + finalShipping + finalPackaging - finalDiscount;

    Object.assign(quote, {
      invoiceType: invoiceType || quote.invoiceType,
      client: clientSnapshot, items: processedItems, date, validUntil,
      paymentMode, paymentTerms, subTotal, taxTotal, totalCGST, totalSGST, totalIGST,
      shippingCharges: finalShipping, packagingCharges: finalPackaging,
      customChargeLabel: customChargeLabel || 'Custom Amount',
      discountTotal: finalDiscount, grandTotal, shippingAddress, transport,
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
    const quote = await Quote.findById(req.params.id);
    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    if (quote.user.toString() !== req.user.id) return res.status(401).json({ message: 'Not authorized' });

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
    const quote = await Quote.findById(req.params.id);
    if (!quote) return res.status(404).json({ message: 'Quote not found' });
    if (quote.user.toString() !== req.user.id) return res.status(401).json({ message: 'Not authorized' });
    if (quote.status === 'CONVERTED') return res.status(400).json({ message: 'Already converted' });

    const counter = await Counter.findOneAndUpdate(
      { id: 'invoiceNo' }, { $inc: { seq: 1 } }, { returnDocument: 'after', upsert: true }
    );
    const invoiceNo = `INV-${counter.seq.toString().padStart(3, '0')}`;

    // Fetch fresh client data to ensure correct address format specially for old quotes
    const client = await Client.findById(quote.client.clientRef);
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

    const userSettings = await Settings.findOne({ user: req.user._id });
    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';
    const clientState = quote.placeOfSupply || clientSnapshot.address.state || '';
    const isIntraState = clientState.trim().toLowerCase() === COMPANY_STATE.trim().toLowerCase();

    const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST } = processItems(quote.items, isIntraState);

    const invoice = new Invoice({
      user: quote.user, invoiceNo, invoiceType: quote.invoiceType,
      date: new Date(), dueDate: quote.validUntil,
      paymentMode: quote.paymentMode, paymentTerms: quote.paymentTerms,
      client: clientSnapshot, items: processedItems,
      subTotal, taxTotal,
      totalCGST, totalSGST, totalIGST,
      shippingCharges: quote.shippingCharges, packagingCharges: quote.packagingCharges,
      customChargeLabel: quote.customChargeLabel, discountTotal: quote.discountTotal,
      grandTotal: quote.grandTotal, balanceDue: quote.grandTotal,
      shippingAddress: resolvedShipping, transport: quote.transport,
      placeOfSupply: quote.placeOfSupply, reverseCharge: quote.reverseCharge,
      notes: quote.notes, terms: quote.terms, status: 'DRAFT',
    });

    const savedInvoice = await invoice.save();
    quote.status = 'CONVERTED';
    quote.convertedToInvoice = savedInvoice._id;
    await quote.save();

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
      if (quoteCount + quotes.length > 15) {
        return res.status(403).json({ message: `Free plan limit reached. You can only create 15 Quotes per month. You currently have ${quoteCount} and are trying to add ${quotes.length}.` });
      }
    }
    // -------------------------------

    const userSettings = await Settings.findOne({ user: req.user._id });
    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';

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
      const isIntraState = clientState.trim().toLowerCase() === COMPANY_STATE.trim().toLowerCase();

      const counter = await Counter.findOneAndUpdate(
        { id: 'quoteNo' },
        { $inc: { seq: 1 } },
        { returnDocument: 'after', upsert: true }
      );
      const quoteNo = `QT-${counter.seq.toString().padStart(3, '0')}`;

      // quoteController processItems only takes two params: items, isIntraState
      const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST } =
        processItems(qData.items || [], isIntraState);

      const finalShipping = Number(qData.shippingCharges) || 0;
      const finalPackaging = Number(qData.packagingCharges) || 0;
      const finalDiscount = Number(qData.discountTotal) || 0;
      const grandTotal = subTotal + taxTotal + finalShipping + finalPackaging - finalDiscount;

      const quote = new Quote({
        ...qData,
        quoteNo,
        invoiceType: qData.invoiceType || 'Tax Invoice',
        clientRef: client._id,
        client: {
           clientRef: client._id,
           name: client.name,
           email: client.email,
           phone: client.phone,
           billingAddress: client.billingAddress || {},
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
