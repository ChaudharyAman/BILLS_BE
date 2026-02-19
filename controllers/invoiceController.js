const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const Item = require('../models/Item');
const Counter = require('../models/Counter');

// ─── Shared: process items based on invoice type ──────────────────────────────
function processItems(items, invoiceType, isIntraState) {
  const hasTax = invoiceType === 'Tax Invoice' || invoiceType === 'Excise Invoice';
  const hasExcise = invoiceType === 'Excise Invoice';

  let subTotal = 0, totalCGST = 0, totalSGST = 0, totalIGST = 0, taxTotal = 0, totalExcise = 0;
  const processedItems = [];

  for (const item of items) {
    const qty = Number(item.qty) || 0;
    const rate = Number(item.rate) || 0;
    const discountPct = Number(item.discount) || 0; // discount is a PERCENTAGE

    const taxableValue = qty * rate * (1 - discountPct / 100);

    let cgst = 0, sgst = 0, igst = 0, itemTax = 0;
    if (hasTax) {
      const taxRate = Number(item.taxRate) || 0;
      itemTax = taxableValue * (taxRate / 100);
      if (isIntraState) {
        cgst = itemTax / 2;
        sgst = itemTax / 2;
      } else {
        igst = itemTax;
      }
    }

    let exciseAmount = 0;
    if (hasExcise) {
      const bed = taxableValue * (Number(item.bedPercent) / 100 || 0);
      const sed = taxableValue * (Number(item.sedPercent) / 100 || 0);
      const cess = (bed + sed) * (Number(item.cessPercent) / 100 || 0);
      exciseAmount = bed + sed + cess;
    }

    const total = taxableValue + itemTax + exciseAmount;

    subTotal += taxableValue;
    taxTotal += itemTax;
    totalCGST += cgst;
    totalSGST += sgst;
    totalIGST += igst;
    totalExcise += exciseAmount;

    processedItems.push({
      itemRef: item.itemRef,
      name: item.name,
      description: item.description,
      hsnCode: item.hsnCode,
      qty,
      unit: item.unit,
      rate,
      discount: discountPct,
      taxRate: Number(item.taxRate) || 0,
      taxAmount: itemTax,
      cgst,
      sgst,
      igst,
      // Excise per-item fields stored as metadata
      bedPercent: Number(item.bedPercent) || 0,
      sedPercent: Number(item.sedPercent) || 0,
      cessPercent: Number(item.cessPercent) || 0,
      exciseAmount,
      amount: total,
    });
  }

  return { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST, totalExcise };
}

// ─── GET all invoices ─────────────────────────────────────────────────────────
exports.getInvoices = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ message: 'Not authorized' });
    }
    const invoices = await Invoice.find({ user: req.user._id }).sort({ createdAt: -1 });
    res.json(invoices);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─── GET single invoice ───────────────────────────────────────────────────────
exports.getInvoiceById = async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
    if (invoice.user.toString() !== req.user.id) {
      return res.status(401).json({ message: 'User not authorized' });
    }
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
    } = req.body;

    // Generate Invoice Number
    const counter = await Counter.findOneAndUpdate(
      { id: 'invoiceNo' },
      { $inc: { seq: 1 } },
      { returnDocument: 'after', upsert: true }
    );
    const invoiceNo = `INV-${counter.seq.toString().padStart(3, '0')}`;

    // Fetch Client Snapshot
    const client = await Client.findById(clientRef);
    if (!client) return res.status(404).json({ message: 'Client not found' });
    if (client.user.toString() !== req.user.id) {
      return res.status(401).json({ message: 'User not authorized to use this client' });
    }

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

    // GST intra/inter state logic
    const COMPANY_STATE = process.env.COMPANY_STATE || 'Delhi';
    const clientState = placeOfSupply || client.placeOfSupply || client.billingAddress?.state || '';
    const isIntraState = clientState.toLowerCase() === COMPANY_STATE.toLowerCase();

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

    // Process items
    const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST, totalExcise } =
      processItems(items || [], invoiceType, isIntraState);

    const finalShipping = Number(shippingCharges) || 0;
    const finalPackaging = Number(packagingCharges) || 0;
    const finalDiscountTotal = Number(discountTotal) || 0;
    const grandTotal = subTotal + taxTotal + totalExcise + finalShipping + finalPackaging - finalDiscountTotal;
    const finalAdvance = Number(advancePaid) || 0;
    const finalBalance = Math.max(0, grandTotal - finalAdvance);

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
      notes,
      terms,
      exciseDuty: exciseDuty || {},
    });

    const newInvoice = await invoice.save();
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
    } = req.body;

    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
    if (invoice.user.toString() !== req.user.id) {
      return res.status(401).json({ message: 'User not authorized' });
    }

    // Fetch Client Snapshot
    const client = await Client.findById(clientRef);
    if (!client) return res.status(404).json({ message: 'Client not found' });
    if (client.user.toString() !== req.user.id) {
      return res.status(401).json({ message: 'User not authorized to use this client' });
    }

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

    const COMPANY_STATE = process.env.COMPANY_STATE || 'Delhi';
    const clientState = placeOfSupply || client.placeOfSupply || client.billingAddress?.state || '';
    const isIntraState = clientState.toLowerCase() === COMPANY_STATE.toLowerCase();

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
    const grandTotal = subTotal + taxTotal + totalExcise + finalShipping + finalPackaging - finalDiscountTotal;
    const finalAdvance = Number(advancePaid) || 0;
    const finalBalance = Math.max(0, grandTotal - finalAdvance);

    // Apply updates
    invoice.invoiceType = effectiveType;
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
    invoice.notes = notes;
    invoice.terms = terms;
    invoice.exciseDuty = exciseDuty || invoice.exciseDuty || {};
    if (status) invoice.status = status;

    const updatedInvoice = await invoice.save();
    res.json(updatedInvoice);

  } catch (error) {
    console.error('updateInvoice error:', error);
    res.status(400).json({ message: error.message });
  }
};

// ─── DELETE invoice ───────────────────────────────────────────────────────────
exports.deleteInvoice = async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
    if (invoice.user.toString() !== req.user.id) {
      return res.status(401).json({ message: 'User not authorized' });
    }
    await invoice.deleteOne();
    res.json({ message: 'Invoice deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
