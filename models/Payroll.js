const mongoose = require('mongoose');
const softDeletePlugin = require('../middleware/softDeletePlugin');

const NamedAmountSchema = new mongoose.Schema({
  name: String,
  amount: { type: Number, default: 0 },
}, { _id: false });

const sumNamedAmounts = (items = []) => items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

const PayrollSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  month: { type: Number, required: true, min: 1, max: 12 },
  year: { type: Number, required: true },
  paymentDate: Date,

  workingDays: { type: Number, default: 26 },
  paidDays: { type: Number, default: 26 },
  paidLeaves: { type: Number, default: 0 },
  unpaidLeaves: { type: Number, default: 0 },
  lop: { type: Number, default: 0 },
  hoursWorked: { type: Number, default: 0 },
  attendanceSource: { type: String, enum: ['hrms', 'manual', 'default'], default: 'default' },
  payType: { type: String, enum: ['salaried', 'hourly'], default: 'salaried' },
  hourlyRate: { type: Number, default: 0 },
  // Raw strategy-specific inputs for this pay run (e.g. {unitsProduced:150} for piece_rate).
  // Stored so historical payslips remain fully reproducible.
  periodInput: { type: mongoose.Schema.Types.Mixed, default: {} },

  earnings: {
    basic: { type: Number, default: 0 },
    hra: { type: Number, default: 0 },
    flexiAmount: { type: Number, default: 0 },
    broadband: { type: Number, default: 0 },
    petrol: { type: Number, default: 0 },
    lta: { type: Number, default: 0 },
    specialAllowance: { type: Number, default: 0 },
    overtime: { type: Number, default: 0 },
    conveyance: { type: Number, default: 0 },
    medicalAllowance: { type: Number, default: 0 },
    otherEarnings: [NamedAmountSchema],
    variableCompensation: [{
      paymentType: { type: String },
      reference: { type: String, default: '' },
      client: { type: String, default: '' },
      quantity: { type: Number, default: 1 },
      rate: { type: Number, default: 0 },
      amount: { type: Number, required: true },
      remarks: { type: String }
    }],
    earningsMap: { type: mongoose.Schema.Types.Mixed, default: {} },
    totalEarnings: { type: Number, required: true },
  },

  employerContributions: {
    pfEmployer: { type: Number, default: 0 },
    esiEmployer: { type: Number, default: 0 },
    gratuity: { type: Number, default: 0 },
    lwfEmployer: { type: Number, default: 0 },
    insuranceEmployer: { type: Number, default: 0 },
    nps: { type: Number, default: 0 },
    grossTotalSalary: { type: Number, default: 0 },
  },

  variablePay: {
    joiningBonus: { type: Number, default: 0 },
    loyaltyBonus: { type: Number, default: 0 },
    incentive: { type: Number, default: 0 },
    specialBonus: { type: Number, default: 0 },
    otherAllowanceArrear: { type: Number, default: 0 },
    totalVariablePay: { type: Number, default: 0 },
  },

  totalPayable: { type: Number, default: 0 },

  deductions: {
    pfEmployee: { type: Number, default: 0 },
    esiEmployee: { type: Number, default: 0 },
    professionalTax: { type: Number, default: 0 },
    tds: { type: Number, default: 0 },
    insuranceEmployee: { type: Number, default: 0 },
    lwfEmployee: { type: Number, default: 0 },
    gratuityDeduction: { type: Number, default: 0 },
    loanDeduction: { type: Number, default: 0 },
    advanceDeduction: { type: Number, default: 0 },
    loanRepayments: [{
      loanId: { type: mongoose.Schema.Types.ObjectId, ref: 'Loan' },
      loanReference: { type: String, default: '' },
      amountApplied: { type: Number, default: 0 },
      remainingBalance: { type: Number, default: 0 }
    }],
    otherDeductions: [NamedAmountSchema],
    deductionsMap: { type: mongoose.Schema.Types.Mixed, default: {} },
    totalDeductions: { type: Number, required: true },
  },

  lopStrategy: {
    type: String,
    enum: ['proportional', 'older_first', 'newer_first', 'custom'],
    default: 'proportional',
  },
  segmentLops: {
    type: [Number],
    default: [],
  },
  netSalary: { type: Number, required: true },
  status: {
    type: String,
    enum: ['draft', 'processed', 'approved', 'paid', 'cancelled'],
    default: 'draft',
    index: true,
  },
  isFullAndFinal: { type: Boolean, default: false },
  settlementType: { type: String, enum: ['monthly', 'full_and_final'], default: 'monthly' },
  fnfDetails: {
    lastWorkingDay: Date,
    tenureYears: Number,
    leaveEncashmentDays: Number,
    leaveEncashmentAmount: Number,
    gratuityPayout: Number,
    noticeShortfallDeduction: Number,
    loanRecoveryDeduction: Number,
    comments: String
  },
  approvalWorkflow: [{
    status: { type: String, required: true },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    remarks: { type: String, default: '' },
    timestamp: { type: Date, default: Date.now },
  }],
  requiredApprovers: [{
    role: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approved: { type: Boolean, default: false },
    approvedAt: { type: Date }
  }],
  employeeSnapshot: {
    employeeId: String,
    firstName: String,
    lastName: String,
    email: String,
    designation: String,
    joiningDate: Date,
    monthlyCTC: Number,
    pfEnabled: Boolean,
    tdsEnabled: Boolean,
    esiEnabled: Boolean,
    ptEnabled: Boolean,
    lwfEnabled: Boolean,
    gratuityEnabled: Boolean,
    includePfInCTC: Boolean,
    includeGratuityInCTC: Boolean,
    useSalaryComponents: Boolean,
    basicPercent: Number,
    hraPercent: Number,
    ptState: String,
    taxRegime: String,
    declarations: mongoose.Schema.Types.Mixed,
    // Compensation dimension snapshot — required for reproducible historical payslips
    compensationType: String,
    payFrequency: String,
    attendanceMode: String,
    overtimePolicy: mongoose.Schema.Types.Mixed,
  },
  reimbursements: [{
    _id: { type: mongoose.Schema.Types.ObjectId, ref: 'ReimbursementClaim' },
    name: String,
    claimed: { type: Number, default: 0 },
    approved: { type: Number, default: 0 },
    billUrl: { type: String, default: '' },
  }],
  overrides: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  totalReimbursementApproved: { type: Number, default: 0 },
  paymentMethod: String,
  transactionId: String,
  notes: String,
  remarks: String,
  expenseRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Expense', default: null },
  auditLog: [
    {
      status:     { type: String },
      changedBy:  { type: String },
      changedById:{ type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      changedAt:  { type: Date, default: Date.now },
      netSalary:  { type: Number },
      notes:      { type: String },
    }
  ],
}, { timestamps: true });

