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
  role: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', default: null },
  payType: { type: String, enum: ['salaried', 'hourly'], default: 'salaried' },
  hourlyRate: { type: Number, default: 0, min: 0 },
  flexiAmount: { type: Number, default: 0, min: 0 },
  broadband: { type: Number, default: 0, min: 0 },
  petrol: { type: Number, default: 0, min: 0 },
  lta: { type: Number, default: 0, min: 0 },
  employerNPS: { type: Number, default: 0, min: 0 },
  insuranceAmount: { type: Number, default: 0, min: 0 },
  joiningBonus: { type: Number, default: 0, min: 0 },
  basicPercent: { type: Number, default: null },
  hraPercent: { type: Number, default: null },
  useSalaryComponents: { type: Boolean, default: true },

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
    // 80C breakdown sub-fields (UI convenience — capped total stored in section80C)
    epf:             { type: Number, default: 0, min: 0 },
    ppf:             { type: Number, default: 0, min: 0 },
    elss:            { type: Number, default: 0, min: 0 },
    lic:             { type: Number, default: 0, min: 0 },
    homeLoanPrincipal: { type: Number, default: 0, min: 0 },
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
    previousHourlyRate: { type: Number },
    newHourlyRate: { type: Number },
    hourlyRate: { type: Number },
    reason: { type: String },
    revisedBy: { type: String },
    createdAt: { type: Date, default: Date.now },

    // Configuration snapshot fields
    monthlyCTC: { type: Number },
    pfEnabled: { type: Boolean },
    esiEnabled: { type: Boolean },
    ptEnabled: { type: Boolean },
    lwfEnabled: { type: Boolean },
    gratuityEnabled: { type: Boolean },
    includePfInCTC: { type: Boolean },
    includeGratuityInCTC: { type: Boolean },
    basicPercent: { type: Number },
    hraPercent: { type: Number },
    joiningBonus: { type: Number },
    flexiAmount: { type: Number },
    broadband: { type: Number },
    petrol: { type: Number },
    lta: { type: Number },
    employerNPS: { type: Number },
    insuranceAmount: { type: Number },
    deductions: {
      tds: { type: Number },
      professionalTax: { type: Number },
      otherDeductions: [AllowanceSchema],
    },
    salaryStructure: {
      conveyance: { type: Number },
      medicalAllowance: { type: Number },
      otherAllowances: [AllowanceSchema],
    },
  }],
}, { timestamps: true, strict: false });

EmployeeSchema.index({ user: 1, employeeId: 1 }, { unique: true });
EmployeeSchema.index({ user: 1, email: 1 });

EmployeeSchema.pre('save', async function() {
  // Guard: cannot compute salary without a user reference
  if (!this.user) return;

  if (this.role) {
    const Role = mongoose.model('Role');
    const roleDoc = await Role.findOne({ _id: this.role, user: this.user }).lean();
    if (roleDoc) {
      if (this.isNew) {
        this.payType = this.payType || roleDoc.payType;
        this.monthlyCTC = this.monthlyCTC || roleDoc.monthlyCTC;
        this.hourlyRate = this.hourlyRate || roleDoc.hourlyRate;
        this.pfEnabled = this.pfEnabled !== undefined ? this.pfEnabled : roleDoc.pfEnabled;
        this.esiEnabled = this.esiEnabled !== undefined ? this.esiEnabled : roleDoc.esiEnabled;
        this.ptEnabled = this.ptEnabled !== undefined ? this.ptEnabled : roleDoc.ptEnabled;
        this.lwfEnabled = this.lwfEnabled !== undefined ? this.lwfEnabled : roleDoc.lwfEnabled;
        this.gratuityEnabled = this.gratuityEnabled !== undefined ? this.gratuityEnabled : roleDoc.gratuityEnabled;
        this.includePfInCTC = this.includePfInCTC !== undefined ? this.includePfInCTC : roleDoc.includePfInCTC;
        this.includeGratuityInCTC = this.includeGratuityInCTC !== undefined ? this.includeGratuityInCTC : roleDoc.includeGratuityInCTC;
        this.basicPercent = this.basicPercent || roleDoc.basicPercent;
        this.hraPercent = this.hraPercent || roleDoc.hraPercent;
        this.useSalaryComponents = this.useSalaryComponents !== undefined ? this.useSalaryComponents : roleDoc.useSalaryComponents;
      }
    }
  }

  const PayrollConfig = mongoose.model('PayrollConfig');
  let config = {};
  if (this.user) {
    config = await PayrollConfig.findOne({ user: this.user }).lean() || {};
  }
  const { buildMasterSalaryStructure } = require('../utils/payrollMath');
  const master = buildMasterSalaryStructure(this, config);

  const salary = this.salaryStructure || {};
  salary.basic = master.basicMaster;
  salary.hra = master.hraMaster;
  salary.conveyance = master.conveyance;
  salary.medicalAllowance = master.medicalAllowance;
  salary.specialAllowance = master.specialAllowance;
  salary.grossSalary = master.grossSalary;
  salary.ctc = master.grossTotalSalary;
  this.salaryStructure = salary;

  const deductions = this.deductions || {};
  deductions.pf = master.pfEmployee;
  deductions.esi = master.esiEmployee;
  deductions.professionalTax = master.professionalTax;
  this.deductions = deductions;
});

