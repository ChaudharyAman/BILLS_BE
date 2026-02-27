const mongoose = require('mongoose');

const PurchaseOrderItemSchema = new mongoose.Schema({
  itemRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Item' },
  name: { type: String, required: true },
  description: String,
  hsnCode: String,
  qty: { type: Number, required: true, min: 0 },
  unit: String,
  rate: { type: Number, required: true, min: 0 },
  discount: { type: Number, default: 0 },
  taxRate: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  cgst: { type: Number, default: 0 },
  sgst: { type: Number, default: 0 },
  igst: { type: Number, default: 0 },
  amount: { type: Number, required: true },
});

const PurchaseOrderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  poNumber: { type: String, required: true, unique: true },
  refNumber: String,
  date: { type: Date, default: Date.now, required: true },
  validUntil: Date,  // Validity / expiry date
  paymentMode: String,
  paymentTerms: String,

  vendor: {
    vendorRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Client' },
    name: { type: String, required: true },
    address: {
      line1: String, line2: String, city: String, state: String, zip: String,
    },
    gstin: String,
  },

  shippingAddress: {
    line1: String, line2: String, city: String, state: String, zip: String,
  },

  transport: {
    mode: String,
    vehicleNumber: String,
    poNumber: String,
    poDate: Date,
    eWayBillNo: String,
  },

  placeOfSupply: String,
  reverseCharge: { type: Boolean, default: false },

  items: [PurchaseOrderItemSchema],

  subTotal: { type: Number, default: 0 },
  taxTotal: { type: Number, default: 0 },
  totalCGST: { type: Number, default: 0 },
  totalSGST: { type: Number, default: 0 },
  totalIGST: { type: Number, default: 0 },

  shippingCharges: { type: Number, default: 0 },
  packagingCharges: { type: Number, default: 0 },
  customChargeLabel: { type: String, default: 'Custom Amount' },
  discountTotal: { type: Number, default: 0 },
  grandTotal: { type: Number, default: 0 },
  advancePaid: { type: Number, default: 0 },

  status: {
    type: String,
    enum: ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'BILLED', 'CANCELLED'],
    default: 'DRAFT',
  },

  notes: String,
  privateNotes: String, // Addition for private notes not shown to vendor
  terms: String,
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('PurchaseOrder', PurchaseOrderSchema);
