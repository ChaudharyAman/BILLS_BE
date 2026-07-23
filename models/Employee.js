const mongoose = require('mongoose');
const softDeletePlugin = require('../middleware/softDeletePlugin');

const AllowanceSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  amount: { type: Number, default: 0, min: 0 },
}, { _id: false });

const RateCardItemSchema = new mongoose.Schema({
  paymentType: { type: String, required: true },
  rate: { type: Number, required: true, default: 0 },
  unit: { type: String, default: '' },
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
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null, set: v => v === '' ? null : v },
  joiningDate: { type: Date, required: true },
  location: { type: String, default: '' },
  dateOfLeaving: { type: Date, default: null },

  // ── Legacy classification fields (kept for backward compat; deprecated after migration) ──
  employmentType: {
    type: String,
    // Extended to cover all real employment relationships.
    // Old values (full-time, part-time, contract, intern) remain valid.
    enum: [
      'full-time', 'part-time', 'contract', 'intern',
      'permanent', 'probation', 'temporary', 'consultant',
      'freelancer', 'casual', 'seasonal',
    ],
    default: 'full-time',
  },
  compensationModel: {
    type: String,
    enum: ['SALARIED', 'CONSULTANT', 'PROJECT', 'POSITION', 'INTERVIEW', 'HOURLY', 'CUSTOM'],
    default: 'SALARIED',
  },
  paymentBasis: {
    type: String,
    enum: ['MONTHLY', 'PROJECT', 'POSITION', 'INTERVIEW', 'HOUR', 'DAY', 'MILESTONE', 'CUSTOM'],
    default: 'MONTHLY',
  },
  rateCard: [RateCardItemSchema],

  // ── New canonical compensation dimensions ──────────────────────────────────────────────────
  // compensationType is THE key field that selects the payroll compute strategy.
  // null = not yet migrated; engine falls back to payType/compensationModel during transition.
  compensationType: {
    type: String,
    enum: [
      'monthly_salary',        // Standard CTC-based monthly salary (existing salaried path)
      'hourly',                // Hours × hourly rate (existing hourly path)
      'daily_wage',            // Days worked × daily rate
      'weekly_salary',         // Weekly salary (pay-frequency future)
      'piece_rate',            // Units produced × rate per unit
      'project_based',         // Flat project fee
      'milestone_based',       // Payment on milestone completion
      'attendance_based',      // Like monthly_salary but proration is always mandatory
      'timesheet_based',       // Hours logged from timesheet × blended rate
      'commission_only',       // Commission from variableTransactions[] only
      'salary_plus_commission',// Base (monthly_salary) + commission
      'retainer',              // Fixed monthly retainer; no attendance proration
    ],
    default: null,
    index: true,
  },
  payFrequency: {
    type: String,
    enum: ['monthly', 'weekly', 'biweekly', 'semi_monthly'],
    default: 'monthly',
  },
  // attendanceMode declares what raw input the compute strategy expects.
  attendanceMode: {
    type: String,
    enum: [
      'attendance',   // paidDays / workingDays (default — existing HRMS sync)
      'timesheet',    // hoursLogged from timesheet entries
      'shift',        // shiftsWorked, shiftType[]
      'unit_count',   // unitsProduced for piece-rate
      'fixed',        // Always fully paid (retainer / consultant flat monthly)
      'none',         // No attendance concept applies
    ],
    default: 'attendance',
  },
  overtimePolicy: {
    enabled:              { type: Boolean, default: false },
    multiplier:           { type: Number,  default: 1.5,  min: 1 },
    holidayMultiplier:    { type: Number,  default: 2.0,  min: 1 },
    thresholdHoursPerDay: { type: Number,  default: 8,    min: 0 },
  },

  status: {
    type: String,
    enum: ['active', 'inactive', 'terminated'],
    default: 'active',
    index: true,
  },

  monthlyCTC: { type: Number, default: 0, min: 0 },
  role: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', default: null, set: v => v === '' ? null : v },
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
  tdsEnabled: { type: Boolean, default: true },
  esiEnabled: { type: Boolean, default: true },
  ptEnabled: { type: Boolean, default: true },
  // State code used for automatic PT slab lookup (e.g. 'MH', 'KA').
  // Empty string = no auto-compute; manual deductions.professionalTax is used.
  ptState: { type: String, default: '', trim: true, uppercase: true },
  lwfEnabled: { type: Boolean, default: true },
  gratuityEnabled: { type: Boolean, default: true },
  includePfInCTC: { type: Boolean, default: false },
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
  esiNumber: { type: String, default: '', select: false },

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
    role: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', default: null, set: v => v === '' ? null : v },
    useSalaryComponents: { type: Boolean },
    employmentType: { type: String },
    compensationModel: { type: String },
    paymentBasis: { type: String },
    rateCard: [RateCardItemSchema],
    // New canonical fields — stored per-revision so getEmployeeParamsForDate() can snapshot them
    compensationType: { type: String },
    payFrequency: { type: String },
    attendanceMode: { type: String },

    // Configuration snapshot fields
    monthlyCTC: { type: Number },
    pfEnabled: { type: Boolean },
    tdsEnabled: { type: Boolean },
    esiEnabled: { type: Boolean },
    ptEnabled: { type: Boolean },
    ptState: { type: String },
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

  if (!this.isNew && (this.isModified('monthlyCTC') || this.isModified('role') || this.isModified('basicPercent') || this.isModified('hraPercent') || this.isModified('useSalaryComponents') || this.isModified('payType') || this.isModified('employmentType') || this.isModified('compensationModel') || this.isModified('paymentBasis') || this.isModified('compensationType') || this.isModified('attendanceMode'))) {
    if (!this.isModified('salaryStructure.basic') && !this.isModified('basic')) {
      if (this.salaryStructure) {
        this.salaryStructure.basic = undefined;
      }
    }
    if (!this.isModified('salaryStructure.hra') && !this.isModified('hra')) {
      if (this.salaryStructure) {
        this.salaryStructure.hra = undefined;
      }
    }
  }

  // Resolve the effective compensation type (new canonical field OR derived from legacy fields).
  // The strategy registry provides defaultStatutoryFlags() so the pre-save hook no longer
  // contains inline isHourly / isIntern logic.
  const { resolveStrategy, resolveCompensationType, deriveCompensationTypeFromLegacy, getStrategyStatutoryDefaults } = require('../utils/payrollStrategies/index');
  const effectiveCompType = this.compensationType || deriveCompensationTypeFromLegacy({
    payType: this.payType,
    compensationModel: this.compensationModel,
    employmentType: this.employmentType,
  });
  // Sync compensationType from legacy fields if it was not explicitly set
  if (!this.compensationType && effectiveCompType) {
    this.compensationType = effectiveCompType;
  }

  const strategyMeta = resolveStrategy(effectiveCompType);
  const statutoryDefaults = getStrategyStatutoryDefaults(effectiveCompType);
  const skipFixedComponents = !strategyMeta.usesSalaryComponents;

  if (skipFixedComponents) {
    this.useSalaryComponents = false;
    this.includePfInCTC = false;
    this.includeGratuityInCTC = false;
    this.flexiAmount = 0;
    this.broadband = 0;
    this.petrol = 0;
    this.lta = 0;
    if (this.pfEnabled === undefined) this.pfEnabled = statutoryDefaults.pfEligible;
    if (this.esiEnabled === undefined) this.esiEnabled = statutoryDefaults.esiEligible;
    if (this.ptEnabled === undefined) this.ptEnabled = statutoryDefaults.ptApplicable;
    if (this.lwfEnabled === undefined) this.lwfEnabled = statutoryDefaults.lwfApplicable;
    if (this.gratuityEnabled === undefined) this.gratuityEnabled = statutoryDefaults.gratuityEligible;
    if (effectiveCompType === 'hourly') {
      this.monthlyCTC = 0;
    }
  }

  if (this.role) {
    let Role;
    try {
      Role = mongoose.model('Role');
    } catch (e) {
      Role = require('./Role');
    }
    const roleDoc = await Role.findOne({ _id: this.role, user: this.user }).lean();
    if (roleDoc) {
      if (this.isNew) {
        this.payType = this.payType || roleDoc.payType;
        this.monthlyCTC = this.monthlyCTC || roleDoc.monthlyCTC;
        this.hourlyRate = this.hourlyRate || roleDoc.hourlyRate;
        this.pfEnabled = this.pfEnabled !== undefined ? this.pfEnabled : roleDoc.pfEnabled;
        this.tdsEnabled = this.tdsEnabled !== undefined ? this.tdsEnabled : roleDoc.tdsEnabled;
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
      let cleanDesignation = String(this.designation || '').trim();
      if ((cleanDesignation.startsWith('"') && cleanDesignation.endsWith('"')) || (cleanDesignation.startsWith("'") && cleanDesignation.endsWith("'"))) {
        cleanDesignation = cleanDesignation.slice(1, -1).trim();
      }
      if (this.designation && mongoose.Types.ObjectId.isValid(cleanDesignation)) {
        this.designation = roleDoc.name;
      }
    }
  } else {
    let cleanDesignation = String(this.designation || '').trim();
    if ((cleanDesignation.startsWith('"') && cleanDesignation.endsWith('"')) || (cleanDesignation.startsWith("'") && cleanDesignation.endsWith("'"))) {
      cleanDesignation = cleanDesignation.slice(1, -1).trim();
    }
    if (mongoose.Types.ObjectId.isValid(cleanDesignation)) {
      this.designation = '';
    }
  }

  let PayrollConfig;
  try {
    PayrollConfig = mongoose.model('PayrollConfig');
  } catch (e) {
    PayrollConfig = require('./PayrollConfig');
  }
  let config = {};
  if (this.user) {
    config = await PayrollConfig.findOne({ user: this.user }).lean() || {};
  }
  const { buildMasterSalaryStructure } = require('../utils/payrollMath');
  const master = buildMasterSalaryStructure(this, config);

  this.flexiAmount = master.flexi;
  this.broadband = master.broadband;
  this.petrol = master.petrol;
  this.lta = master.lta;

  const salary = this.salaryStructure || {};
  salary.basic = master.basicMaster;
  salary.hra = master.hraMaster;
  salary.conveyance = master.conveyance;
  salary.medicalAllowance = master.medicalAllowance;
  salary.specialAllowance = master.specialAllowance;
  salary.grossSalary = master.grossSalary;
  salary.ctc = master.grossTotalSalary;
  if (master.earningsMap) {
    Object.entries(master.earningsMap).forEach(([cId, val]) => {
      if (!['basic', 'hra'].includes(cId)) {
        salary[cId] = val;
      }
    });
  }
  this.salaryStructure = salary;

  const deductions = this.deductions || {};
  deductions.pf = master.pfEmployee;
  deductions.esi = master.esiEmployee;
  deductions.professionalTax = master.professionalTax;
  if (master.deductionsMap) {
    Object.entries(master.deductionsMap).forEach(([cId, val]) => {
      deductions[cId] = val;
    });
  }
  this.deductions = deductions;
});

