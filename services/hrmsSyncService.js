const axios = require('axios');
const Settings = require('../models/Settings');
const Employee = require('../models/Employee');
const PayrollConfig = require('../models/PayrollConfig');
const Role = require('../models/Role');
const { decryptPayload } = require('../utils/cryptoHelper');
const { buildMasterSalaryStructure } = require('../utils/payrollMath');

// Helper to determine if a payload is AES-GCM encrypted
const isEncryptedPackage = (obj) => {
  return obj && typeof obj === 'object' && obj.data && obj.iv && obj.salt && obj.authTag;
};

/**
 * HRMS payType -> MyBill Job Role Template definition.
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
    esiEnabled: false,
    ptEnabled: false,
    lwfEnabled: false,
    gratuityEnabled: false,
    includePfInCTC: false,
    includeGratuityInCTC: false,
  },
};

const DEFAULT_SALARY_COMPONENTS = [
  { id: 'basic',                    name: 'Basic Salary',                  type: 'earning',   taxable: true,  linkedTo: 'ctc_percent',   linkValue: 0.5,           frequency: 'monthly' },
  { id: 'hra',                      name: 'HRA',                           type: 'earning',   taxable: false, linkedTo: 'basic_percent', linkValue: 0.5,             frequency: 'monthly' },
  { id: 'special',                  name: 'Special Allowance',             type: 'earning',   taxable: true,  linkedTo: 'fixed',         linkValue: 0,             frequency: 'monthly' },
  { id: 'flexi',                    name: 'Flexi Allowance',               type: 'earning',   taxable: false, linkedTo: 'remainder',     linkValue: 0,             frequency: 'monthly' },
  { id: 'broadband',                name: 'Broadband',                     type: 'earning',   taxable: false, linkedTo: 'fixed',         linkValue: 0,             frequency: 'monthly' },
  { id: 'petrol',                   name: 'Petrol',                        type: 'earning',   taxable: false, linkedTo: 'fixed',         linkValue: 0,             frequency: 'monthly' },
  { id: 'lta',                      name: 'LTA',                           type: 'earning',   taxable: false, linkedTo: 'fixed',         linkValue: 0,             frequency: 'monthly' },
  { id: 'conveyance',               name: 'Conveyance',                    type: 'earning',   taxable: false, linkedTo: 'fixed',         linkValue: 0,             frequency: 'monthly' },
  { id: 'medical',                  name: 'Medical Allowance',             type: 'earning',   taxable: false, linkedTo: 'fixed',         linkValue: 0,             frequency: 'monthly' },
];

/**
 * Finds or creates the appropriate Job Role Template document for a given
 * HRMS payType value ('salaried' | 'hourly' | 'flat'). Returns the Role _id
 * and the resolved field overrides to apply to the Employee document.
 */
const resolvePayrollRoleTemplate = async (userId, hrmsPayType) => {
  const key = String(hrmsPayType || 'salaried').toLowerCase();
  const template = PAY_TYPE_ROLE_MAP[key] || PAY_TYPE_ROLE_MAP.salaried;

  // Upsert: create if not exists, always keep description/flags up-to-date
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
    // For flat/hourly: disable all statutory deductions to match HRMS intent
    pfEnabled: template.pfEnabled,
    esiEnabled: template.esiEnabled,
    ptEnabled: template.ptEnabled,
    lwfEnabled: template.lwfEnabled,
    gratuityEnabled: template.gratuityEnabled,
    includePfInCTC: template.includePfInCTC,
    includeGratuityInCTC: template.includeGratuityInCTC,
  };
};

