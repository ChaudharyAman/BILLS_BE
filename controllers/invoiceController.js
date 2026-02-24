const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const Item = require('../models/Item');
const Counter = require('../models/Counter');
const Settings = require('../models/Settings');

const User = require('../models/User');

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

    // --- Subscription Plan Check ---
    const userObj = await User.findById(req.user._id);
    const plan = userObj?.subscription?.plan || 'free';
    
    if (plan === 'free') {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const invoiceCount = await Invoice.countDocuments({
        user: req.user._id,
        createdAt: { $gte: startOfMonth }
      });
      if (invoiceCount >= 15) {
        return res.status(403).json({ message: 'Free plan limit reached. You can only create 15 Invoices/Proformas per month.' });
      }
    }
    // -------------------------------

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
    const userSettings = await Settings.findOne({ user: req.user._id });
    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';
    const clientState = placeOfSupply || client.placeOfSupply || client.billingAddress?.state || '';
    const isIntraState = clientState.trim().toLowerCase() === COMPANY_STATE.trim().toLowerCase();

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

    // --- Subscription Plan Check for Edits ---
    const userObj = await User.findById(req.user._id);
    const plan = userObj?.subscription?.plan || 'free';
    
    if (plan === 'free') {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      
      // Count documents edited this month (where updatedAt exists and is >= startOfMonth, 
      // and ideally where it's not just a brand new document, although simple >= startOfM works 
      // since creating counts against the 15 creation quota, and editing against the 5 edit quota)
      // Actually, to be precise, an "edit" is when a document is modified after creation.
      // Since Mongoose timestamps might set both to the same time on creation, 
      // we check if the document was updated after its creation time.
      const editedInvoicesCount = await Invoice.countDocuments({
        user: req.user._id,
        updatedAt: { $gte: startOfMonth },
        $expr: { $gt: ["$updatedAt", "$createdAt"] } 
      });

      const { Quote } = require('../models/Quote'); // We need to check quotes too for the global limit
      let editedQuotesCount = 0;
      try {
        const QuoteModel = require('../models/Quote');
        editedQuotesCount = await QuoteModel.countDocuments({
          user: req.user._id,
          updatedAt: { $gte: startOfMonth },
          $expr: { $gt: ["$updatedAt", "$createdAt"] }
        });
      } catch (e) {
         // ignore if model not loaded yet
      }
      
      const totalEditsThisMonth = editedInvoicesCount + editedQuotesCount;

      // If they have 5 or more, ONLY allow the edit IF they are editing a document 
      // that is ALREADY part of that 5 (i.e., this document was already edited this month).
      // Otherwise, they are trying to edit a 6th distinct document.
      const isAlreadyEditedThisMonth = invoice.updatedAt && invoice.updatedAt >= startOfMonth && invoice.updatedAt > invoice.createdAt;

      if (totalEditsThisMonth >= 5 && !isAlreadyEditedThisMonth) {
        return res.status(403).json({ message: 'You have reached the free plan limit of 5 document edits per month. Please upgrade to Pro.' });
      }
    }
    // -----------------------------------------

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

    const userSettings = await Settings.findOne({ user: req.user._id });
    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';
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

    // --- Subscription Plan Check for Deletes ---
    const userObj = await User.findById(req.user._id);
    const plan = userObj?.subscription?.plan || 'free';
    if (plan === 'free') {
       return res.status(403).json({ message: 'Free users cannot delete documents. Please upgrade to Pro.' });
    }
    // -------------------------------------------
    await invoice.deleteOne();
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
    const plan = userObj?.subscription?.plan || 'free';
    
    if (plan === 'free') {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const invoiceCount = await Invoice.countDocuments({
        user: req.user._id,
        createdAt: { $gte: startOfMonth }
      });
      if (invoiceCount + invoices.length > 15) {
        return res.status(403).json({ message: `Free plan limit reached. You can only create 15 Invoices/Proformas per month. You currently have ${invoiceCount} and are trying to add ${invoices.length}.` });
      }
    }
    // -------------------------------

    const userSettings = await Settings.findOne({ user: req.user._id });
    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';

    const createdInvoices = [];
    for (const invData of invoices) {
      let client = await Client.findOne({ name: invData.clientName, user: req.user._id });
      if (!client) {
         client = new Client({
            name: invData.clientName || 'Unknown Client',
            email: invData.clientEmail || '',
            phone: invData.clientPhone || '',
            billingAddress: { state: invData.clientState || '' },
            user: req.user._id
         });
         await client.save();
      }

      const clientState = invData.placeOfSupply || client.billingAddress?.state || '';
      const isIntraState = clientState.trim().toLowerCase() === COMPANY_STATE.trim().toLowerCase();

      const counter = await Counter.findOneAndUpdate(
        { id: 'invoiceNo' },
        { $inc: { seq: 1 } },
        { returnDocument: 'after', upsert: true }
      );
      const invoiceNo = `INV-${counter.seq.toString().padStart(3, '0')}`;

      const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST } =
        processItems(invData.items || [], invData.invoiceType || 'Tax Invoice', isIntraState);

      const finalShipping = Number(invData.shippingCharges) || 0;
      const finalPackaging = Number(invData.packagingCharges) || 0;
      const finalDiscount = Number(invData.discountTotal) || 0;
      const grandTotal = subTotal + taxTotal + finalShipping + finalPackaging - finalDiscount;
      const advancePaid = Number(invData.advancePaid) || 0;
      const balanceDue = grandTotal - advancePaid;

      const invoice = new Invoice({
        ...invData,
        invoiceNo,
        invoiceType: invData.invoiceType || 'Tax Invoice',
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
        discountTotal: finalDiscount, grandTotal, advancePaid, balanceDue,
        status: balanceDue <= 0 ? 'PAID' : 'DRAFT',
        user: req.user._id
      });
      
      const savedInvoice = await invoice.save();
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
      "client.clientRef": new require('mongoose').Types.ObjectId(clientId)
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
