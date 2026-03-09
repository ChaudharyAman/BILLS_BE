const PurchaseOrder = require('../models/PurchaseOrder');
const Invoice = require('../models/Invoice');
const VendorModel = require('../models/Client');
const Counter = require('../models/Counter');
const Settings = require('../models/Settings');
const escapeRegex = require('../utils/escapeRegex');

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

// ─── GET all purchaseOrders ───────────────────────────────────────────────────────────
exports.getPurchaseOrders = async (req, res) => {
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
        { poNumber: { $regex: safeSearch, $options: 'i' } },
        { 'vendor.vendorRef': { $in: matchedClients.map(c => c._id) } }
      ];
    }

    const total = await PurchaseOrder.countDocuments(query);
    const purchaseOrders = await PurchaseOrder.find(query)
      .select('-items -notes -terms -shippingAddress')
      .lean()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      data: purchaseOrders,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ─── GET single purchaseOrder ─────────────────────────────────────────────────────────
exports.getPurchaseOrderById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Purchase Order not found' });
    }
    const purchaseOrder = await PurchaseOrder.findById(req.params.id);
    if (!purchaseOrder) return res.status(404).json({ message: 'Purchase Order not found' });
    if (purchaseOrder.user.toString() !== req.user._id.toString()) return res.status(401).json({ message: 'Not authorized' });
    res.json(purchaseOrder);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ─── CREATE purchaseOrder ─────────────────────────────────────────────────────────────
exports.createPurchaseOrder = async (req, res) => {
  try {
    const { vendorRef, invoiceType, items, date, validUntil, shippingAddress, transport,
      placeOfSupply, paymentMode, paymentTerms, shippingCharges, packagingCharges,
      customChargeLabel, discountTotal, status, notes, privateNotes, terms, reverseCharge } = req.body;

    // --- Subscription Plan Check ---
    const userObj = await User.findById(req.user._id);
    const plan = userObj?.subscription?.plan || 'free';
    
    if (plan === 'free') {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const purchaseOrderCount = await PurchaseOrder.countDocuments({
        user: req.user._id,
        createdAt: { $gte: startOfMonth }
      });
      if (purchaseOrderCount >= 15) {
        return res.status(403).json({ message: 'Free plan limit reached. You can only create 15 PurchaseOrders per month.' });
      }
    }
    // -------------------------------

    const counter = await Counter.findOneAndUpdate(
      { id: 'purchaseOrderNo' }, { $inc: { seq: 1 } }, { returnDocument: 'after', upsert: true }
    );
    const poNumber = `PO-${counter.seq.toString().padStart(3, '0')}`;

    const vendor = await VendorModel.findById(vendorRef);
    if (!vendor) return res.status(404).json({ message: 'Vendor not found' });
    if (vendor.user.toString() !== req.user._id.toString()) return res.status(401).json({ message: 'Not authorized' });

    const vendorSnapshot = {
      vendorRef: vendor._id,
      name: vendor.name,
      address: {
        line1: vendor.billingAddress?.line1 || '',
        line2: vendor.billingAddress?.line2 || '',
        city: vendor.billingAddress?.city || '',
        state: vendor.billingAddress?.state || '',
        zip: vendor.billingAddress?.zip || '',
        country: vendor.billingAddress?.country || 'India',
      },
      gstin: vendor.gstin || '',
      phone: vendor.phone || '',
      email: vendor.email || '',
    };

    const userSettings = await Settings.findOne({ user: req.user._id });
    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';
    const vendorState = placeOfSupply || vendor.billingAddress?.state || '';
    const isIntraState = vendorState.trim().toLowerCase() === COMPANY_STATE.trim().toLowerCase();

    const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST } =
      processItems(items || [], isIntraState);

    const finalShipping = Number(shippingCharges) || 0;
    const finalPackaging = Number(packagingCharges) || 0;
    const finalDiscount = Number(discountTotal) || 0;
    const grandTotal = subTotal + taxTotal + finalShipping + finalPackaging - finalDiscount;

    const purchaseOrder = new PurchaseOrder({
      user: req.user._id, poNumber, invoiceType: invoiceType || 'Tax Invoice',
      date, validUntil, paymentMode, paymentTerms,
      vendor: vendorSnapshot, items: processedItems,
      subTotal, taxTotal, totalCGST, totalSGST, totalIGST,
      shippingCharges: finalShipping, packagingCharges: finalPackaging,
      customChargeLabel: customChargeLabel || 'Custom Amount',
      discountTotal: finalDiscount, grandTotal,
      status: status || 'DRAFT', shippingAddress, transport,
      placeOfSupply: vendorState, reverseCharge: !!reverseCharge, notes, privateNotes, terms,
    });

    const saved = await purchaseOrder.save();
    res.status(201).json(saved);
  } catch (e) {
    console.error('createPurchaseOrder error:', e);
    res.status(400).json({ message: e.message });
  }
};

