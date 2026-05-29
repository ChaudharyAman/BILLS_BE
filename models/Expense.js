const mongoose = require('mongoose');

const ExpenseItemSchema = new mongoose.Schema({
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

const ExpenseSchema = new mongoose.Schema({
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
  
  // Naming & Reference
  expenseNumber: { type: String, required: true },
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
  items: [ExpenseItemSchema],

  // Calcs
  subTotal: { type: Number, default: 0 },
  taxTotal: { type: Number, default: 0 },
  grandTotal: { type: Number, default: 0 },
  amountPaid: { type: Number, default: 0, min: 0 },
  balanceDue: { type: Number, default: 0, min: 0 },
  dueDate: Date,

  // Notes
  terms: String,
  privateNotes: String, // Specifically for Sleekbills feature

  status: {
    type: String,
    enum: ['DRAFT', 'PAID', 'PARTIAL', 'UNPAID', 'CANCELLED'],
    default: 'DRAFT',
  },
  tds_applicable: { type: Boolean, default: false },
  tds_section: { type: String, default: "" },
  tds_rate: { type: Number, default: 0 },
  tds_amount: { type: Number, default: 0 },
  tds_nature: { type: String, default: "deductor" },
  net_vendor_payment: { type: Number, default: 0 },

}, { timestamps: true });

// Compound unique index: same expense number is allowed across different users
ExpenseSchema.pre('save', async function() {
  const grandTotal = Number(this.grandTotal) || 0;
  const amountPaid = Math.round((Number(this.amountPaid) || 0) * 100) / 100;
  const taxTotal = Number(this.taxTotal) || 0;
  const tdsAmount = this.tds_applicable ? (Number(this.tds_amount) || 0) : 0;
  const basePayable = this.reverseCharge ? Math.max(grandTotal - taxTotal, 0) : grandTotal;
  const payableAmount = Math.round(Math.max(basePayable - tdsAmount, 0) * 100) / 100;
  
  if (amountPaid > payableAmount) {
    throw new Error('Amount paid cannot exceed payable amount');
  }
  this.amountPaid = amountPaid;
  this.balanceDue = Math.round(Math.max(payableAmount - amountPaid, 0) * 100) / 100;
  this.net_vendor_payment = Math.round(Math.max(basePayable - tdsAmount, 0) * 100) / 100;
});

ExpenseSchema.index({ user: 1, expenseNumber: 1 }, { unique: true });

module.exports = mongoose.model('Expense', ExpenseSchema);
