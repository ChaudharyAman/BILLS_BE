const mongoose = require('mongoose');

const LeaveBalanceSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  leaveType: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveType', required: true, index: true },
  year: { type: Number, required: true },
  opening: { type: Number, default: 0, min: 0 },
  accrued: { type: Number, default: 0, min: 0 },
  used: { type: Number, default: 0, min: 0 },
  carriedForward: { type: Number, default: 0, min: 0 },
  closing: { type: Number, default: 0 },
}, { timestamps: true });

// Unique balance per employee, leave type, and calendar year
LeaveBalanceSchema.index({ user: 1, employee: 1, leaveType: 1, year: 1 }, { unique: true });

module.exports = mongoose.model('LeaveBalance', LeaveBalanceSchema);
