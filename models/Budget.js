const mongoose = require('mongoose');

const BudgetSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null, index: true },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
  project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null },
  period: {
    type: String,
    enum: ['monthly', 'quarterly', 'yearly', 'custom'],
    required: true,
  },
  startDate: { type: Date, required: true, index: true },
  endDate: { type: Date, required: true, index: true },
  budgetAmount: { type: Number, required: true, min: 0 },
  spentAmount: { type: Number, default: 0, min: 0 },
  remainingAmount: { type: Number, default: 0 },
  alertThreshold: { type: Number, default: 80, min: 0, max: 100 },
  alertEnabled: { type: Boolean, default: true },
  notes: { type: String, default: '' },
  status: {
    type: String,
    enum: ['active', 'completed', 'exceeded'],
    default: 'active',
    index: true,
  },
}, { timestamps: true });

BudgetSchema.index({ user: 1, category: 1, startDate: 1, endDate: 1 });

module.exports = mongoose.model('Budget', BudgetSchema);