const applySalaryStructureUpdate = async function() {
  const update = this.getUpdate();
  if (!update) return;
  const set = update.$set || update;
  const hasSalaryUpdate = Boolean(
    set.salaryStructure ||
    Object.keys(set).some((key) => key.startsWith('salaryStructure.')) ||
    set.monthlyCTC !== undefined ||
    set.role !== undefined ||
    set.payType !== undefined ||
    set.hourlyRate !== undefined ||
    set.pfEnabled !== undefined ||
    set.esiEnabled !== undefined ||
    set.ptEnabled !== undefined ||
    set.lwfEnabled !== undefined ||
    set.gratuityEnabled !== undefined ||
    set.includePfInCTC !== undefined ||
    set.includeGratuityInCTC !== undefined
  );
  if (!hasSalaryUpdate) return;

  const docId = this.getQuery()._id;
  let currentDoc = {};
  if (mongoose.Types.ObjectId.isValid(String(docId))) {
    currentDoc = await this.model.findOne({ _id: docId }).lean() || {};
  }

  // Load Role if role is set or changed
  const newRole = set.role !== undefined ? set.role : currentDoc.role;
  let roleDoc = null;
  if (newRole) {
    const Role = mongoose.model('Role');
    const userId = set.user || currentDoc.user;
    roleDoc = await Role.findOne({ _id: newRole, user: userId }).lean();
  }

  const getField = (field, def) => {
    if (set[field] !== undefined) return set[field];
    if (roleDoc && roleDoc[field] !== undefined && roleDoc[field] !== null) return roleDoc[field];
    if (currentDoc[field] !== undefined && currentDoc[field] !== null) return currentDoc[field];
    return def;
  };

  if (roleDoc) {
    const fieldsToSync = [
      'payType', 'monthlyCTC', 'hourlyRate', 'pfEnabled', 'esiEnabled',
      'ptEnabled', 'lwfEnabled', 'gratuityEnabled', 'includePfInCTC',
      'includeGratuityInCTC', 'basicPercent', 'hraPercent', 'useSalaryComponents'
    ];
    if (!update.$set) update.$set = {};
    for (const f of fieldsToSync) {
      if (update.$set[f] === undefined && set[f] === undefined) {
        update.$set[f] = roleDoc[f];
      }
    }
  }

  let mergedSalary = {};
  if (set.salaryStructure && typeof set.salaryStructure === 'object') {
    mergedSalary = { ...set.salaryStructure };
  }

  for (const key of Object.keys(set)) {
    if (key.startsWith('salaryStructure.')) {
      mergedSalary[key.replace('salaryStructure.', '')] = set[key];
    }
  }

  const mergedEmployee = {
    ...currentDoc,
    ...set,
    payType: getField('payType', 'salaried'),
    monthlyCTC: getField('monthlyCTC', 0),
    hourlyRate: getField('hourlyRate', 0),
    pfEnabled: getField('pfEnabled', true),
    esiEnabled: getField('esiEnabled', true),
    ptEnabled: getField('ptEnabled', true),
    lwfEnabled: getField('lwfEnabled', true),
    gratuityEnabled: getField('gratuityEnabled', true),
    includePfInCTC: getField('includePfInCTC', true),
    includeGratuityInCTC: getField('includeGratuityInCTC', true),
    basicPercent: getField('basicPercent', null),
    hraPercent: getField('hraPercent', null),
    useSalaryComponents: getField('useSalaryComponents', true),
    salaryStructure: {
      ...(currentDoc.salaryStructure || {}),
      ...mergedSalary
    }
  };

  const PayrollConfig = mongoose.model('PayrollConfig');
  const userId = set.user || currentDoc.user;
  let config = {};
  if (userId) {
    config = await PayrollConfig.findOne({ user: userId }).lean() || {};
  }

  const { buildMasterSalaryStructure } = require('../utils/payrollMath');
  const master = buildMasterSalaryStructure(mergedEmployee, config);

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

  if (set.deductions && typeof set.deductions === 'object') {
    set.deductions = {
      ...set.deductions,
      pf: master.pfEmployee,
      esi: master.esiEmployee,
      professionalTax: master.professionalTax
    };
  } else {
    if (!update.$set) update.$set = {};
    update.$set['deductions.pf'] = master.pfEmployee;
    update.$set['deductions.esi'] = master.esiEmployee;
    update.$set['deductions.professionalTax'] = master.professionalTax;
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
  // Strip sensitive fields that should never be serialised in API responses.
  // Note: panNumber, uanNumber, aadharNumber and bankDetails.accountNumber
  // already use `select: false` in the schema — this transform provides a
  // second layer of protection in case a query explicitly projects them in.
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
