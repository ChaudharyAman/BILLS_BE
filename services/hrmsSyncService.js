const axios = require('axios');
const Settings = require('../models/Settings');
const Employee = require('../models/Employee');
const PayrollConfig = require('../models/PayrollConfig');
const Role = require('../models/Role');
const escapeRegex = require('../utils/escapeRegex');
const { decryptPayload, encryptPIIField } = require('../utils/cryptoHelper');
const { buildMasterSalaryStructure } = require('../utils/payrollMath');

// Helper to detect an AES-GCM encrypted response package.
const isEncryptedPackage = (obj) =>
  obj && typeof obj === 'object' && obj.data && obj.iv && obj.salt && obj.authTag;

/**
 * HRMS payType → MyBill Job Role Template definition.
 *
 * | HRMS payType | Template Name         | MyBill payType | useSalaryComponents | employmentType |
 * |--------------|-----------------------|---------------|---------------------|----------------|
 * | salaried     | EMPLOYEE (Salaried)   | salaried      | true                | full-time      |
 * | hourly       | CONSULTANT (Hourly)   | hourly        | false               | contract       |
 * | flat         | INTERN (Salaried)     | salaried      | false               | full-time      |
 */
const PAY_TYPE_ROLE_MAP = {
  salaried: {
    name: 'EMPLOYEE (Salaried)',
    description: 'Standard salaried employee — full component breakdown and statutory deductions.',
    payType: 'salaried',
    employmentType: 'full-time',
    useSalaryComponents: true,
    pfEnabled: true,
    tdsEnabled: true,
    esiEnabled: true,
    ptEnabled: true,
    lwfEnabled: true,
    gratuityEnabled: true,
    includePfInCTC: false,
    includeGratuityInCTC: true,
  },
  hourly: {
    name: 'CONSULTANT (Hourly)',
    description: 'Hourly-rate contractor — no statutory deductions, billed on hours worked.',
    payType: 'hourly',
    employmentType: 'contract',
    useSalaryComponents: false,
    pfEnabled: false,
    tdsEnabled: true,
    esiEnabled: false,
    ptEnabled: false,
    lwfEnabled: false,
    gratuityEnabled: false,
    includePfInCTC: false,
    includeGratuityInCTC: false,
  },
  flat: {
    name: 'INTERN (Salaried)',
    description: 'Flat monthly salary — no component breakdown or deductions applied.',
    payType: 'salaried',
    employmentType: 'full-time',
    useSalaryComponents: false,
    pfEnabled: false,
    tdsEnabled: true,
    esiEnabled: false,
    ptEnabled: false,
    lwfEnabled: false,
    gratuityEnabled: false,
    includePfInCTC: false,
    includeGratuityInCTC: false,
  },
};

const DEFAULT_SALARY_COMPONENTS = [
  { id: 'basic',      name: 'Basic Salary',        type: 'earning', taxable: true,  linkedTo: 'ctc_percent',   linkValue: 0.5, frequency: 'monthly' },
  { id: 'hra',        name: 'HRA',                 type: 'earning', taxable: false, linkedTo: 'basic_percent', linkValue: 0.5, frequency: 'monthly' },
  { id: 'special',    name: 'Special Allowance',   type: 'earning', taxable: true,  linkedTo: 'fixed',         linkValue: 0,   frequency: 'monthly' },
  { id: 'flexi',      name: 'Flexi Allowance',     type: 'earning', taxable: false, linkedTo: 'remainder',     linkValue: 0,   frequency: 'monthly' },
  { id: 'broadband',  name: 'Broadband',           type: 'earning', taxable: false, linkedTo: 'fixed',         linkValue: 0,   frequency: 'monthly' },
  { id: 'petrol',     name: 'Petrol',              type: 'earning', taxable: false, linkedTo: 'fixed',         linkValue: 0,   frequency: 'monthly' },
  { id: 'lta',        name: 'LTA',                 type: 'earning', taxable: false, linkedTo: 'fixed',         linkValue: 0,   frequency: 'monthly' },
  { id: 'conveyance', name: 'Conveyance',          type: 'earning', taxable: false, linkedTo: 'fixed',         linkValue: 0,   frequency: 'monthly' },
  { id: 'medical',    name: 'Medical Allowance',   type: 'earning', taxable: false, linkedTo: 'fixed',         linkValue: 0,   frequency: 'monthly' },
];

/**
 * Finds or creates the appropriate Job Role Template document for a given
 * HRMS payType value ('salaried' | 'hourly' | 'flat'). Returns the Role _id
 * and the resolved field overrides to apply to the Employee document.
 */
