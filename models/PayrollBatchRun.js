/**
 * PayrollBatchRun.js
 *
 * Mongoose model for durable asynchronous payroll batch job tracking.
 * Stores progress, status, and outcome buckets (success, errors, skippedNoActivity)
 * across worker restarts.
 */

const mongoose = require('mongoose');

const PayrollBatchRunSchema = new mongoose.Schema({
  jobId: { type: String, required: true, unique: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  month: { type: Number, required: true },
  year: { type: Number, required: true },
  saveAsDraft: { type: Boolean, default: false },
  status: {
    type: String,
    enum: ['queued', 'processing', 'completed', 'failed'],
    default: 'queued',
    index: true,
  },
  total: { type: Number, default: 0 },
  processed: { type: Number, default: 0 },
  progressPercent: { type: Number, default: 0 },
  success: [{ type: mongoose.Schema.Types.Mixed }],
  errors: [{ type: mongoose.Schema.Types.Mixed }],
  skippedNoActivity: [{ type: mongoose.Schema.Types.Mixed }],
  errorMessage: { type: String, default: '' },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
}, { timestamps: true });

PayrollBatchRunSchema.index({ user: 1, month: 1, year: 1 });

module.exports = mongoose.model('PayrollBatchRun', PayrollBatchRunSchema);