// ─── UPDATE purchaseOrder ─────────────────────────────────────────────────────────────
exports.updatePurchaseOrder = async (req, res) => {
  try {
    const { vendorRef, invoiceType, items, date, validUntil, shippingAddress, transport,
      placeOfSupply, paymentMode, paymentTerms, shippingCharges, packagingCharges,
      customChargeLabel, discountTotal, status, notes, privateNotes, terms, reverseCharge } = req.body;

    const purchaseOrder = await PurchaseOrder.findById(req.params.id);
    if (!purchaseOrder) return res.status(404).json({ message: 'Purchase Order not found' });
    if (purchaseOrder.user.toString() !== req.user._id.toString()) return res.status(401).json({ message: 'Not authorized' });

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
      
      const editedPurchaseOrdersCount = await PurchaseOrder.countDocuments(conditions);

      let otherEditsCount = 0;
      try {
        const InvoiceModel = require('../models/Invoice');
        const ProformaModel = require('../models/Proforma');
        const QuoteModel = require('../models/Quote');
        const [inv, prf, qt] = await Promise.all([
          InvoiceModel.countDocuments(conditions),
          ProformaModel.countDocuments(conditions),
          QuoteModel.countDocuments(conditions)
        ]);
        otherEditsCount = inv + prf + qt;
      } catch (e) {}
      
      const totalEditsThisMonth = editedPurchaseOrdersCount + otherEditsCount;

      const isAlreadyEditedThisMonth = purchaseOrder.updatedAt && purchaseOrder.updatedAt >= startOfMonth && purchaseOrder.updatedAt > purchaseOrder.createdAt;

      if (totalEditsThisMonth >= 5 && !isAlreadyEditedThisMonth) {
        return res.status(403).json({ message: 'You have reached the free plan limit of 5 document edits per month. Please upgrade to Pro.' });
      }
    }
    // -----------------------------------------

    const vendor = await VendorModel.findById(vendorRef);
    if (!vendor) return res.status(404).json({ message: 'Vendor not found' });
    if (vendor.user.toString() !== req.user._id.toString()) return res.status(401).json({ message: 'Not authorized' });

    const vendorSnapshot = {
      vendorRef: vendor._id,
      name: vendor.name,
      address: {
        line1: vendor.billingAddress?.line1 || '',
        line2: vendor.billingAddress?.line2 || '',
        city: vendor.billingAddress?.city || '',
        state: vendor.billingAddress?.state || '',
        zip: vendor.billingAddress?.zip || '',
        country: vendor.billingAddress?.country || 'India',
      },
      gstin: vendor.gstin || '',
      phone: vendor.phone || '',
      email: vendor.email || '',
    };

    const userSettings = await Settings.findOne({ user: req.user._id });
    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';
    const vendorState = placeOfSupply || vendor.billingAddress?.state || '';
    const isIntraState = vendorState.trim().toLowerCase() === COMPANY_STATE.trim().toLowerCase();

    const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST } =
      processItems(items || [], isIntraState);

    const finalShipping = Number(shippingCharges) || 0;
    const finalPackaging = Number(packagingCharges) || 0;
    const finalDiscount = Number(discountTotal) || 0;
    const grandTotal = subTotal + taxTotal + finalShipping + finalPackaging - finalDiscount;

    Object.assign(purchaseOrder, {
      invoiceType: invoiceType || purchaseOrder.invoiceType,
      vendor: vendorSnapshot, items: processedItems, date, validUntil,
      paymentMode, paymentTerms, subTotal, taxTotal, totalCGST, totalSGST, totalIGST,
      shippingCharges: finalShipping, packagingCharges: finalPackaging,
      customChargeLabel: customChargeLabel || 'Custom Amount',
      discountTotal: finalDiscount, grandTotal, shippingAddress, transport,
      placeOfSupply: vendorState, reverseCharge: !!reverseCharge, notes, privateNotes, terms,
    });
    if (status) purchaseOrder.status = status;

    const saved = await purchaseOrder.save();
    res.json(saved);
  } catch (e) {
    console.error('updatePurchaseOrder error:', e);
    res.status(400).json({ message: e.message });
  }
};

