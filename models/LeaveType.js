const mongoose = require('mongoose');

const LeaveTypeSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, trim: true, uppercase: true },
  annualEntitlement: { type: Number, default: 12, min: 0 },
  carriesForward: { type: Boolean, default: false },
  isPaid: { type: Boolean, default: true },
  description: { type: String, default: '' },
}, { timestamps: true });

// Ensure unique code/name per tenant (user)
LeaveTypeSchema.index({ user: 1, name: 1 }, { unique: true });
LeaveTypeSchema.index({ user: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('LeaveType', LeaveTypeSchema);
