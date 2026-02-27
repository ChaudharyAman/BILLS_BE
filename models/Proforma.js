const mongoose = require('mongoose');

const ProformaItemSchema = new mongoose.Schema({
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

const ProformaSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  proformaNo: { type: String, required: true, unique: true },
  invoiceType: {
    type: String,
    enum: ['Invoice', 'Retail Invoice', 'Tax Invoice', 'Excise Invoice'],
    default: 'Tax Invoice',
  },
  date: { type: Date, default: Date.now, required: true },
  validUntil: Date,
  paymentMode: String,
  paymentTerms: String,

  client: {
    clientRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Client' },
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

  items: [ProformaItemSchema],

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

  status: {
    type: String,
    enum: ['DRAFT', 'SENT', 'CONFIRMED', 'CONVERTED'],
    default: 'DRAFT',
  },

  convertedToInvoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },

  notes: String,
  terms: String,
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Proforma', ProformaSchema);
