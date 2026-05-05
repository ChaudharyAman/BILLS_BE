const mongoose = require('mongoose');

const CategorySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: ['income', 'expense'], required: true },
  icon: { type: String, default: '' },
  color: { type: String, default: '#64748b' },
  isSystem: { type: Boolean, default: false },
  parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
  budgetLimit: { type: Number, default: 0, min: 0 },
  description: { type: String, default: '' },
}, { timestamps: true });

CategorySchema.index({ user: 1, name: 1, type: 1 }, { unique: true });
CategorySchema.index({ user: 1, type: 1, parent: 1 });

module.exports = mongoose.model('Category', CategorySchema);
