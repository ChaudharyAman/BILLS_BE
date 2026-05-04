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

  documents: [{
    docType: String,
    url: String,
    uploadedAt: { type: Date, default: Date.now },
  }],
}, { timestamps: true });

EmployeeSchema.index({ user: 1, employeeId: 1 }, { unique: true });
EmployeeSchema.index({ user: 1, email: 1 });

EmployeeSchema.pre('save', function() {
  const salary = this.salaryStructure || {};
  const otherAllowances = Array.isArray(salary.otherAllowances) ? salary.otherAllowances : [];
  const otherTotal = otherAllowances.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const gross =
    (Number(salary.basic) || 0) +
    (Number(salary.hra) || 0) +
    (Number(salary.conveyance) || 0) +
    (Number(salary.medicalAllowance) || 0) +
    (Number(salary.specialAllowance) || 0) +
    otherTotal;

  salary.grossSalary = gross;
  const employerPF = (Number(salary.basic) || 0) * 0.12;
  const employerESI = gross <= 21000 ? gross * 0.0325 : 0;
  salary.ctc = gross + employerPF + employerESI;
  this.salaryStructure = salary;
});

const applySalaryStructureUpdate = async function() {
  const update = this.getUpdate();
  if (!update) return;
  const set = update.$set || update;
  const hasSalaryUpdate = Boolean(
    set.salaryStructure ||
    Object.keys(set).some((key) => key.startsWith('salaryStructure.'))
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

  const needsExisting = ['basic', 'hra', 'conveyance', 'medicalAllowance', 'specialAllowance', 'otherAllowances']
    .some((field) => mergedSalary[field] === undefined);
  if (needsExisting) {
    const docId = this.getQuery()._id;
    if (mongoose.Types.ObjectId.isValid(String(docId))) {
      const current = await this.model.findOne({ _id: docId }).select('salaryStructure').lean();
      if (current?.salaryStructure) {
        mergedSalary = { ...current.salaryStructure, ...mergedSalary };
      }
    }
  }

  const otherAllowances = Array.isArray(mergedSalary.otherAllowances) ? mergedSalary.otherAllowances : [];
  const otherTotal = otherAllowances.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const gross =
    (Number(mergedSalary.basic) || 0) +
    (Number(mergedSalary.hra) || 0) +
    (Number(mergedSalary.conveyance) || 0) +
    (Number(mergedSalary.medicalAllowance) || 0) +
    (Number(mergedSalary.specialAllowance) || 0) +
    otherTotal;
  const ctc = gross + ((Number(mergedSalary.basic) || 0) * 0.12) + (gross <= 21000 ? gross * 0.0325 : 0);

  if (set.salaryStructure && typeof set.salaryStructure === 'object') {
    set.salaryStructure = { ...mergedSalary, grossSalary: gross, ctc };
  } else {
    if (!update.$set) update.$set = {};
    update.$set['salaryStructure.grossSalary'] = gross;
    update.$set['salaryStructure.ctc'] = ctc;
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
  if (!ret) return ret;
  delete ret.panNumber;
  delete ret.uanNumber;
  delete ret.aadharNumber;
  if (ret.bankDetails) {
    delete ret.bankDetails.accountNumber;
  }
  return ret;
};

EmployeeSchema.set('toJSON', { transform: removeEmployeePII });
EmployeeSchema.set('toObject', { transform: removeEmployeePII });

module.exports = mongoose.model('Employee', EmployeeSchema);