PayrollSchema.pre('validate', function() {
  const earnings = this.earnings || {};
  const employerContributions = this.employerContributions || {};
  const variablePay = this.variablePay || {};
  const deductions = this.deductions || {};

  const standardEarningKeys = ['basic', 'hra', 'flexi', 'flexiAmount', 'broadband', 'petrol', 'lta', 'special', 'specialAllowance', 'conveyance', 'medical', 'medicalAllowance'];
  const dynamicEarningsSum = earnings.earningsMap 
    ? Object.entries(earnings.earningsMap)
        .filter(([k]) => !standardEarningKeys.includes(k))
        .reduce((sum, [, v]) => sum + (Number(v) || 0), 0) 
    : 0;

  earnings.totalEarnings =
    (Number(earnings.basic) || 0) +
    (Number(earnings.hra) || 0) +
    (Number(earnings.flexiAmount) || 0) +
    (Number(earnings.broadband) || 0) +
    (Number(earnings.petrol) || 0) +
    (Number(earnings.lta) || 0) +
    (Number(earnings.specialAllowance) || 0) +
    (Number(earnings.overtime) || 0) +
    (Number(earnings.conveyance) || 0) +
    (Number(earnings.medicalAllowance) || 0) +
    sumNamedAmounts(earnings.otherEarnings) +
    dynamicEarningsSum;

  employerContributions.grossTotalSalary =
    earnings.totalEarnings +
    (Number(employerContributions.pfEmployer) || 0) +
    (Number(employerContributions.esiEmployer) || 0) +
    (Number(employerContributions.gratuity) || 0) +
    (Number(employerContributions.lwfEmployer) || 0) +
    (Number(employerContributions.insuranceEmployer) || 0) +
    (Number(employerContributions.nps) || 0);

  variablePay.totalVariablePay =
    (Number(variablePay.joiningBonus) || 0) +
    (Number(variablePay.loyaltyBonus) || 0) +
    (Number(variablePay.incentive) || 0) +
    (Number(variablePay.specialBonus) || 0) +
    (Number(variablePay.otherAllowanceArrear) || 0);

  this.totalPayable = employerContributions.grossTotalSalary + variablePay.totalVariablePay;

  const standardDeductionKeys = ['pfEmployee', 'esiEmployee', 'professionalTax', 'tds', 'insuranceEmployee', 'lwfEmployee', 'gratuityDeduction', 'loanDeduction', 'advanceDeduction'];
  const dynamicDeductionsSum = deductions.deductionsMap 
    ? Object.entries(deductions.deductionsMap)
        .filter(([k]) => !standardDeductionKeys.includes(k))
        .reduce((sum, [, v]) => sum + (Number(v) || 0), 0) 
    : 0;

  deductions.totalDeductions =
    (Number(deductions.pfEmployee) || 0) +
    (Number(deductions.esiEmployee) || 0) +
    (Number(deductions.professionalTax) || 0) +
    (Number(deductions.tds) || 0) +
    (Number(deductions.insuranceEmployee) || 0) +
    (Number(deductions.lwfEmployee) || 0) +
    (Number(deductions.gratuityDeduction) || 0) +
    (Number(deductions.loanDeduction) || 0) +
    (Number(deductions.advanceDeduction) || 0) +
    sumNamedAmounts(deductions.otherDeductions) +
    dynamicDeductionsSum;

  this.totalReimbursementApproved = (this.reimbursements || []).reduce((sum, item) => sum + (Number(item.approved) || 0), 0);

  this.netSalary = Math.max(0, (Number(earnings.totalEarnings) || 0) + (Number(variablePay.totalVariablePay) || 0) + (Number(this.totalReimbursementApproved) || 0) - (Number(deductions.totalDeductions) || 0));
  this.earnings = earnings;
  this.employerContributions = employerContributions;
  this.variablePay = variablePay;
  this.deductions = deductions;
});

PayrollSchema.index({ user: 1, employee: 1, month: 1, year: 1 }, { unique: true });
PayrollSchema.post('init', function () {
  this._originalStatus = this.status;
});

PayrollSchema.pre('save', function (next) {
  if (!this.isNew && this.isModified()) {
    if (this._originalStatus === 'paid' && this.status === 'paid') {
      const modifiedPaths = this.modifiedPaths();
      const allowedKeys = ['auditLog', 'approvalWorkflow', 'expenseRef', 'paymentDate', 'paymentMethod', 'transactionId', 'updatedAt'];
      const forbiddenPaths = modifiedPaths.filter(p => !allowedKeys.includes(p));
      if (forbiddenPaths.length > 0) {
        const err = new Error(`[Immutability Guard] Cannot mutate paid payroll record (forbidden fields: ${forbiddenPaths.join(', ')}). Use reopening or retroactive arrears workflow.`);
        if (typeof next === 'function') return next(err);
        throw err;
      }
    }
  }
  if (typeof next === 'function') next();
});

NamedAmountSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Payroll', PayrollSchema);
