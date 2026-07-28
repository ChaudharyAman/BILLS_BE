const mongoose = require('mongoose');

/**
 * Stores the most recent attendance sync result per employee per payroll period.
 * Written by syncAttendanceFromExternal so callers can re-read without re-fetching from HRMS.
 */
const AttendanceSyncCacheSchema = new mongoose.Schema({
  user:          { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true, index: true },
  employeeId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  employeeNumber:{ type: String, required: true },
  month:         { type: Number, required: true, min: 1, max: 12 },
  year:          { type: Number, required: true },

  workingDays:   { type: Number, default: 0 },
  presentDays:   { type: Number, default: 0 },
  absentDays:    { type: Number, default: 0 },
  paidDays:      { type: Number, default: 0 },
  unpaidLeaves:  { type: Number, default: 0 },
  paidLeaves:    { type: Number, default: 0 },

  syncedAt: { type: Date, default: Date.now },
}, { timestamps: true });

// Unique constraint ensures one record per employee per payroll period.
// A sync always overwrites the previous value.
AttendanceSyncCacheSchema.index(
  { user: 1, employeeId: 1, month: 1, year: 1 },
  { unique: true }
);

module.exports = mongoose.model('AttendanceSyncCache', AttendanceSyncCacheSchema);
