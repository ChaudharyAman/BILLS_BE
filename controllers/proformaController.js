const Proforma = require('../models/Proforma');
const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const Counter = require('../models/Counter');
const Settings = require('../models/Settings');

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

exports.getProformas = async (req, res) => {
  try {
    if (!req.user?._id) return res.status(401).json({ message: 'Not authorized' });
    const proformas = await Proforma.find({ user: req.user._id }).select('-items -notes -terms -shippingAddress').lean().sort({ createdAt: -1 });
    res.json(proformas);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.getProformaById = async (req, res) => {
  try {
    const proforma = await Proforma.findById(req.params.id);
    if (!proforma) return res.status(404).json({ message: 'Proforma not found' });
    if (proforma.user.toString() !== req.user.id) return res.status(401).json({ message: 'Not authorized' });
    res.json(proforma);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.createProforma = async (req, res) => {
  try {
    const { clientRef, invoiceType, items, date, validUntil, shippingAddress, transport,
      placeOfSupply, paymentMode, paymentTerms, shippingCharges, packagingCharges,
      customChargeLabel, discountTotal, status, notes, terms, reverseCharge } = req.body;

    const counter = await Counter.findOneAndUpdate(
      { id: 'proformaNo' }, { $inc: { seq: 1 } }, { returnDocument: 'after', upsert: true }
    );
    const proformaNo = `PRF-${counter.seq.toString().padStart(3, '0')}`;

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
    if (proforma.user.toString() !== req.user.id) return res.status(401).json({ message: 'Not authorized' });

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
    await proforma.deleteOne();
    res.json({ message: 'Proforma deleted' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.convertToInvoice = async (req, res) => {
  try {
    const proforma = await Proforma.findById(req.params.id);
    if (!proforma) return res.status(404).json({ message: 'Proforma not found' });
    if (proforma.user.toString() !== req.user.id) return res.status(401).json({ message: 'Not authorized' });
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
      const proformaNo = `PF-${counter.seq.toString().padStart(3, '0')}`;

      // processItems only takes two params: items, isIntraState
      const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST } =
        processItems(pData.items || [], isIntraState);

      const finalShipping = Number(pData.shippingCharges) || 0;
      const finalPackaging = Number(pData.packagingCharges) || 0;
      const finalDiscount = Number(pData.discountTotal) || 0;
      const grandTotal = subTotal + taxTotal + finalShipping + finalPackaging - finalDiscount;

      const proforma = new Proforma({
        ...pData,
        proformaNo,
        invoiceType: pData.invoiceType || 'Tax Invoice',
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
