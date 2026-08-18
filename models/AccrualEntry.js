const mongoose = require('mongoose');
const softDeletePlugin = require('../middleware/softDeletePlugin');

const AccrualEntrySchema = new mongoose.Schema({
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
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
  description: {
    type: String,
    required: true,
    trim: true,
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
    default: null,
  },
  status: {
    type: String,
    enum: ['accrued', 'reversed', 'settled'],
    default: 'accrued',
    index: true,
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

AccrualEntrySchema.index({ user: 1, date: 1, status: 1 });
AccrualEntrySchema.plugin(softDeletePlugin);

module.exports = mongoose.model('AccrualEntry', AccrualEntrySchema);