// ─── DELETE purchaseOrder ─────────────────────────────────────────────────────────────
exports.deletePurchaseOrder = async (req, res) => {
  try {
    const purchaseOrder = await PurchaseOrder.findById(req.params.id);
    if (!purchaseOrder) return res.status(404).json({ message: 'Purchase Order not found' });
    if (purchaseOrder.user.toString() !== req.user._id.toString()) return res.status(401).json({ message: 'Not authorized' });

    // --- Subscription Plan Check for Deletes ---
    const userObj = await User.findById(req.user._id);
    const plan = userObj?.subscription?.plan || 'free';
    if (plan === 'free') {
       return res.status(403).json({ message: 'Free users cannot delete documents. Please upgrade to Pro.' });
    }
    // -------------------------------------------
    await purchaseOrder.deleteOne();
    res.json({ message: 'PurchaseOrder deleted' });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ─── CONVERT purchaseOrder → invoice ──────────────────────────────────────────────────
exports.convertToInvoice = async (req, res) => {
  try {
    const purchaseOrder = await PurchaseOrder.findById(req.params.id);
    if (!purchaseOrder) return res.status(404).json({ message: 'Purchase Order not found' });
    if (purchaseOrder.user.toString() !== req.user._id.toString()) return res.status(401).json({ message: 'Not authorized' });
    if (purchaseOrder.status === 'BILLED') return res.status(400).json({ message: 'Already converted to invoice' });

    const counter = await Counter.findOneAndUpdate(
      { id: 'invoiceNo' }, { $inc: { seq: 1 } }, { returnDocument: 'after', upsert: true }
    );
    const invoiceNo = `INV-${counter.seq.toString().padStart(3, '0')}`;

    // Fetch fresh vendor data to ensure correct address format specially for old purchaseOrders
    const vendor = await VendorModel.findById(purchaseOrder.vendor.vendorRef);
    let vendorSnapshot = purchaseOrder.vendor;
    let resolvedShipping = purchaseOrder.shippingAddress;

    if (vendor) {
      // Rebuild snapshot from fresh data
      vendorSnapshot = {
        vendorRef: vendor._id,
        name: vendor.name,
        address: {
          line1: vendor.billingAddress?.line1 || '',
          line2: vendor.billingAddress?.line2 || '',
          city: vendor.billingAddress?.city || '',
          state: vendor.billingAddress?.state || '',
          zip: vendor.billingAddress?.zip || '',
          country: vendor.billingAddress?.country || 'India',
        },
        gstin: vendor.gstin || '',
        phone: vendor.phone || '',
        email: vendor.email || '',
      };

      // Auto-resolve shipping address if missing in purchaseOrder
      if (!resolvedShipping?.line1 && vendor.shippingAddress?.line1) {
        resolvedShipping = {
          line1: vendor.shippingAddress.line1,
          line2: vendor.shippingAddress.line2 || '',
          city: vendor.shippingAddress.city || '',
          state: vendor.shippingAddress.state || '',
          zip: vendor.shippingAddress.zip || '',
          country: vendor.shippingAddress.country || 'India',
        };
      }
    }

    const userSettings = await Settings.findOne({ user: req.user._id });
    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';
    const vendorState = purchaseOrder.placeOfSupply || vendorSnapshot.address.state || '';
    const isIntraState = vendorState.trim().toLowerCase() === COMPANY_STATE.trim().toLowerCase();

    const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST } = processItems(purchaseOrder.items, isIntraState);

    const invoice = new Invoice({
      user: purchaseOrder.user, invoiceNo, invoiceType: purchaseOrder.invoiceType,
      date: new Date(), dueDate: purchaseOrder.validUntil,
      paymentMode: purchaseOrder.paymentMode, paymentTerms: purchaseOrder.paymentTerms,
      client: vendorSnapshot, items: processedItems,
      subTotal, taxTotal,
      totalCGST, totalSGST, totalIGST,
      shippingCharges: purchaseOrder.shippingCharges, packagingCharges: purchaseOrder.packagingCharges,
      customChargeLabel: purchaseOrder.customChargeLabel, discountTotal: purchaseOrder.discountTotal,
      grandTotal: purchaseOrder.grandTotal, balanceDue: purchaseOrder.grandTotal,
      shippingAddress: resolvedShipping, transport: purchaseOrder.transport,
      placeOfSupply: purchaseOrder.placeOfSupply, reverseCharge: purchaseOrder.reverseCharge,
      notes: purchaseOrder.notes, terms: purchaseOrder.terms, status: 'DRAFT',
    });

    const savedInvoice = await invoice.save();
    purchaseOrder.status = 'BILLED';
    purchaseOrder.convertedToInvoice = savedInvoice._id;
    await purchaseOrder.save();

    res.status(201).json({ invoice: savedInvoice, purchaseOrder });
  } catch (e) {
    console.error('convertToInvoice error:', e);
    res.status(400).json({ message: e.message });
  }
};

// ─── BULK create purchaseOrders ───────────────────────────────────────────────────
exports.bulkCreatePurchaseOrders = async (req, res) => {
  try {
    const purchaseOrders = req.body.purchaseOrders;
    if (!Array.isArray(purchaseOrders) || purchaseOrders.length === 0) {
      return res.status(400).json({ message: 'No purchaseOrders provided for bulk creation.' });
    }

    // --- Subscription Plan Check ---
    const userObj = await User.findById(req.user._id);
    const plan = userObj?.subscription?.plan || 'free';
    
    if (plan === 'free') {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const purchaseOrderCount = await PurchaseOrder.countDocuments({
        user: req.user._id,
        createdAt: { $gte: startOfMonth }
      });
      if (purchaseOrderCount + purchaseOrders.length > 15) {
        return res.status(403).json({ message: `Free plan limit reached. You can only create 15 PurchaseOrders per month. You currently have ${purchaseOrderCount} and are trying to add ${purchaseOrders.length}.` });
      }
    }
    // -------------------------------

    const userSettings = await Settings.findOne({ user: req.user._id });
    const COMPANY_STATE = userSettings?.address?.state || process.env.COMPANY_STATE || 'Delhi';

    const createdPurchaseOrders = [];
    for (const qData of purchaseOrders) {
      let vendor = await VendorModel.findOne({ name: qData.vendorName, user: req.user._id, isVendor: true });
      if (!vendor) {
         vendor = new VendorModel({
            name: qData.vendorName || 'Unknown Vendor',
            email: qData.vendorEmail || '',
            phone: qData.vendorPhone || '',
            billingAddress: { state: qData.vendorState || '' },
            user: req.user._id,
            isVendor: true,
            isClient: false
         });
         await vendor.save();
      }

      const vendorState = qData.placeOfSupply || vendor.billingAddress?.state || '';
      const isIntraState = vendorState.trim().toLowerCase() === COMPANY_STATE.trim().toLowerCase();

      const counter = await Counter.findOneAndUpdate(
        { id: 'purchaseOrderNo' },
        { $inc: { seq: 1 } },
        { returnDocument: 'after', upsert: true }
      );
      const poNumber = `PO-${counter.seq.toString().padStart(3, '0')}`;

      // purchaseOrderController processItems only takes two params: items, isIntraState
      const { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST } =
        processItems(qData.items || [], isIntraState);

      const finalShipping = Number(qData.shippingCharges) || 0;
      const finalPackaging = Number(qData.packagingCharges) || 0;
      const finalDiscount = Number(qData.discountTotal) || 0;
      const grandTotal = subTotal + taxTotal + finalShipping + finalPackaging - finalDiscount;

      const purchaseOrder = new PurchaseOrder({
        poNumber,
        invoiceType: qData.invoiceType || 'Tax Invoice',
        date: qData.date || new Date(),
        validUntil: qData.validUntil || new Date(),
        paymentMode: qData.paymentMode || 'Cash',
        paymentTerms: qData.paymentTerms || '',
        shippingAddress: qData.shippingAddress,
        transport: qData.transport,
        placeOfSupply: qData.placeOfSupply || vendorState,
        reverseCharge: !!qData.reverseCharge,
        customChargeLabel: qData.customChargeLabel || 'Custom Amount',
        notes: qData.notes || '',
        privateNotes: qData.privateNotes || '',
        terms: qData.terms || '',
        vendorRef: vendor._id,
        vendor: {
           vendorRef: vendor._id,
           name: vendor.name,
           email: vendor.email,
           phone: vendor.phone,
           billingAddress: vendor.billingAddress || {},
           gstin: vendor.gstin || '',
        },
        items: processedItems,
        subTotal, taxTotal, totalCGST, totalSGST, totalIGST,
        shippingCharges: finalShipping, packagingCharges: finalPackaging,
        discountTotal: finalDiscount, grandTotal,
        status: 'DRAFT',
        user: req.user._id
      });
      
      const savedPurchaseOrder = await purchaseOrder.save();
      createdPurchaseOrders.push(savedPurchaseOrder);
    }

    res.status(201).json({ message: `Successfully imported ${createdPurchaseOrders.length} purchaseOrders.`, count: createdPurchaseOrders.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
