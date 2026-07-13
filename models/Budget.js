const mongoose = require('mongoose');
const softDeletePlugin = require('../middleware/softDeletePlugin');

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
  endDate: {
    type: Date,
    required: true,
    index: true,
    validate: {
      validator: function(value) {
        return !this.startDate || value > this.startDate;
      },
      message: 'End date must be later than start date',
    },
  },
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

BudgetSchema.pre('save', async function() {
  if (this.spentAmount === undefined) this.spentAmount = 0;
  this.remainingAmount = this.budgetAmount - (this.spentAmount || 0);
});

BudgetSchema.pre('findOneAndUpdate', async function() {
  const update = this.getUpdate();
  const set = update?.$set || update || {};
  const newStartDate = set.startDate || set['startDate'];
  const newEndDate = set.endDate || set['endDate'];

  if (newEndDate && newStartDate) {
    if (new Date(newEndDate) <= new Date(newStartDate)) {
      const err = new Error('End date must be later than start date');
      err.statusCode = 400;
      throw err;
    }
  }

  if (newEndDate && !newStartDate) {
    const doc = await this.model.findOne(this.getQuery()).select('startDate').lean();
    if (doc && new Date(newEndDate) <= new Date(doc.startDate)) {
      const err = new Error('End date must be later than start date');
      err.statusCode = 400;
      throw err;
    }
  }
});

BudgetSchema.index({ user: 1, category: 1, startDate: 1, endDate: 1 });

BudgetSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Budget', BudgetSchema);
