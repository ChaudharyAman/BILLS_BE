const mongoose = require('mongoose');

const AuditLogSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  action: { type: String, required: true }, // e.g. 'SALARY_EDIT', 'PAYROLL_APPROVED', 'DECLARATION_PROOF_STATUS'
  targetEmployee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', index: true, default: null },
  targetPayroll: { type: mongoose.Schema.Types.ObjectId, ref: 'Payroll', index: true, default: null },
  changes: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

module.exports = mongoose.model('AuditLog', AuditLogSchema);
