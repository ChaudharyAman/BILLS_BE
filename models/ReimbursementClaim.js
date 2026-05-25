const mongoose = require('mongoose');

const ReimbursementClaimSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
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

module.exports = mongoose.model('ReimbursementClaim', ReimbursementClaimSchema);
