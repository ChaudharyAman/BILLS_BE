const mongoose = require('mongoose');
const softDeletePlugin = require('../middleware/softDeletePlugin');

const RepaymentSchema = new mongoose.Schema({
  month: { type: Number, required: true },
  year: { type: Number, required: true },
  amountPaid: { type: Number, required: true, min: 0 },
  payrollRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Payroll', default: null }
}, { _id: false });

const LoanSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
  principalAmount: { type: Number, required: true, min: 0 },
  emiAmount: { type: Number, required: true, min: 0 },
  interestRate: { type: Number, default: 0, min: 0 },
  remainingBalance: { type: Number, required: true, min: 0 },
  status: {
    type: String,
    enum: ['active', 'closed', 'pending_approval', 'rejected'],
    default: 'pending_approval',
    index: true
  },
  repaymentLedger: [RepaymentSchema]
}, { timestamps: true });

LoanSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Loan', LoanSchema);
