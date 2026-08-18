const mongoose = require('mongoose');
const softDeletePlugin = require('../middleware/softDeletePlugin');

const CashAccountSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  accountType: {
    type: String,
    enum: ['cash', 'bank'],
    default: 'cash',
    required: true,
  },
  accountNumber: {
    type: String,
    trim: true,
    default: '',
  },
  bankName: {
    type: String,
    trim: true,
    default: '',
  },
  ifscCode: {
    type: String,
    trim: true,
    default: '',
  },
  openingBalance: {
    type: Number,
    default: 0,
  },
  openingBalanceDate: {
    type: Date,
    default: Date.now,
  },
  currentBalance: {
    type: Number,
    default: 0,
  },
  currency: {
    type: String,
    default: 'INR',
    trim: true,
  },
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active',
    index: true,
  },
  isDefault: {
    type: Boolean,
    default: false,
  },
}, { timestamps: true });

CashAccountSchema.index({ user: 1, name: 1 }, { unique: true });
CashAccountSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('CashAccount', CashAccountSchema);
