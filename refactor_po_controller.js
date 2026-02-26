const fs = require('fs');

let content = fs.readFileSync('./controllers/quoteController.js', 'utf8');

// Replacements
content = content.replace(/Quote/g, 'PurchaseOrder');
content = content.replace(/quote/g, 'purchaseOrder');
content = content.replace(/Quotes/g, 'PurchaseOrders');
content = content.replace(/quotes/g, 'purchaseOrders');
content = content.replace(/quoteNo/g, 'poNumber');
content = content.replace(/QT-/g, 'PO-');
content = content.replace(/client/g, 'vendor');
content = content.replace(/Client/g, 'VendorModel'); // We use VendorModel (which equals Client)

// Add the Ref Number, Private Notes and Advance Paid fields to destructuring and saving
content = content.replace(
  /const { vendorRef, invoiceType, items, date, validUntil, shippingAddress, transport,(.*?)\n(.*?)placeOfSupply, paymentMode, paymentTerms, shippingCharges, packagingCharges,(.*?)\n(.*?)customChargeLabel, discountTotal, status, notes, terms, reverseCharge } = req.body;/g,
  `const { vendorRef, refNumber, invoiceType, items, date, validUntil, shippingAddress, transport,
      placeOfSupply, paymentMode, paymentTerms, shippingCharges, packagingCharges, advancePaid,
      customChargeLabel, discountTotal, status, notes, privateNotes, terms, reverseCharge } = req.body;`
);

content = content.replace(
  /{ user: req.user._id, poNumber, invoiceType: invoiceType \|\| 'Tax Invoice',/g,
  `{ user: req.user._id, poNumber, refNumber, invoiceType: invoiceType || 'Tax Invoice', advancePaid: Number(advancePaid) || 0, privateNotes,`
);

content = content.replace(
  /reverseCharge: !!reverseCharge, notes, terms,/g,
  `reverseCharge: !!reverseCharge, notes, privateNotes, terms,`
);

content = content.replace(
  /const VendorModel = require\('\.\.\/models\/VendorModel'\);/g,
  `const VendorModel = require('../models/Client');` // vendor uses Client model
);

content = content.replace(
  /let vendor = await VendorModel\.findOne/g,
  `let vendor = await VendorModel.findOne`
);

// We should also remove convertToInvoice and bulkCreateQuotes from PO Controller for now as it doesn't make total sense for POs right now, or leave them (convert to Bill maybe). 
// But let's just write the modified content first.

fs.writeFileSync('./controllers/purchaseOrderController.js', content, 'utf8');
console.log('PurchaseOrder controller created');
