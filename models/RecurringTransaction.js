const mongoose = require('mongoose');

const PartySchema = new mongoose.Schema({
  vendorRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Client' },
  clientRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Client' },
  name: String,
}, { _id: false });

const RecurringTransactionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['income', 'expense'], required: true, index: true },
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
  subCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
  name: { type: String, required: true, trim: true },
  amount: { type: Number, required: true, min: 0 },
  description: { type: String, default: '' },
  paymentMethod: { type: String, default: '' },
  vendor: PartySchema,
  client: PartySchema,
  frequency: {
    type: String,
    enum: ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'],
    required: true,
  },
  startDate: { type: Date, required: true },
  endDate: { type: Date, default: null },
  dayOfMonth: { type: Number, min: 1, max: 31 },
  dayOfWeek: { type: Number, min: 0, max: 6 },
  isActive: { type: Boolean, default: true, index: true },
  lastProcessedDate: Date,
  nextProcessDate: { type: Date, index: true },
  autoCreate: { type: Boolean, default: true },
  notifyBeforeCreation: { type: Boolean, default: false },
  notifyDaysBefore: { type: Number, default: 3 },
}, { timestamps: true });

RecurringTransactionSchema.index({ user: 1, type: 1, isActive: 1, nextProcessDate: 1 });

module.exports = mongoose.model('RecurringTransaction', RecurringTransactionSchema);