exports.resolvePayrollRoleTemplate = resolvePayrollRoleTemplate;

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
    // 1. Fetch Payroll Config from HRMS to align settings dynamically
    let hrmsConfig = null;
    try {
      const configResponse = await axios.get(`${apiUrl.replace(/\/$/, '')}/api/v1/payroll-config`, {
        params: { tenantId: externalTenantId },
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json'
        },
        timeout: 5000
      });
      let configData = configResponse.data;
      if (isEncryptedPackage(configData)) {
        configData = decryptPayload(configData, encryptionSecret);
      }
      if (configData) {
        hrmsConfig = configData;
      }
    } catch (configError) {
      console.warn('Failed to fetch payroll config from HRMS, using local/default payroll config:', configError.message);
    }

    let config = await PayrollConfig.findOne({ user: userId });
    if (hrmsConfig) {
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
        const currentComponents = config ? [...(config.salaryComponents || [])] : [...DEFAULT_SALARY_COMPONENTS];
        
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
              isCustom: true
            });
          }
        });
        updatedFields.salaryComponents = currentComponents;
      }

      if (config) {
        Object.assign(config, updatedFields);
        await config.save();
      } else {
        config = await PayrollConfig.create({
          ...updatedFields,
          user: userId
        });
      }
    } else {
      if (!config) {
        config = await PayrollConfig.create({
          user: userId,
          salaryComponents: DEFAULT_SALARY_COMPONENTS
        });
      }
    }

    const response = await axios.get(`${apiUrl.replace(/\/$/, '')}/api/v1/employees`, {
      params: { tenantId: externalTenantId },
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
      },
      timeout: 10000 // 10s timeout
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
    const errors = [];
    const details = [];

    for (const extEmp of employeesList) {
      try {
        const empId = String(
          extEmp.employeeId ||
          extEmp.employeeCode ||
          extEmp.emp_id ||
          extEmp.emp_code ||
          extEmp.employee_code ||
          extEmp.userId ||
          extEmp._id ||
          ''
        ).trim();

        const email = String(
          extEmp.email ||
          extEmp.corporate_email ||
          extEmp.work_email ||
          extEmp.personal?.workEmail ||
          extEmp.contact?.workEmail ||
          ''
        ).trim().toLowerCase();

        if (!empId || !email) {
          errors.push({ id: empId || 'unknown', error: 'Missing employeeId or email in sync record' });
          continue;
        }

        const phone = String(
          extEmp.phone ||
          extEmp.phone_number ||
          extEmp.contact_no ||
          extEmp.personal?.mobileNumber ||
          extEmp.contact?.mobileNumber ||
          ''
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
          extEmp.monthlyCTC ||
          extEmp.ctc ||
          extEmp.base_salary_monthly ||
          extEmp.compensation?.ctc
        ) || 0;

        const panNumber = extEmp.panNumber || extEmp.pan || extEmp.identity?.panNumber || '';
        const aadharNumber = extEmp.aadharNumber || extEmp.aadhar || extEmp.aadhaar || extEmp.identity?.aadhaarNumber || '';
        const uanNumber = extEmp.uanNumber || extEmp.bankDetails?.uanNumber || '';

        const bankDetails = {
          accountName: (
            extEmp.bankDetails?.accountName ||
            extEmp.bankDetails?.accountHolderName ||
            extEmp.bank_account_name ||
            `${extEmp.firstName || extEmp.personal?.firstName || ''} ${extEmp.lastName || extEmp.personal?.lastName || ''}`.trim()
          ),
          accountNumber: extEmp.bankDetails?.accountNumber || extEmp.bank_account_no || '',
          ifscCode: extEmp.bankDetails?.ifscCode || extEmp.bank_ifsc || '',
          bankName: extEmp.bankDetails?.bankName || extEmp.bank_name || ''
        };

        const pfEnabled = extEmp.compensation?.pfEnabled !== undefined ? extEmp.compensation.pfEnabled : true;
        const esiEnabled = extEmp.compensation?.esiEnabled !== undefined ? extEmp.compensation.esiEnabled : true;
        const ptEnabled = extEmp.compensation?.ptEnabled !== undefined ? extEmp.compensation.ptEnabled : true;
        const lwfEnabled = extEmp.compensation?.lwfEnabled !== undefined ? extEmp.compensation.lwfEnabled : true;
        const gratuityEnabled = extEmp.compensation?.gratuityEnabled !== undefined ? extEmp.compensation.gratuityEnabled : true;
        const includePfInCTC = extEmp.compensation?.includePfInCTC !== undefined ? extEmp.compensation.includePfInCTC : false;
        const includeGratuityInCTC = extEmp.compensation?.includeGratuityInCTC !== undefined ? extEmp.compensation.includeGratuityInCTC : true;
        const basicPercent = extEmp.compensation?.basicPercent !== undefined && extEmp.compensation.basicPercent !== null ? Number(extEmp.compensation.basicPercent) : null;
        const hraPercent = extEmp.compensation?.hraPercent !== undefined && extEmp.compensation.hraPercent !== null ? Number(extEmp.compensation.hraPercent) : null;
        const useSalaryComponents = extEmp.compensation?.useSalaryComponents !== undefined ? extEmp.compensation.useSalaryComponents : true;
        const ptState = extEmp.compensation?.ptState || '';

        // Department lookup or create by name
        let departmentName = String(extEmp.department || extEmp.dept || extEmp.employment?.department || '').trim();
        if ((departmentName.startsWith('"') && departmentName.endsWith('"')) || (departmentName.startsWith("'") && departmentName.endsWith("'"))) {
          departmentName = departmentName.slice(1, -1).trim();
        }
        let departmentId = null;
        if (departmentName) {
          const Department = require('../models/Department');
          const escapeRegex = (string) => string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
          let dept = await Department.findOne({
            user: userId,
            name: { $regex: new RegExp(`^${escapeRegex(departmentName)}$`, 'i') },
          });
          if (!dept) {
            let baseCode = departmentName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5).toUpperCase();
            if (!baseCode) baseCode = 'DEPT';
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

        const extBreakup = extEmp.compensation?.salaryBreakup || {};

        // Base standard keys that are NOT custom/other allowances (infrastructure/statutory flags/computed values)
        const baseStandardKeys = new Set([
          'pfenabled', 'esienabled', 'ptenabled', 'lwfenabled', 'gratuityenabled',
          'includepfinctc', 'includegratuityinctc', 'basicpercent', 'hrapercent',
          'usesalarycomponents', 'ptstate', 'paytype',
          'annualctc', 'monthlyctc', 'monthlygross', 'pfemployer', 'pfemployee', 'gratuity',
          'lwfemployer', 'lwfemployee', 'esiemployer', 'esiemployee',
          'professionaltax', 'professionaltaxval', 'tds', 'nettakehome', 'flatsalary'
        ]);

        const standardBreakupKeys = new Set(baseStandardKeys);
        const activeComponents = config?.salaryComponents && config.salaryComponents.length > 0 ? config.salaryComponents : DEFAULT_SALARY_COMPONENTS;

        // Add config-defined components to standardBreakupKeys dynamically
        activeComponents.forEach(c => {
          if (!c.id) return;
          standardBreakupKeys.add(c.id.toLowerCase());
          // Add standard spelling variations of config-defined components
          if (c.id === 'medical') {
            standardBreakupKeys.add('medicalallowance');
          } else if (c.id === 'flexi') {
            standardBreakupKeys.add('flexiallowance');
            standardBreakupKeys.add('flexiamount');
          } else if (c.id === 'default_insurance_amount' || c.id === 'insurance') {
            standardBreakupKeys.add('default_insurance_amount');
            standardBreakupKeys.add('insurance');
            standardBreakupKeys.add('insuranceamount');
          } else if (c.id === 'special' || c.id === 'specialAllowance') {
            standardBreakupKeys.add('specialallowance');
            standardBreakupKeys.add('special');
          }
        });

        // Dynamic helper to extract active component values from the HRMS payload
        const getComponentValue = (compId) => {
          const isActive = activeComponents.some(c => c.id === compId);
          if (!isActive) return 0;

          if (compId === 'basic') return Number(extBreakup.basic || extEmp.basic || 0);
          if (compId === 'hra') return Number(extBreakup.hra || extEmp.hra || 0);
          if (compId === 'conveyance') return Number(extBreakup.conveyance || extEmp.conveyance || 0);
          if (compId === 'medical') {
            return Number(extBreakup.medical || extBreakup.medicalAllowance || extEmp.medical || extEmp.medicalAllowance || 0);
          }
          if (compId === 'flexi') {
            return Number(extBreakup.flexi || extBreakup.flexiAllowance || extEmp.flexiAmount || extEmp.flexi || 0);
          }
          if (compId === 'broadband') return Number(extBreakup.broadband || extEmp.broadband || 0);
          if (compId === 'petrol') return Number(extBreakup.petrol || extEmp.petrol || 0);
          if (compId === 'lta') return Number(extBreakup.lta || extEmp.lta || 0);

          // Fallback lookup by compId (case-insensitive) in extBreakup
          const match = Object.entries(extBreakup).find(([k]) => k.toLowerCase() === compId.toLowerCase());
          return match ? Number(match[1]) || 0 : 0;
        };

        const basic = getComponentValue('basic');
        const hra = getComponentValue('hra');
        const conveyance = getComponentValue('conveyance');
        const medicalAllowance = getComponentValue('medical');
        const flexiAmount = getComponentValue('flexi');
        const broadband = getComponentValue('broadband');
        const petrol = getComponentValue('petrol');
        const lta = getComponentValue('lta');

        // Standalone fields in MyBills calculator (always parsed if available in payload)
        const employerNPS = Number(extBreakup.employerNPS || extBreakup.nps || extEmp.employerNPS || extEmp.nps || 0);
        const insuranceAmount = Number(extBreakup.insuranceAmount || extBreakup.insurance || extEmp.insuranceAmount || extEmp.insurance || 0);

        const otherAllowances = [];
        for (const [key, value] of Object.entries(extBreakup)) {
          if (!standardBreakupKeys.has(key.toLowerCase())) {
            const numVal = Number(value);
            if (Number.isFinite(numVal) && numVal > 0) {
              otherAllowances.push({
                name: key,
                amount: numVal
              });
            }
          }
        }

        // Resolve the HRMS payType to a MyBill Job Role Template.
        // payType is stored in the HRMS salaryBreakup Map as the key 'payType'.
        const hrmsPayType = String(extBreakup.payType || extBreakup.paytype || 'salaried').toLowerCase();
        const roleTemplate = await resolvePayrollRoleTemplate(userId, hrmsPayType);

        // When the HRMS explicitly provided per-employee statutory flags, honour them
        // over the template defaults (the template sets the structural type, but the
        // admin may have individually toggled PF/ESI for this specific employee).
        const resolvedPfEnabled = hrmsPayType === 'salaried' ? pfEnabled : roleTemplate.pfEnabled;
        const resolvedEsiEnabled = hrmsPayType === 'salaried' ? esiEnabled : roleTemplate.esiEnabled;
        const resolvedPtEnabled = hrmsPayType === 'salaried' ? ptEnabled : roleTemplate.ptEnabled;
        const resolvedLwfEnabled = hrmsPayType === 'salaried' ? lwfEnabled : roleTemplate.lwfEnabled;
        const resolvedGratuityEnabled = hrmsPayType === 'salaried' ? gratuityEnabled : roleTemplate.gratuityEnabled;
        const resolvedIncludePfInCTC = hrmsPayType === 'salaried' ? includePfInCTC : roleTemplate.includePfInCTC;
        const resolvedIncludeGratuityInCTC = hrmsPayType === 'salaried' ? includeGratuityInCTC : roleTemplate.includeGratuityInCTC;
        const resolvedUseSalaryComponents = hrmsPayType === 'salaried' ? useSalaryComponents : roleTemplate.useSalaryComponents;

        const query = { user: userId, employeeId: empId };
        const updateData = {
          employeeId: empId,
          firstName: extEmp.firstName || extEmp.personal?.firstName || 'Unknown',
          lastName: extEmp.lastName || extEmp.personal?.lastName || 'Employee',
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
          bankDetails,
          department: departmentId,
          // Job Role Template assignment
          role: roleTemplate.roleId,
          payType: roleTemplate.payType,
          employmentType: roleTemplate.employmentType,
          // Statutory flags — HRMS-level overrides respected for salaried; template governs otherwise
          pfEnabled: resolvedPfEnabled,
          esiEnabled: resolvedEsiEnabled,
          ptEnabled: resolvedPtEnabled,
          lwfEnabled: resolvedLwfEnabled,
          gratuityEnabled: resolvedGratuityEnabled,
          includePfInCTC: resolvedIncludePfInCTC,
          includeGratuityInCTC: resolvedIncludeGratuityInCTC,
          basicPercent,
          hraPercent,
          useSalaryComponents: resolvedUseSalaryComponents,
          ptState,
          broadband,
          petrol,
          lta,
          employerNPS,
          insuranceAmount,
          flexiAmount,
          basic,
          hra,
          salaryStructure: {
            basic,
            hra,
            conveyance,
            medicalAllowance,
            otherAllowances
          }
        };

        // Compute the final salary structure using all extracted HRMS values.
        // buildMasterSalaryStructure reads:
        //   source.basic / source.salaryStructure.basic  → basicMaster (if useSalaryComponents)
        //   source.hra   / source.salaryStructure.hra    → hraMaster   (if useSalaryComponents)
        //   source.flexiAmount                           → flexi
        //   source.salaryStructure.conveyance            → conveyance
        //   source.salaryStructure.medicalAllowance      → medicalAllowance
        const master = buildMasterSalaryStructure(updateData, config);
        updateData.flexiAmount = master.flexi;
        updateData.broadband = master.broadband;
        updateData.petrol = master.petrol;
        updateData.lta = master.lta;
        updateData.salaryStructure = {
          basic: master.basicMaster,
          hra: master.hraMaster,
          conveyance: conveyance,
          medicalAllowance: medicalAllowance,
          specialAllowance: master.specialAllowance,
          grossSalary: master.grossSalary,
          ctc: master.grossTotalSalary,
          otherAllowances: otherAllowances
        };

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
          name: `${extEmp.firstName || extEmp.personal?.firstName || 'Unknown'} ${extEmp.lastName || extEmp.personal?.lastName || 'Employee'}`.trim(),
          email,
          monthlyCTC: monthlyCTC,
          roleTemplateName: PAY_TYPE_ROLE_MAP[hrmsPayType]?.name || PAY_TYPE_ROLE_MAP.salaried.name,
          pfEnabled: resolvedPfEnabled,
          esiEnabled: resolvedEsiEnabled,
          flexiAmount: flexiAmount,
          customAllowances: otherAllowances.map(a => `${a.name}: ₹${a.amount}`).join(', ') || 'None',
          status: status === 'active' ? 'Active' : 'Inactive'
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

/**
 * Fetch monthly attendance summary from external multi-tenant Attendance system.
 *
 * The HRMS now returns per-employee:
 *   workingDays   - total schedulable working days for the employee this month
 *                   (excludes weekoffs, holidays, and days before joining)
 *   presentDays   - actual PRESENT + HALF_DAY count from Attendance records
 *   absentDays    - workingDays not covered by presence or approved leaves
 *   paidLeaves    - approved paid leave days in the month
 *   unpaidLeaves  - approved unpaid leave days in the month
 *
 * paidDays (for payroll proration) = presentDays + paidLeaves
 * This is clamped to [0, workingDays].
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
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    let rawData = response.data;
    if (isEncryptedPackage(rawData)) {
      rawData = decryptPayload(rawData, encryptionSecret);
    }

    const attendanceRecords = Array.isArray(rawData) ? rawData : (rawData?.attendance || []);
    const localEmployees = await Employee.find({ user: userId }).select('_id employeeId');

    // Default working days fallback (used only when workingDays is completely absent from HRMS)
    const defaultWorkingDays = settings.defaultWorkingDays || 26;

    const mapped = [];
    localEmployees.forEach(emp => {
      const record = attendanceRecords.find(
        r => String(r.employeeId || r.emp_id || '').trim() === String(emp.employeeId).trim()
      );

      if (record) {
        const calendarDays = new Date(year, month, 0).getDate();
        const hrmsWorkingDays = record.workingDays !== undefined ? Number(record.workingDays) : 23;

        // presentDays: newly named field; fall back to legacy 'workingDays' if HRMS is old
        const presentDays = record.presentDays !== undefined
          ? Number(record.presentDays)
          : (record.workingDays !== undefined ? Number(record.workingDays) : 0);

        const unpaidLeaves = Number(record.unpaidLeaves || record.unpaid_leaves || 0);
        const paidLeaves = Number(record.paidLeaves || record.paid_leaves || 0);
        const absentDays = record.absentDays !== undefined
          ? Number(record.absentDays)
          : Math.max(hrmsWorkingDays - presentDays - paidLeaves - unpaidLeaves, 0);

        // Scale counts to calendar days to maintain mathematically correct proration ratio
        const scaleFactor = hrmsWorkingDays > 0 ? calendarDays / hrmsWorkingDays : 1;

        const scaledPresent = Number((presentDays * scaleFactor).toFixed(2));
        const scaledUnpaid = Number((unpaidLeaves * scaleFactor).toFixed(2));
        const scaledPaidLeaves = Number((paidLeaves * scaleFactor).toFixed(2));
        const scaledAbsent = Number((absentDays * scaleFactor).toFixed(2));

        // paidDays = calendarDays - scaledUnpaid - scaledAbsent
        const paidDays = Math.min(Math.max(Number((calendarDays - scaledUnpaid - scaledAbsent).toFixed(2)), 0), calendarDays);

        mapped.push({
          employeeId: emp._id,
          employeeNumber: emp.employeeId,
          workingDays: calendarDays,
          presentDays: scaledPresent,
          absentDays: scaledAbsent,
          paidDays,
          unpaidLeaves: scaledUnpaid,
          paidLeaves: scaledPaidLeaves
        });
      } else {
        const calendarDays = new Date(year, month, 0).getDate();
        mapped.push({
          employeeId: emp._id,
          employeeNumber: emp.employeeId,
          workingDays: calendarDays,
          presentDays: 0,
          absentDays: calendarDays,
          paidDays: 0,
          unpaidLeaves: 0,
          paidLeaves: 0
        });
      }
    });

    return mapped;
  } catch (error) {
    console.error('hrmsSyncService syncAttendance error:', error.message);
    throw new Error(`Attendance fetch failed: ${error.message}`);
  }
};
