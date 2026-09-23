const mongoose = require('mongoose');
const softDeletePlugin = require('../middleware/softDeletePlugin');

const ReimbursementClaimSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  profile: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientProfile', required: false, index: true },
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  category: {
    type: String,
    enum: ['petrol', 'broadband', 'lta', 'medical', 'other'],
    required: true,
    index: true
  },
  amount: { type: Number, required: true, min: 0 },
  billUrl: { type: String, default: '' },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    index: true
  },
  approverRemarks: { type: String, default: '' }
}, { timestamps: true });

ReimbursementClaimSchema.index({ profile: 1, employee: 1, status: 1 });
ReimbursementClaimSchema.index({ user: 1, employee: 1, status: 1 });

ReimbursementClaimSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('ReimbursementClaim', ReimbursementClaimSchema);
