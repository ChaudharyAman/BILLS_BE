const mongoose = require('mongoose');

const PayrollComponentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ['earning', 'deduction'], required: true },
  calculationType: {
    type: String,
    enum: ['fixed', 'percentage_of_basic', 'percentage_of_gross', 'formula'],
    default: 'fixed',
  },
  value: { type: Number, default: 0 },
  formula: { type: String, default: '' },
  isSystem: { type: Boolean, default: false },
  isTaxable: { type: Boolean, default: true },
  description: { type: String, default: '' },
}, { timestamps: true });

PayrollComponentSchema.index({ user: 1, name: 1, type: 1 }, { unique: true });

module.exports = mongoose.model('PayrollComponent', PayrollComponentSchema);
