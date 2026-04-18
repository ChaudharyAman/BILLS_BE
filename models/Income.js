const mongoose = require('mongoose');

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
  grandTotal: { type: Number, default: 0 },

  // Notes
  terms: String,
  privateNotes: String, // Specifically for Sleekbills feature

  status: {
    type: String,
    enum: ['DRAFT', 'PAID', 'UNPAID', 'CANCELLED'],
    default: 'DRAFT',
  },

}, { timestamps: true });

// Compound unique index: same income number is allowed across different users
IncomeSchema.index({ user: 1, incomeNumber: 1 }, { unique: true });

module.exports = mongoose.model('Income', IncomeSchema);
