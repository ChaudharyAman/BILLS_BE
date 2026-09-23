const mongoose = require('mongoose');
const softDeletePlugin = require('../middleware/softDeletePlugin');

const LeaveRequestSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  profile: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientProfile', required: false, index: true },
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  leaveType: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveType', required: true, index: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  numberOfDays: { type: Number, required: true, min: 0.5 },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'cancelled'],
    default: 'pending',
    index: true,
  },
  reason: { type: String, default: '' },
  approverRemarks: { type: String, default: '' },
}, { timestamps: true });

LeaveRequestSchema.index({ profile: 1, employee: 1, status: 1 });
LeaveRequestSchema.index({ user: 1, employee: 1, status: 1 });

LeaveRequestSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('LeaveRequest', LeaveRequestSchema);
