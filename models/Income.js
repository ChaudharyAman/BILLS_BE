const mongoose = require('mongoose');
const softDeletePlugin = require('../middleware/softDeletePlugin');

const IncomeItemSchema = new mongoose.Schema({
  itemRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Item' },
  name: { type: String, required: true },
  description: String,
  qty: { type: Number, required: true, min: 0 },
  unit: String,
  rate: { type: Number, required: true, min: 0 },
  taxRate: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  amount: { type: Number, required: true },
});

const IncomeSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User', index: true },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
    default: null,
    index: true,
  },
  subCategory: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
    default: null,
  },
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null, index: true },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
  sourceType: {
    type: String,
    enum: ['manual', 'invoice'],
    default: 'manual',
  },
  sourceInvoice: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice',
    default: null,
  },
  
  // Naming & Reference
  incomeNumber: { type: String, required: true },
  date: { type: Date, default: Date.now, required: true },
  
  // Parties involved
  vendor: {
    vendorRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Client' }, // Stored as a client theoretically or a Vendor
    name: { type: String },
  },
  client: {
    clientRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Client' },
    name: { type: String },
  },

  // Logistics
  paymentMethod: String,
  reverseCharge: { type: Boolean, default: false },

  // Items
  items: [IncomeItemSchema],

  // Calcs
  subTotal: { type: Number, default: 0 },
  taxTotal: { type: Number, default: 0 },
  totalCGST: { type: Number, default: 0 },
  totalSGST: { type: Number, default: 0 },
  totalIGST: { type: Number, default: 0 },
  grandTotal: { type: Number, default: 0 },

  // Notes
  terms: String,
  privateNotes: String, // Specifically for Sleekbills feature

  placeOfSupply: { type: String, default: "" },

  status: {
    type: String,
    enum: ['DRAFT', 'PAID', 'PARTIAL', 'UNPAID', 'CANCELLED'],
    default: 'DRAFT',
  },

  tds_applicable: { type: Boolean, default: false },
  tds_section: { type: String, default: "" },
  tds_rate: { type: Number, default: 0 },
  tds_amount: { type: Number, default: 0 },
  net_received_payment: { type: Number, default: 0 },
  amountPaid: { type: Number, default: 0 },
  balanceDue: { type: Number, default: 0 },

}, { timestamps: true });

IncomeSchema.pre('save', function() {
  const basePayable = this.grandTotal || 0;
  const tdsAmt = this.tds_applicable ? (this.tds_amount || 0) : 0;
  this.net_received_payment = Math.round(Math.max(basePayable - tdsAmt, 0) * 100) / 100;
  this.balanceDue = Math.round(Math.max(this.net_received_payment - (this.amountPaid || 0), 0) * 100) / 100;
});

// Compound unique index: same income number is allowed across different users
IncomeSchema.index({ user: 1, incomeNumber: 1 }, { unique: true });
IncomeSchema.index({ user: 1, sourceInvoice: 1 }, { unique: true, sparse: true });

IncomeSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Income', IncomeSchema);
