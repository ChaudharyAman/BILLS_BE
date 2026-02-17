const Invoice = require('../models/Invoice');
const Client = require('../models/Client');
const Item = require('../models/Item');
const Counter = require('../models/Counter');

// Get all invoices
exports.getInvoices = async (req, res) => {
  try {
    const invoices = await Invoice.find().sort({ createdAt: -1 });
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
      radiusDiscount, // "Add discount to all" logic handled frontend side usually, but passing simple value if needed
      advancePaid,
      balanceDue, 
    } = req.body;

    // Generate Invoice Number
    const counter = await Counter.findOneAndUpdate(
        { id: 'invoiceNo' },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
    );

    const invoiceNo = `INV-${counter.seq.toString().padStart(3, '0')}`;

    // 1. Fetch Client Snapshot
    const client = await Client.findById(clientRef);
    if (!client) return res.status(404).json({ message: 'Client not found' });

    const clientSnapshot = {
      clientRef: client._id,
      name: client.name,
      address: client.address,
      gstin: client.gstin,
    };

    // 2. GST Logic
    // Hardcoded Company State for now (TODO: Move to Config)
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

    // 1. Fetch Client Snapshot (if client changed or just refresh it)
    const client = await Client.findById(clientRef);
    if (!client) return res.status(404).json({ message: 'Client not found' });

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

    await invoice.deleteOne();
    res.json({ message: 'Invoice deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
