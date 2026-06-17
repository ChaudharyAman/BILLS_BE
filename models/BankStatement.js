const mongoose = require('mongoose');

const BankTransactionSchema = new mongoose.Schema({
  date:        { type: Date, required: true },
  description: { type: String, default: '' },
  debit:       { type: Number, default: 0 },
  credit:      { type: Number, default: 0 },
  balance:     { type: Number, default: 0 },
  category:    { type: String, default: 'Other' },
  type:        { type: String, enum: ['Expense', 'Income'], default: 'Expense' },
  subCategory: { type: String, default: '' },
  remark:      { type: String, default: '' },
  txnId:       { type: String, default: '' },
});

const BankStatementSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User', index: true },

  // File metadata
  fileName:  { type: String, required: true },
  label:     { type: String, default: '' },           // Optional user-friendly label

  // Summary stats (denormalized for fast listing)
  totalCredits:   { type: Number, default: 0 },
  totalDebits:    { type: Number, default: 0 },
  netFlow:        { type: Number, default: 0 },
  txnCount:       { type: Number, default: 0 },
  openingBalance: { type: Number, default: 0 },
  closingBalance: { type: Number, default: 0 },
  dateFrom:       { type: Date },
  dateTo:         { type: Date },

  // Parsed transactions
  transactions: [BankTransactionSchema],

}, { timestamps: true });

// One user can have many statements — index for fast lookups
BankStatementSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('BankStatement', BankStatementSchema);
