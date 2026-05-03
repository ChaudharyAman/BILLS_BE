const mongoose = require('mongoose');

const NamedAmountSchema = new mongoose.Schema({
  name: String,
  amount: { type: Number, default: 0 },
}, { _id: false });

const PayrollSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },

  month: { type: Number, required: true, min: 1, max: 12 },
  year: { type: Number, required: true },
  paymentDate: Date,

  earnings: {
    basic: { type: Number, default: 0 },
    hra: { type: Number, default: 0 },
    conveyance: { type: Number, default: 0 },
    medicalAllowance: { type: Number, default: 0 },
    specialAllowance: { type: Number, default: 0 },
    overtime: { type: Number, default: 0 },
    bonus: { type: Number, default: 0 },
    incentives: { type: Number, default: 0 },
    otherEarnings: [NamedAmountSchema],
    totalEarnings: { type: Number, required: true },
  },

  deductions: {
    pf: { type: Number, default: 0 },
    esi: { type: Number, default: 0 },
    professionalTax: { type: Number, default: 0 },
    tds: { type: Number, default: 0 },
    loanDeduction: { type: Number, default: 0 },
    advanceDeduction: { type: Number, default: 0 },
    otherDeductions: [NamedAmountSchema],
    totalDeductions: { type: Number, required: true },
  },

  workingDays: { type: Number, default: 26 },
  presentDays: { type: Number, default: 26 },
  paidLeaves: { type: Number, default: 0 },
  unpaidLeaves: { type: Number, default: 0 },

  netSalary: { type: Number, required: true },
  status: {
    type: String,
    enum: ['draft', 'processed', 'paid', 'cancelled'],
    default: 'draft',
    index: true,
  },

  paymentMethod: String,
  transactionId: String,
  notes: String,
  expenseRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Expense', default: null },
}, { timestamps: true });

const sumNamedAmounts = (items = []) => items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

PayrollSchema.pre('validate', function(next) {
  const earnings = this.earnings || {};
  const deductions = this.deductions || {};

  earnings.totalEarnings =
    (Number(earnings.basic) || 0) +
    (Number(earnings.hra) || 0) +
    (Number(earnings.conveyance) || 0) +
    (Number(earnings.medicalAllowance) || 0) +
    (Number(earnings.specialAllowance) || 0) +
    (Number(earnings.overtime) || 0) +
    (Number(earnings.bonus) || 0) +
    (Number(earnings.incentives) || 0) +
    sumNamedAmounts(earnings.otherEarnings);

  deductions.totalDeductions =
    (Number(deductions.pf) || 0) +
    (Number(deductions.esi) || 0) +
    (Number(deductions.professionalTax) || 0) +
    (Number(deductions.tds) || 0) +
    (Number(deductions.loanDeduction) || 0) +
    (Number(deductions.advanceDeduction) || 0) +
    sumNamedAmounts(deductions.otherDeductions);

  this.netSalary = earnings.totalEarnings - deductions.totalDeductions;
  next();
});

PayrollSchema.index({ user: 1, employee: 1, month: 1, year: 1 }, { unique: true });
PayrollSchema.index({ user: 1, year: -1, month: -1 });

module.exports = mongoose.model('Payroll', PayrollSchema);