const resolvePayrollRoleTemplate = async (userId, hrmsPayType) => {
  const key = String(hrmsPayType || 'salaried').toLowerCase();
  const template = PAY_TYPE_ROLE_MAP[key] || PAY_TYPE_ROLE_MAP.salaried;

  const role = await Role.findOneAndUpdate(
    { user: userId, name: template.name },
    {
      $setOnInsert: { user: userId },
      $set: {
        description: template.description,
        payType: template.payType,
        employmentType: template.employmentType,
        useSalaryComponents: template.useSalaryComponents,
        pfEnabled: template.pfEnabled,
        tdsEnabled: template.tdsEnabled !== false,
        esiEnabled: template.esiEnabled,
        ptEnabled: template.ptEnabled,
        lwfEnabled: template.lwfEnabled,
        gratuityEnabled: template.gratuityEnabled,
        includePfInCTC: template.includePfInCTC,
        includeGratuityInCTC: template.includeGratuityInCTC,
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return {
    roleId: role._id,
    payType: template.payType,
    employmentType: template.employmentType,
    useSalaryComponents: template.useSalaryComponents,
    pfEnabled: template.pfEnabled,
    tdsEnabled: template.tdsEnabled !== false,
    esiEnabled: template.esiEnabled,
    ptEnabled: template.ptEnabled,
    lwfEnabled: template.lwfEnabled,
    gratuityEnabled: template.gratuityEnabled,
    includePfInCTC: template.includePfInCTC,
    includeGratuityInCTC: template.includeGratuityInCTC,
  };
};

exports.resolvePayrollRoleTemplate = resolvePayrollRoleTemplate;

// ─────────────────────────────────────────────────────────────────────────────
// Shared: payroll config sync
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches the payroll configuration from the external HRMS and upserts it into
 * the local PayrollConfig document. Safe to call without awaiting (errors are
 * logged, never thrown). Called by both pull sync and inbound webhook handler.
 *
 * @param {string} userId
 * @param {string} apiUrl
 * @param {string} apiKey
 * @param {string} externalTenantId
 * @param {string} encryptionSecret
 */
exports.syncPayrollConfigFromExternal = async (userId, apiUrl, apiKey, externalTenantId, encryptionSecret) => {
  try {
    const configResponse = await axios.get(`${apiUrl.replace(/\/$/, '')}/api/v1/payroll-config`, {
      params: { tenantId: externalTenantId },
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
      timeout: 5000,
    });

    let hrmsConfig = configResponse.data;
    if (isEncryptedPackage(hrmsConfig)) {
      hrmsConfig = decryptPayload(hrmsConfig, encryptionSecret);
    }
    if (!hrmsConfig) return;

    let config = await PayrollConfig.findOne({ user: userId });
    const updatedFields = {};

    if (typeof hrmsConfig.basicPercent === 'number') updatedFields.basicPercent = hrmsConfig.basicPercent;
    if (typeof hrmsConfig.hraPercent === 'number') updatedFields.hraPercent = hrmsConfig.hraPercent;
    if (typeof hrmsConfig.pfRate === 'number') updatedFields.pfRate = hrmsConfig.pfRate;
    if (typeof hrmsConfig.pfEmployerRate === 'number') updatedFields.pfEmployerRate = hrmsConfig.pfEmployerRate;
    if (typeof hrmsConfig.pfCap === 'number') updatedFields.pfCap = hrmsConfig.pfCap;
    if (hrmsConfig.pfCalculationType) updatedFields.pfCalculationType = hrmsConfig.pfCalculationType;
    if (typeof hrmsConfig.pfAmountEmployee === 'number') updatedFields.pfAmountEmployee = hrmsConfig.pfAmountEmployee;
    if (typeof hrmsConfig.pfAmountEmployer === 'number') updatedFields.pfAmountEmployer = hrmsConfig.pfAmountEmployer;
    if (typeof hrmsConfig.esiEmployeeRate === 'number') updatedFields.esiEmployeeRate = hrmsConfig.esiEmployeeRate;
    if (typeof hrmsConfig.esiEmployerRate === 'number') updatedFields.esiEmployerRate = hrmsConfig.esiEmployerRate;
    if (typeof hrmsConfig.esiBasicThreshold === 'number') updatedFields.esiBasicThreshold = hrmsConfig.esiBasicThreshold;
    if (typeof hrmsConfig.lwfEmployee === 'number') updatedFields.lwfEmployee = hrmsConfig.lwfEmployee;
    if (typeof hrmsConfig.lwfEmployer === 'number') updatedFields.lwfEmployer = hrmsConfig.lwfEmployer;
    if (typeof hrmsConfig.gratuityRate === 'number') updatedFields.gratuityRate = hrmsConfig.gratuityRate;
    if (typeof hrmsConfig.defaultWorkingDays === 'number') updatedFields.defaultWorkingDays = hrmsConfig.defaultWorkingDays;
    if (typeof hrmsConfig.ltaMaxPercent === 'number') updatedFields.ltaMaxPercent = hrmsConfig.ltaMaxPercent;
    if (typeof hrmsConfig.defaultInsurance === 'number') updatedFields.defaultInsurance = hrmsConfig.defaultInsurance;

    if (Array.isArray(hrmsConfig.salaryComponents) && hrmsConfig.salaryComponents.length > 0) {
      const currentComponents = config
        ? [...(config.salaryComponents || [])]
        : [...DEFAULT_SALARY_COMPONENTS];

      hrmsConfig.salaryComponents.forEach(extComp => {
        const idx = currentComponents.findIndex(c => c.id === extComp.id);
        if (idx !== -1) {
          currentComponents[idx] = {
            ...currentComponents[idx],
            name: extComp.name || currentComponents[idx].name,
            linkedTo: extComp.linkedTo || currentComponents[idx].linkedTo,
            linkValue: typeof extComp.linkValue === 'number' ? extComp.linkValue : currentComponents[idx].linkValue,
            taxable: extComp.taxable !== undefined ? extComp.taxable : currentComponents[idx].taxable,
          };
        } else {
          currentComponents.push({
            id: extComp.id,
            name: extComp.name,
            type: extComp.type || 'earning',
            taxable: extComp.taxable !== false,
            linkedTo: extComp.linkedTo || 'fixed',
            linkValue: extComp.linkValue || 0,
            frequency: extComp.frequency || 'monthly',
            isCustom: true,
          });
        }
      });
      updatedFields.salaryComponents = currentComponents;
    }

    if (config) {
      Object.assign(config, updatedFields);
      await config.save();
    } else {
      await PayrollConfig.create({ ...updatedFields, user: userId });
    }
  } catch (err) {
    console.warn('[hrmsSyncService] syncPayrollConfigFromExternal failed:', err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared: employee record mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a raw HRMS employee record to a MyBill Employee updateData object.
 * Handles all field extraction, department auto-create, role template resolution,
 * statutory flag overrides, and salary structure computation.
 *
 * Used by both pull sync (syncEmployeesFromExternal) and inbound webhook
 * (receiveHrmsWebhook), eliminating ~200 lines of duplicated logic.
 *
 * @param {Object} extEmp  - Raw employee object from HRMS payload (pull or webhook)
 * @param {string} userId  - MyBill user (_id) that owns this employee record
 * @param {Object} config  - Local PayrollConfig document (may be null)
 * @returns {{ empId: string, email: string, updateData: Object, hrmsPayType: string }}
 * @throws {Error} When empId or email is missing from the source record
 */
exports.mapHrmsEmployeeToUpdateData = async (extEmp, userId, config) => {
  const empId = String(
    extEmp.employeeId || extEmp.employeeCode || extEmp.emp_id || extEmp.emp_code ||
    extEmp.employee_code || extEmp.userId || extEmp._id || ''
  ).trim();

  const email = String(
    extEmp.email || extEmp.corporate_email || extEmp.work_email ||
    extEmp.personal?.workEmail || extEmp.contact?.workEmail || ''
  ).trim().toLowerCase();

  if (!empId || !email) {
    throw new Error('Missing employeeId or email in sync record');
  }

  const phone = String(
    extEmp.phone || extEmp.phone_number || extEmp.contact_no ||
    extEmp.personal?.mobileNumber || extEmp.contact?.mobileNumber || ''
  ).trim();

  const rawGender = extEmp.gender || extEmp.personal?.gender || '';
  const gender = ['Male', 'Female', 'Other'].includes(rawGender) ? rawGender : '';

  const designation = extEmp.designation || extEmp.job_title || extEmp.employment?.designation || '';
  const location = extEmp.location || extEmp.city || extEmp.workLocation || extEmp.employment?.workLocation || '';

  const joiningDateVal = extEmp.joiningDate || extEmp.date_of_joining || extEmp.employment?.joiningDate;
  const joiningDate = joiningDateVal ? new Date(joiningDateVal) : new Date();

  const status = (
    extEmp.status === 'inactive' ||
    extEmp.is_active === false ||
    extEmp.isActive === false ||
    extEmp.employment?.status === 'inactive'
  ) ? 'inactive' : 'active';

  const monthlyCTC = Number(
    extEmp.monthlyCTC || extEmp.ctc || extEmp.base_salary_monthly || extEmp.compensation?.ctc
  ) || 0;

  // Encrypt PII fields at extraction time so the value stored in updateData is always
  // ciphertext, regardless of the write path (.create() or .updateOne()). The Employee
  // pre('save') hook also calls encryptPIIField, but it only fires on .save() — not on
  // .updateOne(). By encrypting here we fix the regression where re-syncing an existing
  // employee overwrites encrypted PAN/Aadhaar with plaintext.
  // encryptPIIField is idempotent: it is a no-op for values already prefixed with 'enc:v1:'.
  const panNumber    = encryptPIIField(extEmp.panNumber    || extEmp.pan    || extEmp.identity?.panNumber    || '');
  const aadharNumber = encryptPIIField(extEmp.aadharNumber || extEmp.aadhar || extEmp.aadhaar || extEmp.identity?.aadhaarNumber || '');
  const uanNumber    = encryptPIIField(extEmp.uanNumber    || extEmp.bankDetails?.uanNumber || '');
  const esiNumber    = encryptPIIField(extEmp.esiNumber    || extEmp.esi_number || '');

  const bankDetails = {
    accountName: (
      extEmp.bankDetails?.accountName ||
      extEmp.bankDetails?.accountHolderName ||
      extEmp.bank_account_name ||
      `${extEmp.firstName || extEmp.personal?.firstName || ''} ${extEmp.lastName || extEmp.personal?.lastName || ''}`.trim()
    ),
    accountNumber: encryptPIIField(extEmp.bankDetails?.accountNumber || extEmp.bank_account_no || ''),
    ifscCode:      extEmp.bankDetails?.ifscCode  || extEmp.bank_ifsc  || '',
    bankName:      extEmp.bankDetails?.bankName  || extEmp.bank_name  || '',
  };

  // Statutory flags — read from per-employee compensation data
  const pfEnabled           = extEmp.compensation?.pfEnabled           !== undefined ? extEmp.compensation.pfEnabled           : true;
  const tdsEnabled          = extEmp.compensation?.tdsEnabled          !== undefined ? extEmp.compensation.tdsEnabled          : true;
  const esiEnabled          = extEmp.compensation?.esiEnabled          !== undefined ? extEmp.compensation.esiEnabled          : true;
  const ptEnabled           = extEmp.compensation?.ptEnabled           !== undefined ? extEmp.compensation.ptEnabled           : true;
  const lwfEnabled          = extEmp.compensation?.lwfEnabled          !== undefined ? extEmp.compensation.lwfEnabled          : true;
  const gratuityEnabled     = extEmp.compensation?.gratuityEnabled     !== undefined ? extEmp.compensation.gratuityEnabled     : true;
  const includePfInCTC      = extEmp.compensation?.includePfInCTC      !== undefined ? extEmp.compensation.includePfInCTC      : false;
  const includeGratuityInCTC = extEmp.compensation?.includeGratuityInCTC !== undefined ? extEmp.compensation.includeGratuityInCTC : true;
  const basicPercent        = extEmp.compensation?.basicPercent        != null ? Number(extEmp.compensation.basicPercent)  : null;
  const hraPercent          = extEmp.compensation?.hraPercent          != null ? Number(extEmp.compensation.hraPercent)   : null;
  const useSalaryComponents = extEmp.compensation?.useSalaryComponents !== undefined ? extEmp.compensation.useSalaryComponents : true;
  const ptState             = extEmp.compensation?.ptState || '';

  // ── Department lookup / auto-create ───────────────────────────────────────
  let departmentName = String(extEmp.department || extEmp.dept || extEmp.employment?.department || '').trim();
  if (
    (departmentName.startsWith('"') && departmentName.endsWith('"')) ||
    (departmentName.startsWith("'") && departmentName.endsWith("'"))
  ) {
    departmentName = departmentName.slice(1, -1).trim();
  }
  let departmentId = null;
  if (departmentName) {
    const Department = require('../models/Department');
    let dept = await Department.findOne({
      user: userId,
      name: { $regex: new RegExp(`^${escapeRegex(departmentName)}$`, 'i') },
    });
    if (!dept) {
      let baseCode = departmentName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5).toUpperCase() || 'DEPT';
      let code = baseCode;
      let counter = 1;
      while (await Department.exists({ user: userId, code })) {
        code = `${baseCode}${counter}`;
        counter += 1;
      }
      dept = await Department.create({
        user: userId,
        name: departmentName,
        code,
        description: 'Auto-created during sync',
      });
    }
    if (dept) departmentId = dept._id;
  }

  // ── Salary breakup extraction ─────────────────────────────────────────────
  const extBreakup = extEmp.compensation?.salaryBreakup || {};

  // Keys that belong to infrastructure/statutory metadata — excluded from otherAllowances
  const baseStandardKeys = new Set([
    'pfenabled', 'tdsenabled', 'esienabled', 'ptenabled', 'lwfenabled', 'gratuityenabled',
    'includepfinctc', 'includegratuityinctc', 'basicpercent', 'hrapercent',
    'usesalarycomponents', 'ptstate', 'paytype',
    'annualctc', 'monthlyctc', 'monthlygross', 'pfemployer', 'pfemployee', 'gratuity',
    'lwfemployer', 'lwfemployee', 'esiemployer', 'esiemployee',
    'professionaltax', 'professionaltaxval', 'tds', 'nettakehome', 'flatsalary',
  ]);

  const standardBreakupKeys = new Set(baseStandardKeys);
  const activeComponents = config?.salaryComponents?.length > 0
    ? config.salaryComponents
    : DEFAULT_SALARY_COMPONENTS;

  const componentAliases = {
    medical:   ['medicalallowance'],
    flexi:     ['flexiallowance', 'flexiamount'],
    insurance: ['default_insurance_amount', 'insuranceamount'],
    special:   ['specialallowance'],
  };

  activeComponents.forEach(c => {
    if (!c.id) return;
    const key = c.id.toLowerCase();
    standardBreakupKeys.add(key);
    (componentAliases[key] || []).forEach(alias => standardBreakupKeys.add(alias));
  });

  const getComponentValue = (compId) => {
    if (!activeComponents.some(c => c.id === compId)) return 0;
    if (compId === 'basic')     return Number(extBreakup.basic     || extEmp.basic     || 0);
    if (compId === 'hra')       return Number(extBreakup.hra       || extEmp.hra       || 0);
    if (compId === 'conveyance') return Number(extBreakup.conveyance || extEmp.conveyance || 0);
    if (compId === 'medical')   return Number(extBreakup.medical || extBreakup.medicalAllowance || extEmp.medical || extEmp.medicalAllowance || 0);
    if (compId === 'flexi')     return Number(extBreakup.flexi  || extBreakup.flexiAllowance   || extEmp.flexiAmount || extEmp.flexi || 0);
    if (compId === 'broadband') return Number(extBreakup.broadband || extEmp.broadband || 0);
    if (compId === 'petrol')    return Number(extBreakup.petrol    || extEmp.petrol    || 0);
    if (compId === 'lta')       return Number(extBreakup.lta       || extEmp.lta       || 0);
    const match = Object.entries(extBreakup).find(([k]) => k.toLowerCase() === compId.toLowerCase());
    return match ? Number(match[1]) || 0 : 0;
  };

  const basic           = getComponentValue('basic');
  const hra             = getComponentValue('hra');
  const conveyance      = getComponentValue('conveyance');
  const medicalAllowance = getComponentValue('medical');
  const flexiAmount     = getComponentValue('flexi');
  const broadband       = getComponentValue('broadband');
  const petrol          = getComponentValue('petrol');
  const lta             = getComponentValue('lta');

  const employerNPS     = Number(extBreakup.employerNPS || extBreakup.nps    || extEmp.employerNPS || extEmp.nps    || 0);
  const insuranceAmount = Number(extBreakup.insuranceAmount || extBreakup.insurance || extEmp.insuranceAmount || extEmp.insurance || 0);

  const otherAllowances = [];
  for (const [key, value] of Object.entries(extBreakup)) {
    if (!standardBreakupKeys.has(key.toLowerCase())) {
      const numVal = Number(value);
      if (Number.isFinite(numVal) && numVal > 0) {
        otherAllowances.push({ name: key, amount: numVal });
      }
    }
  }

  // ── Role template & statutory flag resolution ─────────────────────────────
  const hrmsPayType = String(extBreakup.payType || extBreakup.paytype || 'salaried').toLowerCase();
  const roleTemplate = await resolvePayrollRoleTemplate(userId, hrmsPayType);

  // For salaried employees honour the per-employee flags from HRMS; for hourly/flat
  // the template governs (those types always have specific statutory rules).
  const isSalaried = hrmsPayType === 'salaried';
  const resolvedPfEnabled            = isSalaried ? pfEnabled            : roleTemplate.pfEnabled;
  const resolvedTdsEnabled           = isSalaried ? tdsEnabled           : roleTemplate.tdsEnabled;
  const resolvedEsiEnabled           = isSalaried ? esiEnabled           : roleTemplate.esiEnabled;
  const resolvedPtEnabled            = isSalaried ? ptEnabled            : roleTemplate.ptEnabled;
  const resolvedLwfEnabled           = isSalaried ? lwfEnabled           : roleTemplate.lwfEnabled;
  const resolvedGratuityEnabled      = isSalaried ? gratuityEnabled      : roleTemplate.gratuityEnabled;
  const resolvedIncludePfInCTC       = isSalaried ? includePfInCTC       : roleTemplate.includePfInCTC;
  const resolvedIncludeGratuityInCTC = isSalaried ? includeGratuityInCTC : roleTemplate.includeGratuityInCTC;
  const resolvedUseSalaryComponents  = isSalaried ? useSalaryComponents  : roleTemplate.useSalaryComponents;

  // ── Build and compute final update payload ────────────────────────────────
  const updateData = {
    employeeId: empId,
    firstName:  extEmp.firstName || extEmp.personal?.firstName || 'Unknown',
    lastName:   extEmp.lastName  || extEmp.personal?.lastName  || 'Employee',
    email,
    phone,
    gender,
    designation,
    location,
    joiningDate,
    status,
    monthlyCTC,
    panNumber,
    aadharNumber,
    uanNumber,
    esiNumber,
    bankDetails,
    department:             departmentId,
    role:                   roleTemplate.roleId,
    payType:                roleTemplate.payType,
    employmentType:         roleTemplate.employmentType,
    pfEnabled:              resolvedPfEnabled,
    tdsEnabled:             resolvedTdsEnabled,
    esiEnabled:             resolvedEsiEnabled,
    ptEnabled:              resolvedPtEnabled,
    lwfEnabled:             resolvedLwfEnabled,
    gratuityEnabled:        resolvedGratuityEnabled,
    includePfInCTC:         resolvedIncludePfInCTC,
    includeGratuityInCTC:   resolvedIncludeGratuityInCTC,
    basicPercent,
    hraPercent,
    useSalaryComponents:    resolvedUseSalaryComponents,
    ptState,
    broadband,
    petrol,
    lta,
    employerNPS,
    insuranceAmount,
    flexiAmount,
    basic,
    hra,
    salaryStructure: { basic, hra, conveyance, medicalAllowance, otherAllowances },
  };

  // Recompute derived salary structure via the shared utility
  const master = buildMasterSalaryStructure(updateData, config || {});
  updateData.flexiAmount   = master.flexi;
  updateData.broadband     = master.broadband;
  updateData.petrol        = master.petrol;
  updateData.lta           = master.lta;
  updateData.salaryStructure = {
    basic:           master.basicMaster,
    hra:             master.hraMaster,
    conveyance,
    medicalAllowance,
    specialAllowance: master.specialAllowance,
    grossSalary:      master.grossSalary,
    ctc:              master.grossTotalSalary,
    otherAllowances,
  };

  return { empId, email, updateData, hrmsPayType };
};

// ─────────────────────────────────────────────────────────────────────────────
// Pull sync: employees
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch and upsert employee profiles from external multi-tenant HRMS.
 */
exports.syncEmployeesFromExternal = async (userId) => {
  const settings = await Settings.findOne({ user: userId });
  if (!settings || !settings.integration?.enabled) {
    throw new Error('HRMS integration is disabled or not configured for this organization.');
  }

  const { apiUrl, apiKey, externalTenantId, encryptionSecret } = settings.integration;
  if (!apiUrl) throw new Error('HRMS API URL is not configured.');

  try {
    // 1. Sync payroll config first so salary-structure computation uses fresh rates
    await exports.syncPayrollConfigFromExternal(userId, apiUrl, apiKey, externalTenantId, encryptionSecret);

    let config = await PayrollConfig.findOne({ user: userId });
    if (!config) {
      config = await PayrollConfig.create({ user: userId, salaryComponents: DEFAULT_SALARY_COMPONENTS });
    }

    // 2. Fetch employee list
    const response = await axios.get(`${apiUrl.replace(/\/$/, '')}/api/v1/employees`, {
      params: { tenantId: externalTenantId },
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
      timeout: 10000,
    });

    let rawData = response.data;
    if (isEncryptedPackage(rawData)) {
      rawData = decryptPayload(rawData, encryptionSecret);
    }

    const employeesList = Array.isArray(rawData) ? rawData : (rawData?.employees || []);
    if (!employeesList.length) {
      return { created: 0, updated: 0, message: 'No employees found in external HRMS payload.' };
    }

    let createdCount = 0;
    let updatedCount = 0;
    const errors  = [];
    const details = [];

    for (const extEmp of employeesList) {
      try {
        const { empId, email, updateData, hrmsPayType } = await exports.mapHrmsEmployeeToUpdateData(extEmp, userId, config);

        const query = { user: userId, employeeId: empId };
        const existingEmp = await Employee.findOne(query);
        if (existingEmp) {
          await Employee.updateOne(query, { $set: updateData });
          updatedCount += 1;
        } else {
          await Employee.create({ ...updateData, user: userId });
          createdCount += 1;
        }

        details.push({
          employeeId: empId,
          name: `${updateData.firstName} ${updateData.lastName}`.trim(),
          email,
          monthlyCTC:    updateData.monthlyCTC,
          roleTemplateName: PAY_TYPE_ROLE_MAP[hrmsPayType]?.name || PAY_TYPE_ROLE_MAP.salaried.name,
          pfEnabled:     updateData.pfEnabled,
          tdsEnabled:    updateData.tdsEnabled,
          esiEnabled:    updateData.esiEnabled,
          flexiAmount:   updateData.flexiAmount,
          customAllowances: updateData.salaryStructure.otherAllowances
            .map(a => `${a.name}: ₹${a.amount}`).join(', ') || 'None',
          status: updateData.status === 'active' ? 'Active' : 'Inactive',
        });
      } catch (err) {
        errors.push({ id: extEmp.employeeId || extEmp.emp_id || 'unknown', error: err.message });
      }
    }

    return { created: createdCount, updated: updatedCount, errors, details };
  } catch (error) {
    console.error('hrmsSyncService syncEmployees error:', error.message);
    throw new Error(`Sync connection failed: ${error.message}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Pull sync: attendance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch monthly attendance summary from external multi-tenant Attendance system.
 *
 * The HRMS returns per-employee:
 *   workingDays   - total schedulable working days for the employee this month
 *   presentDays   - actual PRESENT + HALF_DAY count from Attendance records
 *   absentDays    - workingDays not covered by presence or approved leaves
 *   paidLeaves    - approved paid leave days in the month
 *   unpaidLeaves  - approved unpaid leave days in the month
 *
 * paidDays (for payroll proration) = presentDays + paidLeaves, clamped to [0, workingDays].
 *
 * Results are both returned (for immediate payroll use) and persisted to
 * AttendanceSyncCache so they can be re-read without re-fetching from HRMS.
 */
exports.syncAttendanceFromExternal = async (userId, month, year) => {
  const settings = await Settings.findOne({ user: userId });
  if (!settings || !settings.integration?.enabled) {
    throw new Error('HRMS/Attendance integration is disabled.');
  }

  const { apiUrl, apiKey, externalTenantId, encryptionSecret } = settings.integration;
  if (!apiUrl) throw new Error('HRMS/Attendance API URL is not configured.');

  try {
    const response = await axios.get(`${apiUrl.replace(/\/$/, '')}/api/v1/attendance`, {
      params: { tenantId: externalTenantId, month, year },
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
      timeout: 10000,
    });

    let rawData = response.data;
    if (isEncryptedPackage(rawData)) {
      rawData = decryptPayload(rawData, encryptionSecret);
    }

    const attendanceRecords = Array.isArray(rawData) ? rawData : (rawData?.attendance || []);
    const now = new Date();
    const isCurrentMonth = (now.getFullYear() === year) && ((now.getMonth() + 1) === month);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const totalMonthDays = new Date(year, month, 0).getDate();
    const calendarDays = isCurrentMonth ? now.getDate() : totalMonthDays;
    const localEmployees = await Employee.find({ user: userId }).select('_id employeeId joiningDate dateOfLeaving');

    const mapped = [];
    localEmployees.forEach(emp => {
      const record = attendanceRecords.find(r => {
        const rId = String(r.employeeId || r.emp_id || r.employeeCode || '').trim().toLowerCase();
        const eId = String(emp.employeeId || '').trim().toLowerCase();
        return (rId && eId && rId === eId) || (rId && emp._id && rId === String(emp._id).toLowerCase());
      });

      const startOfMonth = new Date(year, month - 1, 1);
      const endOfMonth   = new Date(year, month, 0);
      const effectiveMonthEnd = (isCurrentMonth && today < endOfMonth) ? today : endOfMonth;

      const jDate = emp.joiningDate   ? new Date(emp.joiningDate)   : startOfMonth;
      const lDate = emp.dateOfLeaving ? new Date(emp.dateOfLeaving) : effectiveMonthEnd;

      const activeStart = jDate > startOfMonth ? jDate : startOfMonth;
      const activeEnd   = lDate < effectiveMonthEnd ? lDate : effectiveMonthEnd;

      const activeStartMidnight = new Date(activeStart.getFullYear(), activeStart.getMonth(), activeStart.getDate());
      const activeEndMidnight   = new Date(activeEnd.getFullYear(),   activeEnd.getMonth(),   activeEnd.getDate());

      let activeCalendarDays = 0;
      if (activeStartMidnight <= activeEndMidnight) {
        const diffTime = Math.max(0, activeEndMidnight.getTime() - activeStartMidnight.getTime());
        activeCalendarDays = Math.round(diffTime / (1000 * 60 * 60 * 24)) + 1;
      }

      if (record) {
        const hrmsWorkingDays = record.workingDays !== undefined ? Number(record.workingDays) : 23;
        const presentDays = record.presentDays !== undefined
          ? Number(record.presentDays)
          : (record.workingDays !== undefined ? Number(record.workingDays) : 0);

        const unpaidLeaves = Number(record.unpaidLeaves || record.unpaid_leaves || 0);
        const paidLeaves   = Number(record.paidLeaves   || record.paid_leaves   || 0);
        const absentDays   = record.absentDays !== undefined
          ? Number(record.absentDays)
          : Math.max(hrmsWorkingDays - presentDays - paidLeaves - unpaidLeaves, 0);

        const lop = absentDays + unpaidLeaves;
        let paidDays = Math.min(Math.max(activeCalendarDays - lop, 0), calendarDays);

        mapped.push({
          employeeId:     emp._id,
          employeeNumber: emp.employeeId,
          workingDays:    calendarDays,
          presentDays,
          absentDays,
          paidDays,
          unpaidLeaves,
          paidLeaves,
        });
      } else {
        mapped.push({
          employeeId:     emp._id,
          employeeNumber: emp.employeeId,
          workingDays:    calendarDays,
          presentDays:    0,
          absentDays:     activeCalendarDays,
          paidDays:       0,
          unpaidLeaves:   0,
          paidLeaves:     0,
        });
      }
    });

    // Persist to AttendanceSyncCache so results survive the request lifecycle
    if (mapped.length > 0) {
      const AttendanceSyncCache = require('../models/AttendanceSyncCache');
      const bulkOps = mapped.map(r => ({
        updateOne: {
          filter: { user: userId, employeeId: r.employeeId, month, year },
          update: {
            $set: {
              employeeNumber: r.employeeNumber,
              workingDays:   r.workingDays,
              presentDays:   r.presentDays,
              absentDays:    r.absentDays,
              paidDays:      r.paidDays,
              unpaidLeaves:  r.unpaidLeaves,
              paidLeaves:    r.paidLeaves,
              syncedAt:      new Date(),
            },
          },
          upsert: true,
        },
      }));
      await AttendanceSyncCache.bulkWrite(bulkOps, { ordered: false });
    }

    return mapped;
  } catch (error) {
    console.error('hrmsSyncService syncAttendance error:', error.message);
    throw new Error(`Attendance fetch failed: ${error.message}`);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Reverse sync: dispatch payroll result to HRMS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sends a payroll result notification to the external HRMS after a payroll
 * record is marked as paid. Non-blocking — the caller should fire this without
 * awaiting. Failures are logged but never surfaced to the user response.
 *
 * @param {Object} payroll  - Mongoose Payroll document (fully populated)
 * @param {Object} settings - Mongoose Settings document for this user
 */
exports.dispatchPayrollResultToHrms = async (payroll, settings) => {
  if (!settings?.integration?.enabled) return;

  const { apiUrl, apiKey, externalTenantId, webhookSecret } = settings.integration;
  if (!apiUrl || !apiKey || !externalTenantId || !webhookSecret) return;

  const crypto = require('crypto');

  const employeeCode =
    payroll.employeeSnapshot?.employeeId ||
    payroll.employee?.employeeId         ||
    String(payroll.employee?._id || payroll.employee || '');

  const payload = {
    event:    'payroll.paid',
    tenantId: externalTenantId,
    timestamp: new Date().toISOString(),
    payrollResult: {
      employeeCode,
      month:           payroll.month,
      year:            payroll.year,
      status:          'paid',
      netSalary:       payroll.netSalary                     || 0,
      grossSalary:     payroll.earnings?.totalEarnings        || 0,
      totalDeductions: payroll.deductions?.totalDeductions   || 0,
      paidDate:        payroll.paymentDate,
      breakdown: {
        basic: payroll.earnings?.basic          || 0,
        hra:   payroll.earnings?.hra            || 0,
        pf:    payroll.deductions?.pfEmployee   || 0,
        esi:   payroll.deductions?.esiEmployee  || 0,
        tds:   payroll.deductions?.tds          || 0,
        pt:    payroll.deductions?.professionalTax || 0,
        lwf:   payroll.deductions?.lwfEmployee  || 0,
      },
    },
  };

  const signature = crypto
    .createHmac('sha256', webhookSecret)
    .update(JSON.stringify(payload))
    .digest('hex');

  try {
    await axios.post(`${apiUrl.replace(/\/$/, '')}/api/v1/payroll-result`, payload, {
      headers: {
        'Content-Type':       'application/json',
        'Authorization':      `Bearer ${apiKey}`,
        'x-mybills-signature': signature,
      },
      timeout: 10000,
    });
  } catch (err) {
    console.error('[hrmsSyncService] dispatchPayrollResultToHrms failed:', err.message);
  }
};
