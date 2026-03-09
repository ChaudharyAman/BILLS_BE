const Proforma = require('../models/Proforma');
const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const Counter = require('../models/Counter');
const Settings = require('../models/Settings');
const escapeRegex = require('../utils/escapeRegex');
const User = require('../models/User');
const mongoose = require('mongoose');

function processItems(items, isIntraState) {
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

exports.getProformas = async (req, res) => {
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
        { proformaNo: { $regex: safeSearch, $options: 'i' } },
        { 'client.clientRef': { $in: matchedClients.map(c => c._id) } }
      ];
    }

    const total = await Proforma.countDocuments(query);
    const proformas = await Proforma.find(query)
      .select('-items -notes -terms -shippingAddress')
      .lean()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      data: proformas,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.getProformaById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Proforma not found' });
    }
    const proforma = await Proforma.findById(req.params.id);
    if (!proforma) return res.status(404).json({ message: 'Proforma not found' });
    if (proforma.user.toString() !== req.user._id.toString()) return res.status(401).json({ message: 'Not authorized' });
    res.json(proforma);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.createProforma = async (req, res) => {
  try {
    const { clientRef, invoiceType, items, date, validUntil, shippingAddress, transport,
      placeOfSupply, paymentMode, paymentTerms, shippingCharges, packagingCharges,
      customChargeLabel, discountTotal, status, notes, terms, reverseCharge } = req.body;

    // --- Subscription Plan Check (BEFORE counter increment to avoid wasting sequence numbers) ---
    const userObj = await User.findById(req.user._id);
    const plan = userObj?.subscription?.plan || 'free';
    if (plan === 'free') {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const proformaCount = await Proforma.countDocuments({
        user: req.user._id,
        createdAt: { $gte: startOfMonth }
      });
      let quoteCount = 0;
      try {
        const QuoteModel = require('../models/Quote');
        quoteCount = await QuoteModel.countDocuments({ user: req.user._id, createdAt: { $gte: startOfMonth } });
      } catch(e) {}
      if (quoteCount + proformaCount >= 15) {
        return res.status(403).json({ message: 'Free plan limit reached. You can only create 15 Quotes & Proformas per month. Please upgrade to Pro.' });
      }
    }
    // -------------------------------

    const counter = await Counter.findOneAndUpdate(
      { id: 'proformaNo' }, { $inc: { seq: 1 } }, { returnDocument: 'after', upsert: true }
    );
    const proformaNo = `PRF-${counter.seq.toString().padStart(3, '0')}`;

    const client = await Client.findById(clientRef);
    if (!client) return res.status(404).json({ message: 'Client not found' });
    if (client.user.toString() !== req.user._id.toString()) return res.status(401).json({ message: 'Not authorized' });

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

    const proforma = new Proforma({
      user: req.user._id, proformaNo, invoiceType: invoiceType || 'Tax Invoice',
      date, validUntil, paymentMode, paymentTerms,
      client: clientSnapshot, items: processedItems,
      subTotal, taxTotal, totalCGST, totalSGST, totalIGST,
      shippingCharges: finalShipping, packagingCharges: finalPackaging,
      customChargeLabel: customChargeLabel || 'Custom Amount',
      discountTotal: finalDiscount, grandTotal,
      status: status || 'DRAFT', shippingAddress, transport,
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
    const { clientRef, invoiceType, items, date, validUntil, shippingAddress, transport,
      placeOfSupply, paymentMode, paymentTerms, shippingCharges, packagingCharges,
      customChargeLabel, discountTotal, status, notes, terms, reverseCharge } = req.body;

    const proforma = await Proforma.findById(req.params.id);
    if (!proforma) return res.status(404).json({ message: 'Proforma not found' });
    if (proforma.user.toString() !== req.user._id.toString()) return res.status(401).json({ message: 'Not authorized' });

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

    const client = await Client.findById(clientRef);
    if (!client) return res.status(404).json({ message: 'Client not found' });
    if (client.user.toString() !== req.user._id.toString()) return res.status(401).json({ message: 'Not authorized' });

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

    Object.assign(proforma, {
      invoiceType: invoiceType || proforma.invoiceType,
      client: clientSnapshot, items: processedItems, date, validUntil,
      paymentMode, paymentTerms, subTotal, taxTotal, totalCGST, totalSGST, totalIGST,
      shippingCharges: finalShipping, packagingCharges: finalPackaging,
      customChargeLabel: customChargeLabel || 'Custom Amount',
      discountTotal: finalDiscount, grandTotal, shippingAddress, transport,
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
    const proforma = await Proforma.findById(req.params.id);
    if (!proforma) return res.status(404).json({ message: 'Proforma not found' });
    if (proforma.user.toString() !== req.user.id) return res.status(401).json({ message: 'Not authorized' });
    
    // --- Subscription Check ---
    const userObj = await User.findById(req.user._id);
    if (userObj?.subscription?.plan === 'free') {
       return res.status(403).json({ message: 'Free users cannot delete documents. Please upgrade to Pro.' });
    }
    // --------------------------

    await proforma.deleteOne();
    res.json({ message: 'Proforma deleted' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.convertToInvoice = async (req, res) => {
  try {
    const proforma = await Proforma.findById(req.params.id);
    if (!proforma) return res.status(404).json({ message: 'Proforma not found' });
    if (proforma.user.toString() !== req.user._id.toString()) return res.status(401).json({ message: 'Not authorized' });
    if (proforma.status === 'CONVERTED') return res.status(400).json({ message: 'Already converted' });

    const counter = await Counter.findOneAndUpdate(
      { id: 'invoiceNo' }, { $inc: { seq: 1 } }, { returnDocument: 'after', upsert: true }
    );
    const invoiceNo = `INV-${counter.seq.toString().padStart(3, '0')}`;

    // Fetch fresh client data to ensure correct address format specially for old proformas
    const client = await Client.findById(proforma.client.clientRef);
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

    const userSettings = await Settings.findOne({ user: req.user._id });
    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';
    const clientState = proforma.placeOfSupply || clientSnapshot.address.state || '';
    const isIntraState = clientState.trim().toLowerCase() === COMPANY_STATE.trim().toLowerCase();

    const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST } = processItems(proforma.items, isIntraState);

    const invoice = new Invoice({
      user: proforma.user, invoiceNo, invoiceType: proforma.invoiceType,
      date: new Date(), dueDate: proforma.validUntil,
      paymentMode: proforma.paymentMode, paymentTerms: proforma.paymentTerms,
      client: clientSnapshot, items: processedItems,
      subTotal, taxTotal,
      totalCGST, totalSGST, totalIGST,
      shippingCharges: proforma.shippingCharges, packagingCharges: proforma.packagingCharges,
      customChargeLabel: proforma.customChargeLabel, discountTotal: proforma.discountTotal,
      grandTotal: proforma.grandTotal, balanceDue: proforma.grandTotal,
      shippingAddress: resolvedShipping, transport: proforma.transport,
      placeOfSupply: proforma.placeOfSupply, reverseCharge: proforma.reverseCharge,
      notes: proforma.notes, terms: proforma.terms, status: 'DRAFT',
    });

    const savedInvoice = await invoice.save();
    proforma.status = 'CONVERTED';
    proforma.convertedToInvoice = savedInvoice._id;
    await proforma.save();

    res.status(201).json({ invoice: savedInvoice, proforma });
  } catch (e) {
    console.error('convertToInvoice error:', e);
    res.status(400).json({ message: e.message });
  }
};

// ─── BULK create proformas ───────────────────────────────────────────────────
exports.bulkCreateProformas = async (req, res) => {
  try {
    const proformas = req.body.proformas;
    if (!Array.isArray(proformas) || proformas.length === 0) {
      return res.status(400).json({ message: 'No proformas provided for bulk creation.' });
    }

    // --- Subscription Plan Check ---
    const userObj = await User.findById(req.user._id);
    const plan = userObj?.subscription?.plan || 'free';
    if (plan === 'free') {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const proformaCount = await Proforma.countDocuments({
        user: req.user._id,
        createdAt: { $gte: startOfMonth }
      });
      let quoteCount = 0;
      try {
        const QuoteModel = require('../models/Quote');
        quoteCount = await QuoteModel.countDocuments({ user: req.user._id, createdAt: { $gte: startOfMonth } });
      } catch(e) {}
      
      const combined = proformaCount + quoteCount;
      if (combined + proformas.length > 15) {
        return res.status(403).json({ message: `Free plan limit reached. You can only create 15 Quotes & Proformas per month. You currently have ${combined} and are trying to add ${proformas.length}.` });
      }
    }
    // -------------------------------

    const userSettings = await Settings.findOne({ user: req.user._id });
    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';

    const createdProformas = [];
    for (const pData of proformas) {
      let client = await Client.findOne({ name: pData.clientName, user: req.user._id });
      if (!client) {
         client = new Client({
            name: pData.clientName || 'Unknown Client',
            email: pData.clientEmail || '',
            phone: pData.clientPhone || '',
            billingAddress: { state: pData.clientState || '' },
            user: req.user._id
         });
         await client.save();
      }

      const clientState = pData.placeOfSupply || client.billingAddress?.state || '';
      const isIntraState = clientState.trim().toLowerCase() === COMPANY_STATE.trim().toLowerCase();

      const counter = await Counter.findOneAndUpdate(
        { id: 'proformaNo' },
        { $inc: { seq: 1 } },
        { returnDocument: 'after', upsert: true }
      );
      const proformaNo = `PRF-${counter.seq.toString().padStart(3, '0')}`;

      // processItems only takes two params: items, isIntraState
      const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST } =
        processItems(pData.items || [], isIntraState);

      const finalShipping = Number(pData.shippingCharges) || 0;
      const finalPackaging = Number(pData.packagingCharges) || 0;
      const finalDiscount = Number(pData.discountTotal) || 0;
      const grandTotal = subTotal + taxTotal + finalShipping + finalPackaging - finalDiscount;

      const proforma = new Proforma({
        proformaNo,
        invoiceType: pData.invoiceType || 'Tax Invoice',
        date: pData.date || new Date(),
        validUntil: pData.validUntil || new Date(),
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
      
      const savedProforma = await proforma.save();
      createdProformas.push(savedProforma);
    }

    res.status(201).json({ message: `Successfully imported ${createdProformas.length} proformas.`, count: createdProformas.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
