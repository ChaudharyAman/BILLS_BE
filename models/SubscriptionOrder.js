const mongoose = require('mongoose');

const SubscriptionOrderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  razorpayOrderId: { type: String, required: true, unique: true },
  razorpayPaymentId: { type: String, unique: true, sparse: true },
  plan: { type: String, enum: ['pro'], required: true },
  billingCycle: { type: String, enum: ['monthly', 'yearly'], required: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'INR' },
  status: {
    type: String,
    enum: ['created', 'paid', 'failed'],
    default: 'created',
    index: true,
  },
  rawOrder: { type: mongoose.Schema.Types.Mixed, default: null },
  rawPayment: { type: mongoose.Schema.Types.Mixed, default: null },
  paidAt: { type: Date, default: null },
}, { timestamps: true });

SubscriptionOrderSchema.index({ user: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('SubscriptionOrder', SubscriptionOrderSchema);
