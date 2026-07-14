const mongoose = require('mongoose');
const softDeletePlugin = require('../middleware/softDeletePlugin');

const PayrollVariableTransactionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  payroll: { type: mongoose.Schema.Types.ObjectId, ref: 'Payroll', index: true },
  paymentType: {
    type: String,
    enum: ['SALARY', 'BONUS', 'POSITION', 'PROJECT', 'INTERVIEW', 'MILESTONE', 'COMMISSION', 'OTHER'],
    required: true,
  },
  reference: { type: String, default: '' },   // e.g., "Senior React Dev", "ERP Project", "Candidate Name"
  client: { type: String, default: '' },
  quantity: { type: Number, default: 1 },
  rate: { type: Number, default: 0 },
  amount: { type: Number, required: true },   // quantity * rate
  remarks: { type: String },
  status: { type: String, enum: ['pending', 'approved', 'paid'], default: 'approved' },
  date: { type: Date, default: Date.now },
}, { timestamps: true });

PayrollVariableTransactionSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('PayrollVariableTransaction', PayrollVariableTransactionSchema);
