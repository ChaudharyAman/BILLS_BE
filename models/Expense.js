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

}, { timestamps: true });

// Compound unique index: same expense number is allowed across different users
ExpenseSchema.index({ user: 1, expenseNumber: 1 }, { unique: true });

module.exports = mongoose.model('Expense', ExpenseSchema);
