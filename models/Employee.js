const mongoose = require('mongoose');

const AllowanceSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  amount: { type: Number, default: 0, min: 0 },
}, { _id: false });

const EmployeeSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  employeeId: { type: String, required: true, trim: true },
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true },
  phone: { type: String, default: '' },
  dateOfBirth: Date,
  gender: { type: String, enum: ['Male', 'Female', 'Other', ''], default: '' },

  address: {
    line1: String,
    line2: String,
    city: String,
    state: String,
    zip: String,
    country: { type: String, default: 'India' },
  },

  designation: { type: String, default: '' },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
  joiningDate: { type: Date, required: true },
  location: { type: String, default: '' },
  dateOfLeaving: { type: Date, default: null },
  employmentType: {
    type: String,
    enum: ['full-time', 'part-time', 'contract', 'intern'],
    default: 'full-time',
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'terminated'],
    default: 'active',
    index: true,
  },

  monthlyCTC: { type: Number, default: 0, min: 0 },
  flexiAmount: { type: Number, default: 0, min: 0 },
  broadband: { type: Number, default: 0, min: 0 },
  petrol: { type: Number, default: 0, min: 0 },
  lta: { type: Number, default: 0, min: 0 },
  employerNPS: { type: Number, default: 0, min: 0 },
  insuranceAmount: { type: Number, default: 1000, min: 0 },
  joiningBonus: { type: Number, default: 0, min: 0 },
  basicPercent: { type: Number, default: null },
  hraPercent: { type: Number, default: null },

  pfEnabled: { type: Boolean, default: true },
  esiEnabled: { type: Boolean, default: true },
  ptEnabled: { type: Boolean, default: true },
  lwfEnabled: { type: Boolean, default: true },
  gratuityEnabled: { type: Boolean, default: true },
  includePfInCTC: { type: Boolean, default: true },
  includeGratuityInCTC: { type: Boolean, default: true },

  salaryStructure: {
    basic: { type: Number, required: true, default: 0, min: 0 },
    hra: { type: Number, default: 0, min: 0 },
    conveyance: { type: Number, default: 0, min: 0 },
    medicalAllowance: { type: Number, default: 0, min: 0 },
    specialAllowance: { type: Number, default: 0, min: 0 },
    otherAllowances: [AllowanceSchema],
    grossSalary: { type: Number, default: 0, min: 0 },
    ctc: { type: Number, default: 0, min: 0 },
  },

  deductions: {
    pf: { type: Number, default: 0, min: 0 },
    esi: { type: Number, default: 0, min: 0 },
    professionalTax: { type: Number, default: 0, min: 0 },
    tds: { type: Number, default: 0, min: 0 },
    otherDeductions: [AllowanceSchema],
  },

  bankDetails: {
    accountName: String,
    accountNumber: { type: String, select: false },
    ifscCode: String,
    bankName: String,
    branch: String,
  },

  panNumber: { type: String, default: '', select: false },
  uanNumber: { type: String, default: '', select: false },
  aadharNumber: { type: String, default: '', select: false },

  taxRegime: {
    type: String,
    enum: ['old', 'new'],
    default: 'new',
  },
  declarations: {
    section80C: { type: Number, default: 0, min: 0 },
    section80D: { type: Number, default: 0, min: 0 },
    section24b: { type: Number, default: 0, min: 0 },
    section80CCD1B: { type: Number, default: 0, min: 0 },
    rentPaidMonthly: { type: Number, default: 0, min: 0 },
    isMetroCity: { type: Boolean, default: false },
    otherExemptions: { type: Number, default: 0, min: 0 },
  },

  documents: [{
    docType: String,
    url: String,
    uploadedAt: { type: Date, default: Date.now },
  }],

  salaryRevisions: [{
    effectiveDate: { type: Date, required: true },
    previousCTC: { type: Number },
    newCTC: { type: Number },
    reason: { type: String },
    revisedBy: { type: String },
    createdAt: { type: Date, default: Date.now },
  }],
}, { timestamps: true });

