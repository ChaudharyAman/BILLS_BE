const mongoose = require('mongoose');
const softDeletePlugin = require('../middleware/softDeletePlugin');

const CashLedgerEntrySchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  account: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CashAccount',
    required: true,
    index: true,
  },
  date: {
    type: Date,
    default: Date.now,
    required: true,
    index: true,
  },
  // Signed amount: positive for cash inflows, negative for cash outflows
  amount: {
    type: Number,
    required: true,
  },
  type: {
    type: String,
    enum: [
      'invoice_payment',
      'expense_payment',
      'income_receipt',
      'asset_purchase',
      'asset_disposal',
      'liability_draw',
      'liability_repayment',
      'capital_contribution',
      'capital_withdrawal',
      'manual_adjustment'
    ],
    required: true,
  },
  sourceModel: {
    type: String,
    enum: ['Invoice', 'Expense', 'Income', 'Asset', 'Liability', 'EquityTransaction', 'Manual'],
    default: 'Manual',
  },
  sourceId: {
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'sourceModel',
    default: null,
  },
  notes: {
    type: String,
    default: '',
    trim: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
}, { timestamps: true });

CashLedgerEntrySchema.index({ user: 1, account: 1, date: 1 });
CashLedgerEntrySchema.index({ user: 1, sourceModel: 1, sourceId: 1 });
CashLedgerEntrySchema.plugin(softDeletePlugin);

module.exports = mongoose.model('CashLedgerEntry', CashLedgerEntrySchema);