const applySalaryStructureUpdate = async function() {
  const update = this.getUpdate();
  if (!update) return;
  const set = update.$set || update;
  const hasSalaryUpdate = Boolean(
    set.salaryStructure ||
    Object.keys(set).some((key) => key.startsWith('salaryStructure.')) ||
    Object.keys(set).some((key) => key.endsWith('Percent')) ||
    set.monthlyCTC !== undefined ||
    set.role !== undefined ||
    set.payType !== undefined ||
    set.hourlyRate !== undefined ||
    set.compensationType !== undefined ||
    set.attendanceMode !== undefined ||
    set.pfEnabled !== undefined ||
    set.tdsEnabled !== undefined ||
    set.esiEnabled !== undefined ||
    set.ptEnabled !== undefined ||
    set.lwfEnabled !== undefined ||
    set.gratuityEnabled !== undefined ||
    set.includePfInCTC !== undefined ||
    set.includeGratuityInCTC !== undefined
  );
  if (!hasSalaryUpdate) return;

  const query = this.getQuery();
  let currentDoc = {};
  if (query) {
    currentDoc = await this.model.findOne(query).lean() || {};
  }

  // Load Role if role is set or changed
  const newRole = set.role !== undefined ? set.role : currentDoc.role;
  let roleDoc = null;
  if (newRole) {
    let Role;
    try {
      Role = mongoose.model('Role');
    } catch (e) {
      Role = require('./Role');
    }
    const userId = set.user || currentDoc.user;
    roleDoc = await Role.findOne({ _id: newRole, user: userId }).lean();
  }

  const getField = (field, def) => {
    if (set[field] !== undefined) return set[field];
    if (roleDoc && roleDoc[field] !== undefined && roleDoc[field] !== null) return roleDoc[field];
    if (currentDoc[field] !== undefined && currentDoc[field] !== null) return currentDoc[field];
    return def;
  };

  const currentDesignation = set.designation !== undefined ? set.designation : currentDoc.designation;
  if (roleDoc) {
    const fieldsToSync = [
      'payType', 'monthlyCTC', 'hourlyRate', 'pfEnabled', 'tdsEnabled', 'esiEnabled',
      'ptEnabled', 'lwfEnabled', 'gratuityEnabled', 'includePfInCTC',
      'includeGratuityInCTC', 'basicPercent', 'hraPercent', 'useSalaryComponents'
    ];
    if (!update.$set) update.$set = {};
    for (const f of fieldsToSync) {
      if (update.$set[f] === undefined && set[f] === undefined) {
        update.$set[f] = roleDoc[f];
      }
    }
    let cleanDesignation = String(currentDesignation || '').trim();
    if ((cleanDesignation.startsWith('"') && cleanDesignation.endsWith('"')) || (cleanDesignation.startsWith("'") && cleanDesignation.endsWith("'"))) {
      cleanDesignation = cleanDesignation.slice(1, -1).trim();
    }
    if (currentDesignation && mongoose.Types.ObjectId.isValid(cleanDesignation)) {
      update.$set.designation = roleDoc.name;
      set.designation = roleDoc.name;
    }
  } else {
    let cleanDesignation = String(currentDesignation || '').trim();
    if ((cleanDesignation.startsWith('"') && cleanDesignation.endsWith('"')) || (cleanDesignation.startsWith("'") && cleanDesignation.endsWith("'"))) {
      cleanDesignation = cleanDesignation.slice(1, -1).trim();
    }
    if (mongoose.Types.ObjectId.isValid(cleanDesignation)) {
      if (!update.$set) update.$set = {};
      update.$set.designation = '';
      set.designation = '';
    }
  }

  // Resolve effective compensation type using strategy registry
  const { resolveStrategy, resolveCompensationType, deriveCompensationTypeFromLegacy, getStrategyStatutoryDefaults } = require('../utils/payrollStrategies/index');
  const resolvedPayType = getField('payType', 'salaried');
  const resolvedEmploymentType = getField('employmentType', 'full-time');
  const resolvedCompensationModel = getField('compensationModel', 'SALARIED');
  const resolvedCompensationType = getField('compensationType', null);

  const effectiveCompType = resolvedCompensationType || deriveCompensationTypeFromLegacy({
    payType: resolvedPayType,
    compensationModel: resolvedCompensationModel,
    employmentType: resolvedEmploymentType,
  });
  // Sync compensationType into the update if not already supplied
  if (!resolvedCompensationType && effectiveCompType) {
    if (!update.$set) update.$set = {};
    update.$set.compensationType = effectiveCompType;
    set.compensationType = effectiveCompType;
  }

  const strategyMeta = resolveStrategy(effectiveCompType);
  const statutoryDefaults = getStrategyStatutoryDefaults(effectiveCompType);
  const skipFixedComponents = !strategyMeta.usesSalaryComponents;

  if (skipFixedComponents) {
    if (!update.$set) update.$set = {};
    update.$set.useSalaryComponents = false;
    update.$set.includePfInCTC = false;
    update.$set.includeGratuityInCTC = false;
    update.$set.flexiAmount = 0;
    update.$set.broadband = 0;
    update.$set.petrol = 0;
    update.$set.lta = 0;
    set.useSalaryComponents = false;
    set.includePfInCTC = false;
    set.includeGratuityInCTC = false;
    set.flexiAmount = 0;
    set.broadband = 0;
    set.petrol = 0;
    set.lta = 0;
    if (effectiveCompType === 'hourly') {
      update.$set.monthlyCTC = 0;
      set.monthlyCTC = 0;
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

  const isCTCChanging = set.monthlyCTC !== undefined || set.role !== undefined || set.basicPercent !== undefined || set.hraPercent !== undefined || set.useSalaryComponents !== undefined || set.payType !== undefined || set.employmentType !== undefined || set.compensationModel !== undefined || set.paymentBasis !== undefined || set.compensationType !== undefined || set.attendanceMode !== undefined || Object.keys(set).some((key) => key.endsWith('Percent'));
  if (isCTCChanging) {
    if (set.basic === undefined && set['salaryStructure.basic'] === undefined && (set.salaryStructure === undefined || set.salaryStructure.basic === undefined)) {
      delete mergedSalary.basic;
    }
    if (set.hra === undefined && set['salaryStructure.hra'] === undefined && (set.salaryStructure === undefined || set.salaryStructure.hra === undefined)) {
      delete mergedSalary.hra;
    }
  }

  const mergedEmployee = {
    ...currentDoc,
    ...set,
    payType: getField('payType', 'salaried'),
    monthlyCTC: getField('monthlyCTC', 0),
    hourlyRate: getField('hourlyRate', 0),
    pfEnabled: getField('pfEnabled', true),
    tdsEnabled: getField('tdsEnabled', true),
    esiEnabled: getField('esiEnabled', true),
    ptEnabled: getField('ptEnabled', true),
    lwfEnabled: getField('lwfEnabled', true),
    gratuityEnabled: getField('gratuityEnabled', true),
    includePfInCTC: getField('includePfInCTC', false),
    includeGratuityInCTC: getField('includeGratuityInCTC', true),
    basicPercent: getField('basicPercent', null),
    compensationModel: getField('compensationModel', 'SALARIED'),
    paymentBasis: getField('paymentBasis', 'MONTHLY'),
    compensationType: getField('compensationType', null),
    attendanceMode: getField('attendanceMode', 'attendance'),
    useSalaryComponents: getField('useSalaryComponents', true),
    salaryStructure: {
      ...(currentDoc.salaryStructure || {}),
      ...mergedSalary
    }
  };

  let PayrollConfig;
  try {
    PayrollConfig = mongoose.model('PayrollConfig');
  } catch (e) {
    PayrollConfig = require('./PayrollConfig');
  }
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
    if (master.earningsMap) {
      Object.entries(master.earningsMap).forEach(([cId, val]) => {
        if (!['basic', 'hra'].includes(cId)) {
          set.salaryStructure[cId] = val;
        }
      });
    }
    set.flexiAmount = master.flexi;
    set.broadband = master.broadband;
    set.petrol = master.petrol;
    set.lta = master.lta;
  } else {
    if (!update.$set) update.$set = {};
    update.$set['salaryStructure.basic'] = master.basicMaster;
    update.$set['salaryStructure.hra'] = master.hraMaster;
    update.$set['salaryStructure.conveyance'] = master.conveyance;
    update.$set['salaryStructure.medicalAllowance'] = master.medicalAllowance;
    update.$set['salaryStructure.specialAllowance'] = master.specialAllowance;
    update.$set['salaryStructure.grossSalary'] = master.grossSalary;
    update.$set['salaryStructure.ctc'] = master.grossTotalSalary;
    if (master.earningsMap) {
      Object.entries(master.earningsMap).forEach(([cId, val]) => {
        if (!['basic', 'hra'].includes(cId)) {
          update.$set[`salaryStructure.${cId}`] = val;
        }
      });
    }
    update.$set.flexiAmount = master.flexi;
    update.$set.broadband = master.broadband;
    update.$set.petrol = master.petrol;
    update.$set.lta = master.lta;
  }

  if (set.deductions && typeof set.deductions === 'object') {
    set.deductions = {
      ...set.deductions,
      pf: master.pfEmployee,
      esi: master.esiEmployee,
      professionalTax: master.professionalTax
    };
    if (master.deductionsMap) {
      Object.entries(master.deductionsMap).forEach(([cId, val]) => {
        set.deductions[cId] = val;
      });
    }
  } else {
    if (!update.$set) update.$set = {};
    update.$set['deductions.pf'] = master.pfEmployee;
    update.$set['deductions.esi'] = master.esiEmployee;
    update.$set['deductions.professionalTax'] = master.professionalTax;
    if (master.deductionsMap) {
      Object.entries(master.deductionsMap).forEach(([cId, val]) => {
        update.$set[`deductions.${cId}`] = val;
      });
    }
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
  if (doc.isSelected && !doc.isSelected('panNumber')) {
    delete ret.panNumber;
  }
  if (doc.isSelected && !doc.isSelected('uanNumber')) {
    delete ret.uanNumber;
  }
  if (doc.isSelected && !doc.isSelected('aadharNumber')) {
    delete ret.aadharNumber;
  }
  if (doc.isSelected && !doc.isSelected('bankDetails.accountNumber')) {
    if (ret.bankDetails) {
      delete ret.bankDetails.accountNumber;
    }
  }
  return ret;
};
EmployeeSchema.set('toJSON', { transform: removeEmployeePII });
EmployeeSchema.set('toObject', { transform: removeEmployeePII });

const { encryptPIIField, decryptPIIField } = require('../utils/cryptoHelper');

EmployeeSchema.pre('save', function (next) {
  if (this.isModified('panNumber') && this.panNumber) {
    this.panNumber = encryptPIIField(this.panNumber);
  }
  if (this.isModified('uanNumber') && this.uanNumber) {
    this.uanNumber = encryptPIIField(this.uanNumber);
  }
  if (this.isModified('aadharNumber') && this.aadharNumber) {
    this.aadharNumber = encryptPIIField(this.aadharNumber);
  }
  if (this.isModified('esiNumber') && this.esiNumber) {
    this.esiNumber = encryptPIIField(this.esiNumber);
  }
  if (this.bankDetails && this.isModified('bankDetails.accountNumber') && this.bankDetails.accountNumber) {
    this.bankDetails.accountNumber = encryptPIIField(this.bankDetails.accountNumber);
  }
  if (typeof next === 'function') next();
});

const decryptEmployeePII = (doc) => {
  if (!doc) return;
  if (doc.panNumber) doc.panNumber = decryptPIIField(doc.panNumber);
  if (doc.uanNumber) doc.uanNumber = decryptPIIField(doc.uanNumber);
  if (doc.aadharNumber) doc.aadharNumber = decryptPIIField(doc.aadharNumber);
  if (doc.esiNumber) doc.esiNumber = decryptPIIField(doc.esiNumber);
  if (doc.bankDetails && doc.bankDetails.accountNumber) {
    doc.bankDetails.accountNumber = decryptPIIField(doc.bankDetails.accountNumber);
  }
};

EmployeeSchema.post('find', function (docs) {
  if (Array.isArray(docs)) {
    docs.forEach(doc => decryptEmployeePII(doc));
  }
});

EmployeeSchema.post('findOne', function (doc) {
  if (doc) decryptEmployeePII(doc);
});

EmployeeSchema.post('findOneAndUpdate', function (doc) {
  if (doc) decryptEmployeePII(doc);
});

AllowanceSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Employee', EmployeeSchema);
