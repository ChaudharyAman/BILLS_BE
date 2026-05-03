const mongoose = require('mongoose');

const LiabilitySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ['current', 'long-term'], required: true, index: true },
  category: {
    type: String,
    enum: ['loan', 'credit-card', 'accounts-payable', 'mortgage', 'other'],
    default: 'other',
  },
  principalAmount: { type: mongoose.Schema.Types.Decimal128, required: true, min: 0 },
  outstandingAmount: { type: mongoose.Schema.Types.Decimal128, required: true, min: 0 },
  interestRate: { type: Number, default: 0, min: 0 },
  startDate: Date,
  dueDate: Date,
  status: { type: String, enum: ['active', 'paid', 'defaulted'], default: 'active', index: true },
}, { timestamps: true });

module.exports = mongoose.model('Liability', LiabilitySchema);
