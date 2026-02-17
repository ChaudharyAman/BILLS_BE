const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const Item = require('../models/Item');
const Counter = require('../models/Counter');

// Get all invoices
exports.getInvoices = async (req, res) => {
  try {
    // Explicitly filter by user ID
    // Explicitly filter by user ID
    if (!req.user || !req.user._id) {
        console.log('Use not authorized (missing req.user)');
        return res.status(401).json({ message: 'Not authorized' });
    }
    console.log(`Fetching invoices for User ID: ${req.user._id}`);
    const invoices = await Invoice.find({ user: req.user._id }).sort({ createdAt: -1 });
    console.log(`Found ${invoices.length} invoices for this user.`);
    res.json(invoices);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Get single invoice
exports.getInvoiceById = async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
    
    // Check for user
    if (invoice.user.toString() !== req.user.id) {
        return res.status(401).json({ message: 'User not authorized' });
    }

    res.json(invoice);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Create a new invoice
exports.createInvoice = async (req, res) => {
  try {
    const { 
      clientRef, 
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
      radiusDiscount,
      advancePaid,
      balanceDue, 
    } = req.body;

    // Generate Invoice Number (Scoped globally for now, but ideally per user if needed)
    // For now, let's keep global sequence or we need UserCounter
    const counter = await Counter.findOneAndUpdate(
        { id: 'invoiceNo' },
        { $inc: { seq: 1 } },
        { returnDocument: 'after', upsert: true }
    );

    const invoiceNo = `INV-${counter.seq.toString().padStart(3, '0')}`;

    // 1. Fetch Client Snapshot
    const client = await Client.findById(clientRef);
    if (!client) return res.status(404).json({ message: 'Client not found' });
    
    // Check client user
    if (client.user.toString() !== req.user.id) {
        return res.status(401).json({ message: 'User not authorized to use this client' });
    }

    const clientSnapshot = {
      clientRef: client._id,
      name: client.name,
      address: client.address,
      gstin: client.gstin,
    };

    // 2. GST Logic
    const COMPANY_STATE = 'Delhi'; 
    const clientState = placeOfSupply || client.placeOfSupply || client.address?.state || '';
    
    const isIntraState = clientState.toLowerCase() === COMPANY_STATE.toLowerCase();

    // 3. Process Items & Calculate Totals
    let subTotal = 0;
    let totalCGST = 0;
    let totalSGST = 0;
    let totalIGST = 0;
    let taxTotal = 0;
    
    const processedItems = [];

    for (const item of items) {
      const qty = Number(item.qty) || 0;
      const rate = Number(item.rate) || 0;
      const discount = Number(item.discount) || 0;
      const taxRate = Number(item.taxRate) || 0;

      const taxableValue = (rate * qty) - discount;
      const totalItemTax = taxableValue * (taxRate / 100);
      
      let cgst = 0, sgst = 0, igst = 0;

      if (isIntraState) {
        cgst = totalItemTax / 2;
        sgst = totalItemTax / 2;
      } else {
        igst = totalItemTax;
      }

      const total = taxableValue + totalItemTax;

      subTotal += taxableValue;
      taxTotal += totalItemTax;
      totalCGST += cgst;
      totalSGST += sgst;
      totalIGST += igst;

      processedItems.push({
        itemRef: item.itemRef,
        name: item.name,
        description: item.description,
        hsnCode: item.hsnCode,
        qty,
        unit: item.unit,
        rate,
        discount,
        taxRate,
        taxAmount: totalItemTax,
        cgst,
        sgst,
        igst,
        amount: total,
      });
    }

    const finalShipping = Number(shippingCharges) || 0;
    const finalPackaging = Number(packagingCharges) || 0;
    const finalDiscountTotal = Number(discountTotal) || 0;
    
    const grandTotal = (subTotal + taxTotal + finalShipping + finalPackaging) - finalDiscountTotal;
    const finalAdvance = Number(advancePaid) || 0;
    const finalBalance = grandTotal - finalAdvance;

    const invoice = new Invoice({
      user: req.user._id,
      invoiceNo,
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
      totalIGST,
      shippingCharges: finalShipping,
      packagingCharges: finalPackaging,
      customChargeLabel,
      discountTotal: finalDiscountTotal,
      grandTotal,
      advancePaid: finalAdvance,
      balanceDue: finalBalance,
      status: 'DRAFT',
      shippingAddress,
      transport,
      bankDetails,
      placeOfSupply: clientState,
    });

    const newInvoice = await invoice.save();
    res.status(201).json(newInvoice);

  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Update Invoice
exports.updateInvoice = async (req, res) => {
  try {
    const { 
      clientRef, 
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
      // balanceDue, // Calculated
      status // Allow updating status if needed
    } = req.body;

    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
    
    // Check for user
    if (invoice.user.toString() !== req.user.id) {
        return res.status(401).json({ message: 'User not authorized' });
    }

    // 1. Fetch Client Snapshot (if client changed or just refresh it)
    const client = await Client.findById(clientRef);
    if (!client) return res.status(404).json({ message: 'Client not found' });
    
    // Check client user
    if (client.user.toString() !== req.user.id) {
        return res.status(401).json({ message: 'User not authorized to use this client' });
    }

    const clientSnapshot = {
      clientRef: client._id,
      name: client.name,
      address: client.address,
      gstin: client.gstin,
    };

    // 2. GST Logic
    const COMPANY_STATE = 'Delhi'; 
    const clientState = placeOfSupply || client.placeOfSupply || client.address?.state || '';
    const isIntraState = clientState.toLowerCase() === COMPANY_STATE.toLowerCase();

    // 3. Process Items & Calculate Totals
    let subTotal = 0;
    let totalCGST = 0;
    let totalSGST = 0;
    let totalIGST = 0;
    let taxTotal = 0;
    
    const processedItems = [];

    for (const item of items) {
      const qty = Number(item.qty) || 0;
      const rate = Number(item.rate) || 0;
      const discount = Number(item.discount) || 0;
      const taxRate = Number(item.taxRate) || 0;

      const taxableValue = (rate * qty) - discount;
      const totalItemTax = taxableValue * (taxRate / 100);
      
      let cgst = 0, sgst = 0, igst = 0;

      if (isIntraState) {
        cgst = totalItemTax / 2;
        sgst = totalItemTax / 2;
      } else {
        igst = totalItemTax;
      }

      const total = taxableValue + totalItemTax;

      subTotal += taxableValue;
      taxTotal += totalItemTax;
      totalCGST += cgst;
      totalSGST += sgst;
      totalIGST += igst;

      processedItems.push({
        itemRef: item.itemRef,
        name: item.name,
        description: item.description,
        hsnCode: item.hsnCode,
        qty,
        unit: item.unit,
        rate,
        discount,
        taxRate,
        taxAmount: totalItemTax,
        cgst,
        sgst,
        igst,
        amount: total,
      });
    }

    const finalShipping = Number(shippingCharges) || 0;
    const finalPackaging = Number(packagingCharges) || 0;
    const finalDiscountTotal = Number(discountTotal) || 0;
    
    const grandTotal = (subTotal + taxTotal + finalShipping + finalPackaging) - finalDiscountTotal;
    const finalAdvance = Number(advancePaid) || 0;
    const finalBalance = grandTotal - finalAdvance;

    // Update fields
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
    invoice.customChargeLabel = customChargeLabel;
    invoice.discountTotal = finalDiscountTotal;
    invoice.grandTotal = grandTotal;
    invoice.advancePaid = finalAdvance;
    invoice.balanceDue = finalBalance;
    invoice.shippingAddress = shippingAddress;
    invoice.transport = transport;
    invoice.bankDetails = bankDetails;
    invoice.placeOfSupply = clientState;
    
    if (status) invoice.status = status;

    const updatedInvoice = await invoice.save();
    res.json(updatedInvoice);

  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Delete Invoice
exports.deleteInvoice = async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
    
    // Check for user
    if (invoice.user.toString() !== req.user.id) {
        return res.status(401).json({ message: 'User not authorized' });
    }

    await invoice.deleteOne();
    res.json({ message: 'Invoice deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
