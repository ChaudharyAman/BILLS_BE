const Quote = require('../models/Quote');
const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const Counter = require('../models/Counter');

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
    const quotes = await Quote.find({ user: req.user._id }).sort({ createdAt: -1 });
    res.json(quotes);
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

    const counter = await Counter.findOneAndUpdate(
      { id: 'quoteNo' }, { $inc: { seq: 1 } }, { returnDocument: 'after', upsert: true }
    );
    const quoteNo = `QT-${counter.seq.toString().padStart(3, '0')}`;

    const client = await Client.findById(clientRef);
    if (!client) return res.status(404).json({ message: 'Client not found' });
    if (client.user.toString() !== req.user.id) return res.status(401).json({ message: 'Not authorized' });

    const clientSnapshot = { clientRef: client._id, name: client.name, address: client.address, gstin: client.gstin };

    const COMPANY_STATE = process.env.COMPANY_STATE || 'Delhi';
    const clientState = placeOfSupply || client.address?.state || '';
    const isIntraState = clientState.toLowerCase() === COMPANY_STATE.toLowerCase();

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

    const client = await Client.findById(clientRef);
    if (!client) return res.status(404).json({ message: 'Client not found' });
    if (client.user.toString() !== req.user.id) return res.status(401).json({ message: 'Not authorized' });

    const clientSnapshot = { clientRef: client._id, name: client.name, address: client.address, gstin: client.gstin };

    const COMPANY_STATE = process.env.COMPANY_STATE || 'Delhi';
    const clientState = placeOfSupply || client.address?.state || '';
    const isIntraState = clientState.toLowerCase() === COMPANY_STATE.toLowerCase();

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

    const invoice = new Invoice({
      user: quote.user, invoiceNo, invoiceType: quote.invoiceType,
      date: new Date(), dueDate: quote.validUntil,
      paymentMode: quote.paymentMode, paymentTerms: quote.paymentTerms,
      client: quote.client, items: quote.items,
      subTotal: quote.subTotal, taxTotal: quote.taxTotal,
      totalCGST: quote.totalCGST, totalSGST: quote.totalSGST, totalIGST: quote.totalIGST,
      shippingCharges: quote.shippingCharges, packagingCharges: quote.packagingCharges,
      customChargeLabel: quote.customChargeLabel, discountTotal: quote.discountTotal,
      grandTotal: quote.grandTotal, balanceDue: quote.grandTotal,
      shippingAddress: quote.shippingAddress, transport: quote.transport,
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
