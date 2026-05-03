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
    accountNumber: String,
    ifscCode: String,
    bankName: String,
    branch: String,
  },

  panNumber: { type: String, default: '' },
  uanNumber: { type: String, default: '' },
  aadharNumber: { type: String, default: '' },

  documents: [{
    type: String,
    url: String,
    uploadedAt: { type: Date, default: Date.now },
  }],
}, { timestamps: true });

EmployeeSchema.index({ user: 1, employeeId: 1 }, { unique: true });
EmployeeSchema.index({ user: 1, email: 1 });

EmployeeSchema.pre('save', function(next) {
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
  next();
});

EmployeeSchema.pre('findOneAndUpdate', function(next) {
  const update = this.getUpdate();
  const set = update?.$set || update || {};
  const salary = set.salaryStructure;
  if (salary) {
    const otherTotal = (salary.otherAllowances || []).reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
    const gross =
      (Number(salary.basic) || 0) +
      (Number(salary.hra) || 0) +
      (Number(salary.conveyance) || 0) +
      (Number(salary.medicalAllowance) || 0) +
      (Number(salary.specialAllowance) || 0) +
      otherTotal;
    salary.grossSalary = gross;
    salary.ctc = gross + ((Number(salary.basic) || 0) * 0.12) + (gross <= 21000 ? gross * 0.0325 : 0);
  }
  next();
});

module.exports = mongoose.model('Employee', EmployeeSchema);
