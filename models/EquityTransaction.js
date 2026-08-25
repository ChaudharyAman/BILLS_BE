const mongoose = require('mongoose');
const softDeletePlugin = require('../middleware/softDeletePlugin');

const EquityTransactionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  date: {
    type: Date,
    default: Date.now,
    required: true,
    index: true,
  },
  type: {
    type: String,
    enum: [
      // New user-friendly classification
      'share_issuance',
      'owner_contribution',
      'owner_distribution',
      'opening_equity_balance',
      'accountant_adjustment',
      // Legacy backward-compatible types
      'common_stock_issued',
      'additional_paid_in_capital',
      'capital_withdrawal',
      'retained_earnings_adjustment'
    ],
    required: true,
    index: true,
  },
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
  shares: {
    type: Number,
    default: 0,
    min: 0,
  },
  pricePerShare: {
    type: Number,
    default: 0,
    min: 0,
  },
  parValue: {
    type: Number,
    default: 0,
    min: 0,
  },
  commonStockAmount: {
    type: Number,
    default: 0,
    min: 0,
  },
  apicAmount: {
    type: Number,
    default: 0,
    min: 0,
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

EquityTransactionSchema.index({ user: 1, date: 1 });
EquityTransactionSchema.index({ user: 1, type: 1 });
EquityTransactionSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('EquityTransaction', EquityTransactionSchema);