EmployeeSchema.index({ user: 1, employeeId: 1 }, { unique: true });
EmployeeSchema.index({ user: 1, email: 1 });

EmployeeSchema.pre('save', function() {
  const { buildMasterSalaryStructure } = require('../utils/payrollMath');
  const master = buildMasterSalaryStructure(this);

  const salary = this.salaryStructure || {};
  salary.basic = master.basicMaster;
  salary.hra = master.hraMaster;
  salary.conveyance = master.conveyance;
  salary.medicalAllowance = master.medicalAllowance;
  salary.specialAllowance = master.specialAllowance;
  salary.grossSalary = master.grossSalary;
  salary.ctc = master.grossTotalSalary;
  this.salaryStructure = salary;
});

const applySalaryStructureUpdate = async function() {
  const update = this.getUpdate();
  if (!update) return;
  const set = update.$set || update;
  const hasSalaryUpdate = Boolean(
    set.salaryStructure ||
    Object.keys(set).some((key) => key.startsWith('salaryStructure.')) ||
    set.monthlyCTC !== undefined ||
    set.pfEnabled !== undefined ||
    set.esiEnabled !== undefined ||
    set.ptEnabled !== undefined ||
    set.lwfEnabled !== undefined ||
    set.gratuityEnabled !== undefined ||
    set.includePfInCTC !== undefined ||
    set.includeGratuityInCTC !== undefined
  );
  if (!hasSalaryUpdate) return;

  let mergedSalary = {};
  if (set.salaryStructure && typeof set.salaryStructure === 'object') {
    mergedSalary = { ...set.salaryStructure };
  }

  for (const key of Object.keys(set)) {
    if (key.startsWith('salaryStructure.')) {
      mergedSalary[key.replace('salaryStructure.', '')] = set[key];
    }
  }

  const docId = this.getQuery()._id;
  let currentDoc = {};
  if (mongoose.Types.ObjectId.isValid(String(docId))) {
    currentDoc = await this.model.findOne({ _id: docId }).lean() || {};
  }

  const mergedEmployee = {
    ...currentDoc,
    ...set,
    salaryStructure: {
      ...(currentDoc.salaryStructure || {}),
      ...mergedSalary
    }
  };

  const { buildMasterSalaryStructure } = require('../utils/payrollMath');
  const master = buildMasterSalaryStructure(mergedEmployee);

  if (set.salaryStructure && typeof set.salaryStructure === 'object') {
    set.salaryStructure = {
      ...mergedSalary,
      basic: master.basicMaster,
      hra: master.hraMaster,
      conveyance: master.conveyance,
      medicalAllowance: master.medicalAllowance,
      specialAllowance: master.specialAllowance,
      grossSalary: master.grossSalary,
      ctc: master.grossTotalSalary
    };
  } else {
    if (!update.$set) update.$set = {};
    update.$set['salaryStructure.basic'] = master.basicMaster;
    update.$set['salaryStructure.hra'] = master.hraMaster;
    update.$set['salaryStructure.conveyance'] = master.conveyance;
    update.$set['salaryStructure.medicalAllowance'] = master.medicalAllowance;
    update.$set['salaryStructure.specialAllowance'] = master.specialAllowance;
    update.$set['salaryStructure.grossSalary'] = master.grossSalary;
    update.$set['salaryStructure.ctc'] = master.grossTotalSalary;
  }

  this.setUpdate(update);
};

EmployeeSchema.pre('findOneAndUpdate', async function() {
  await applySalaryStructureUpdate.call(this);
});

EmployeeSchema.pre('updateOne', async function() {
  await applySalaryStructureUpdate.call(this);
});

EmployeeSchema.pre('updateMany', async function() {
  await applySalaryStructureUpdate.call(this);
});

const removeEmployeePII = (doc, ret) => {
  return ret;
};
EmployeeSchema.set('toJSON', { transform: removeEmployeePII });
EmployeeSchema.set('toObject', { transform: removeEmployeePII });

module.exports = mongoose.model('Employee', EmployeeSchema);
