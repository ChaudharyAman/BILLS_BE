const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const Department = require('../models/Department');
const Payroll = require('../models/Payroll');
const PayrollConfig = require('../models/PayrollConfig');
const Expense = require('../models/Expense');
const Loan = require('../models/Loan');
const ReimbursementClaim = require('../models/ReimbursementClaim');
const Project = require('../models/Project');
const escapeRegex = require('../utils/escapeRegex');
const { XLSX, setHeaderStyle, sendWorkbook } = require('../utils/excel');
const { buildMasterSalaryStructure, roundAmount } = require('../utils/payrollMath');

const toCamelCase = (str) => {
  return str
    .replace(/[^a-zA-Z0-9\s-_]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+(.)?/g, (match, ch) => ch ? ch.toUpperCase() : '');
};

const standardAliases = new Set([
  'EMP NO', 'EMPLOYEE ID', 'EMP ID', 'EMP NO.',
  'FIRST NAME', 'FIRSTNAME',
  'LAST NAME', 'LASTNAME',
  'NAME OF EMPLOYEE', 'EMPLOYEE NAME', 'NAME',
  'EMAIL', 'EMAIL ID',
  'PHONE', 'MOBILE', 'CONTACT',
  'DOB', 'DATE OF BIRTH',
  'GENDER',
  'DOJ', 'JOINING DATE', 'DATE OF JOINING',
  'DOL', 'DATE OF LEAVING',
  'LOCATION', 'WORK LOCATION',
  'DESIGNATION', 'ROLE', 'JOB ROLE TEMPLATE', 'JOB_ROLE_TEMPLATE',
  'DEPARTMENT', 'DEPT',
  'EMPLOYMENT TYPE',
  'STATUS',
  'MONTHLY CTC', 'CTC', 'MONTHLY SALARY',
  'BASIC %', 'BASIC PERCENT',
  'HRA %', 'HRA PERCENT',
  'FLEXI AMOUNT', 'FLEXI', 'MEAL ALLOWANCE',
  'BROADBAND',
  'PETROL',
  'LTA',
  'EMPLOYER NPS', 'NPS',
  'INSURANCE', 'INSURANCE AMOUNT',
  'JOINING BONUS',
  'PROFESSIONAL TAX', 'PT', 'PROFESSIONAL TAX DEDUCTION',
  'TDS', 'INCOME TAX', 'TDS DEDUCTION',
  'ACCOUNT NAME', 'BANK ACCOUNT NAME',
  'BANK A/C', 'ACCOUNT NUMBER', 'BANK ACCOUNT', 'BANK ACCOUNT NUMBER',
  'IFSC', 'IFSC CODE',
  'BANK NAME',
  'BRANCH',
  'PAN', 'PAN NO', 'PAN NUMBER',
  'AADHAR', 'AADHAR NO', 'AADHAR NUMBER',
  'UAN', 'UAN NUMBER',
  'TAX REGIME',
  'PF ENABLED',
  'ESI ENABLED',
  'PT ENABLED',
  'LWF ENABLED',
  'GRATUITY ENABLED',
  'INCLUDE PF IN CTC',
  'INCLUDE GRATUITY IN CTC',
  'USE SALARY COMPONENTS', 'USE_SALARY_COMPONENTS',
  'ANNUAL CTC', 'ANNUAL_CTC',
  'GROSS SALARY', 'GROSS_SALARY',
  'EMPLOYER PF', 'EMPLOYER_PF',
  'EMPLOYER GRATUITY', 'EMPLOYER_GRATUITY',
  'TOTAL DEDUCTIONS', 'TOTAL_DEDUCTIONS',
  'NET TAKE HOME', 'NET_TAKE_HOME',
  'ADDRESS LINE 1',
  'ADDRESS LINE 2',
  'CITY',
  'STATE',
  'ZIP', 'PINCODE', 'PIN CODE',
  'COUNTRY',
  'SECTION 80C',
  'SECTION 80D',
  'SECTION 24B',
  'SECTION 80CCD(1B)', 'SECTION 80CCD1B',
  'RENT PAID MONTHLY',
  'IS METRO CITY',
  'OTHER EXEMPTIONS',
  'PAY TYPE', 'PAYTYPE', 'PAY_TYPE',
  'HOURLY RATE', 'HOURLYRATE', 'HOURLY_RATE'
]);

const getOrCreateConfig = async (userId) => {
  let config = await PayrollConfig.findOne({ user: userId });
  if (!config) config = await PayrollConfig.create({ user: userId });
  return config;
};

const validateDepartment = async (departmentId, userId) => {
  if (!departmentId) return null;
  if (!mongoose.Types.ObjectId.isValid(String(departmentId))) {
    const error = new Error('Invalid department');
    error.statusCode = 400;
    throw error;
  }
  const department = await Department.findOne({ _id: departmentId, user: userId });
  if (!department) {
    const error = new Error('Department not found');
    error.statusCode = 400;
    throw error;
  }
  return department._id;
};

const parsePossibleDate = (value) => {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = new Date(value);
  if (Number.isFinite(parsed.getTime())) return parsed;
  return null;
};

const formatDateOnly = (dateVal) => {
  if (!dateVal) return '';
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const splitEmployeeName = (fullName = '') => {
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
};

const normalizeRow = (row = {}) => Object.entries(row).reduce((acc, [key, value]) => {
  acc[String(key || '').trim().toUpperCase()] = value;
  return acc;
}, {});

const getCellValue = (row, aliases = []) => {
  for (const alias of aliases) {
    const value = row[String(alias).trim().toUpperCase()];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return '';
};

const getComponentValueFromRow = (rawRow, c) => {
  const normId = String(c.id).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const normName = String(c.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  for (const headerKey of Object.keys(rawRow)) {
    const normHeader = String(headerKey).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (normHeader === normId || normHeader === normName) {
      return rawRow[headerKey];
    }
    if (normHeader.startsWith(normName) || normName.startsWith(normHeader)) {
      return rawRow[headerKey];
    }
  }

  const FALLBACKS = {
    basic: ['BASIC SALARY', 'BASIC', 'BASIC PERCENT', 'BASIC %'],
    hra: ['HRA', 'HOUSE RENT ALLOWANCE', 'HRA %', 'HRA PERCENT'],
    special: ['SPECIAL ALLOWANCE', 'SPECIAL'],
    flexi: ['FLEXI AMOUNT', 'FLEXI', 'FLEXI ALLOWANCE', 'MEAL ALLOWANCE'],
    broadband: ['BROADBAND', 'BROADBAND ALLOWANCE'],
    petrol: ['PETROL', 'PETROL ALLOWANCE'],
    lta: ['LTA', 'LEAVE TRAVEL ALLOWANCE'],
    conveyance: ['CONVEYANCE', 'CONVEYANCE ALLOWANCE'],
    medical: ['MEDICAL ALLOWANCE', 'MEDICAL'],
  };

  const aliases = FALLBACKS[c.id] || [];
  for (const alias of aliases) {
    const normAlias = alias.toUpperCase().replace(/[^A-Z0-9]/g, '');
    for (const headerKey of Object.keys(rawRow)) {
      const normHeader = String(headerKey).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (normHeader === normAlias) {
        return rawRow[headerKey];
      }
    }
  }
  return undefined;
};

const GROUP_COLORS = {
  'Personal Details': { bg: 'DDEBF7', fg: '1F4E78' },
  'Employment Details': { bg: 'E2F0D9', fg: '385723' },
  'Statutory Toggles': { bg: 'FFF0F5', fg: '8B0086' },
  'Salary Details': { bg: 'FFF2CC', fg: '7F6000' },
  'Flexi & Other Allowance': { bg: 'F2F2F2', fg: '595959' },
  'Deductions': { bg: 'FCE4D6', fg: 'C65911' },
  'Bank Details': { bg: 'E8E8FF', fg: '2F2F80' },
  'Identity Details': { bg: 'E1D5E7', fg: '603080' },
  'Address Details': { bg: 'E6F2FF', fg: '0055A5' },
  'Tax Declarations & Exemptions': { bg: 'EAFBF0', fg: '0E7035' },
  'Custom Components': { bg: 'F0F8FF', fg: '004080' },
  'Other Details': { bg: 'FFF5EE', fg: '8B4513' }
};

const buildExcelColumns = (config, rootCustomKeys = []) => {
  const basicDef = config?.basicPercent !== undefined && config?.basicPercent !== null
    ? (config.basicPercent > 1 ? config.basicPercent / 100 : config.basicPercent)
    : 0.5;
  const hraDef = config?.hraPercent !== undefined && config?.hraPercent !== null
    ? (config.hraPercent > 1 ? config.hraPercent / 100 : config.hraPercent)
    : 0.5;
  const pfRate = config?.pfRate !== undefined && config?.pfRate !== null ? config.pfRate : 0.12;
  const pfCap = config?.pfCap !== undefined && config?.pfCap !== null ? config.pfCap : 15000;
  const pfEmployerRate = config?.pfEmployerRate !== undefined && config?.pfEmployerRate !== null ? config.pfEmployerRate : 0.12;
  const gratuityRate = config?.gratuityRate !== undefined && config?.gratuityRate !== null ? config.gratuityRate : 0.0481;

  let salaryComponents = config?.salaryComponents;
  if (!salaryComponents || salaryComponents.length === 0) {
    salaryComponents = [
      { id: 'basic',                    name: 'Basic Salary',                  type: 'earning',   taxable: true,  linkedTo: 'ctc_percent',   linkValue: basicDef,      frequency: 'monthly' },
      { id: 'hra',                      name: 'HRA',                           type: 'earning',   taxable: false, linkedTo: 'basic_percent', linkValue: hraDef,        frequency: 'monthly' },
      { id: 'special',                  name: 'Special Allowance',             type: 'earning',   taxable: true,  linkedTo: 'fixed',         linkValue: 0,             frequency: 'monthly' },
      { id: 'flexi',                    name: 'Flexi Allowance',               type: 'earning',   taxable: false, linkedTo: 'remainder',     linkValue: 0,             frequency: 'monthly' },
      { id: 'broadband',                name: 'Broadband',                     type: 'earning',   taxable: false, linkedTo: 'fixed',         linkValue: 0,             frequency: 'monthly' },
      { id: 'petrol',                   name: 'Petrol',                        type: 'earning',   taxable: false, linkedTo: 'fixed',         linkValue: 0,             frequency: 'monthly' },
      { id: 'lta',                      name: 'LTA',                           type: 'earning',   taxable: false, linkedTo: 'fixed',         linkValue: 0,             frequency: 'monthly' },
      { id: 'conveyance',               name: 'Conveyance',                    type: 'earning',   taxable: false, linkedTo: 'fixed',         linkValue: 0,             frequency: 'monthly' },
      { id: 'medical',                  name: 'Medical Allowance',             type: 'earning',   taxable: false, linkedTo: 'fixed',         linkValue: 0,             frequency: 'monthly' },
    ];
  }

  const activeConfig = {
    ...config,
    salaryComponents
  };

  const columns = [];

  // Group: Personal Details
  columns.push({ header: 'Employee ID', group: 'Personal Details', key: 'employeeId', sample: 'EMP-001' });
  columns.push({ header: 'First Name', group: 'Personal Details', key: 'firstName', sample: 'John' });
  columns.push({ header: 'Last Name', group: 'Personal Details', key: 'lastName', sample: 'Doe' });
  columns.push({ header: 'Email', group: 'Personal Details', key: 'email', sample: 'john.doe@example.com' });
  columns.push({ header: 'Phone', group: 'Personal Details', key: 'phone', sample: '9876543210' });
  columns.push({ header: 'Date of Birth', group: 'Personal Details', key: 'dateOfBirth', sample: '1990-01-01', type: 'date' });
  columns.push({ header: 'Gender', group: 'Personal Details', key: 'gender', sample: 'Male' });

  // Group: Employment Details
  columns.push({ header: 'Joining Date', group: 'Employment Details', key: 'joiningDate', sample: '2026-06-01', type: 'date' });
  columns.push({ header: 'Date of Leaving', group: 'Employment Details', key: 'dateOfLeaving', sample: '', type: 'date' });
  columns.push({ header: 'Location', group: 'Employment Details', key: 'location', sample: 'Delhi' });
  columns.push({
    header: 'Designation',
    group: 'Employment Details',
    key: 'designation',
    sample: 'Software Engineer',
    getValue: (employee) => {
      const val = employee?.designation || '';
      if (mongoose.Types.ObjectId.isValid(val)) {
        if (employee.role && typeof employee.role === 'object' && employee.role.name) {
          return employee.role.name;
        }
        return '';
      }
      return val;
    }
  });
  columns.push({ header: 'Department', group: 'Employment Details', key: 'department', sample: 'Engineering', getValue: (employee) => {
    if (!employee?.department) return '';
    if (typeof employee.department === 'object' && employee.department.name) {
      return employee.department.name;
    }
    const val = String(employee.department);
    if (mongoose.Types.ObjectId.isValid(val)) {
      return '';
    }
    return val;
  }});
  columns.push({ header: 'Employment Type', group: 'Employment Details', key: 'employmentType', sample: 'full-time' });
  columns.push({ header: 'Status', group: 'Employment Details', key: 'status', sample: 'active' });
  columns.push({ header: 'Pay Type', group: 'Employment Details', key: 'payType', sample: 'salaried', getValue: (employee) => employee?.payType || 'salaried' });
  columns.push({ header: 'Compensation Type', group: 'Employment Details', key: 'compensationType', sample: 'monthly_salary', getValue: (employee) => employee?.compensationType || '' });
  columns.push({ header: 'Pay Frequency', group: 'Employment Details', key: 'payFrequency', sample: 'monthly', getValue: (employee) => employee?.payFrequency || 'monthly' });
  columns.push({ header: 'Attendance Mode', group: 'Employment Details', key: 'attendanceMode', sample: 'attendance', getValue: (employee) => employee?.attendanceMode || 'attendance' });
  columns.push({ header: 'Compensation Model', group: 'Employment Details', key: 'compensationModel', sample: 'SALARIED', getValue: (employee) => employee?.compensationModel || 'SALARIED' });
  columns.push({ header: 'Payment Basis', group: 'Employment Details', key: 'paymentBasis', sample: 'MONTHLY', getValue: (employee) => employee?.paymentBasis || 'MONTHLY' });
  columns.push({ header: 'Job Role Template', group: 'Employment Details', key: 'role', sample: 'EMPLOYEE', getValue: (employee) => {
    if (!employee?.role) return '';
    if (typeof employee.role === 'object' && employee.role.name) {
      return employee.role.name;
    }
    const val = String(employee.role);
    if (mongoose.Types.ObjectId.isValid(val)) {
      return '';
    }
    return val;
  }});

  // Group: Statutory Toggles
  columns.push({ header: 'Tax Regime', group: 'Statutory Toggles', key: 'taxRegime', sample: 'new' });
  columns.push({ header: 'PF Enabled', group: 'Statutory Toggles', key: 'pfEnabled', sample: 'No' });
  columns.push({ header: 'TDS Enabled', group: 'Statutory Toggles', key: 'tdsEnabled', sample: 'Yes' });
  columns.push({ header: 'ESI Enabled', group: 'Statutory Toggles', key: 'esiEnabled', sample: 'No' });
  columns.push({ header: 'PT Enabled', group: 'Statutory Toggles', key: 'ptEnabled', sample: 'No' });
  columns.push({ header: 'LWF Enabled', group: 'Statutory Toggles', key: 'lwfEnabled', sample: 'No' });
  columns.push({ header: 'Gratuity Enabled', group: 'Statutory Toggles', key: 'gratuityEnabled', sample: 'No' });
  columns.push({ header: 'Include PF in CTC', group: 'Statutory Toggles', key: 'includePfInCTC', sample: 'No' });
  columns.push({ header: 'Include Gratuity in CTC', group: 'Statutory Toggles', key: 'includeGratuityInCTC', sample: 'No' });
  columns.push({ header: 'Use Salary Components', group: 'Statutory Toggles', key: 'useSalaryComponents', sample: 'Yes', getValue: (employee) => employee?.useSalaryComponents !== false ? 'Yes' : 'No' });

  // Helper to find dynamic column letters
  const getColLetter = (k) => {
    const idx = columns.findIndex(c => c.key === k);
    return idx !== -1 ? XLSX.utils.encode_col(idx) : '';
  };

  // Group: Salary Details
  columns.push({
    header: 'Hourly Rate',
    group: 'Salary Details',
    key: 'hourlyRate',
    isSummable: true,
    sample: 0,
    getValue: (employee) => Number(employee?.hourlyRate) || 0
  });

  columns.push({
    header: 'Annual CTC',
    group: 'Salary Details',
    key: 'annualCTC',
    isSummable: true,
    sample: 600000,
    getValue: (employee, rNum, mode) => {
      if (mode === 'template') return 600000;
      const payTypeL = getColLetter('payType');
      const hourlyRateL = getColLetter('hourlyRate');
      const salariedVal = Number(employee?.monthlyCTC || 0) * 12;
      const f = `IF(${payTypeL}${rNum}="hourly", ${hourlyRateL}${rNum} * 160 * 12, ${salariedVal})`;
      const isHourly = employee?.payType === 'hourly';
      const hourlyVal = (Number(employee?.hourlyRate) || 0) * 160 * 12;
      const v = isHourly ? hourlyVal : salariedVal;
      return { f, v };
    }
  });

  columns.push({
    header: 'Monthly CTC',
    group: 'Salary Details',
    key: 'monthlyCTC',
    isSummable: true,
    sample: 50000,
    getValue: (employee, rNum, mode) => {
      const payTypeL = getColLetter('payType');
      const hourlyRateL = getColLetter('hourlyRate');
      const annualCtcL = getColLetter('annualCTC');
      const f = `IF(${payTypeL}${rNum}="hourly", ${hourlyRateL}${rNum} * 160, ${annualCtcL}${rNum} / 12)`;
      const isHourly = employee?.payType === 'hourly';
      const hourlyVal = (Number(employee?.hourlyRate) || 0) * 160;
      const salariedVal = Number(employee?.monthlyCTC || 0);
      const v = isHourly ? hourlyVal : salariedVal;
      if (mode === 'template') return { f };
      return { f, v };
    }
  });

  columns.push({ header: 'Basic %', group: 'Salary Details', key: 'basicPercent', sample: basicDef * 100 });
  columns.push({ header: 'HRA %', group: 'Salary Details', key: 'hraPercent', sample: hraDef * 100 });

  const earnings = activeConfig.salaryComponents ? activeConfig.salaryComponents.filter(c => c.type === 'earning') : [];
  const grossEarnings = earnings.filter(c => c.taxable || c.id === 'hra');
  const flexiEarnings = earnings.filter(c => !c.taxable && c.id !== 'hra');

  // Add Gross Earnings columns
  grossEarnings.forEach(c => {
    let suffix = '';
    if (c.frequency === 'quarterly') suffix = ' (Quarterly)';
    else if (c.frequency === 'semi_annually') suffix = ' (Semi-Annually)';
    else if (c.frequency === 'annually') suffix = ' (Annually)';

    const colDef = {
      header: `${c.name || c.id}${suffix}`,
      group: 'Salary Details',
      key: c.id,
      isSummable: true,
      sample: c.linkedTo === 'remainder' ? 0 : (c.linkedTo === 'fixed' ? c.linkValue : 0),
    };

    if (c.id === 'basic') {
      colDef.getValue = (employee, rNum, mode) => {
        const ctcL = getColLetter('monthlyCTC');
        const basicPctL = getColLetter('basicPercent');
        const f = `IF(${getColLetter('useSalaryComponents')}${rNum}="No", ${ctcL}${rNum}, ROUND(${ctcL}${rNum} * IF(${basicPctL}${rNum}<>"", ${basicPctL}${rNum}/100, ${basicDef}), 2))`;
        if (mode === 'template') return { f };
        return { f, v: Number(employee?.salaryStructure?.basic) || 0 };
      };
    } else if (c.id === 'hra') {
      colDef.getValue = (employee, rNum, mode) => {
        const basicL = getColLetter('basic');
        const hraPctL = getColLetter('hraPercent');
        const f = `IF(${getColLetter('useSalaryComponents')}${rNum}="No", 0, ROUND(${basicL}${rNum} * IF(${hraPctL}${rNum}<>"", ${hraPctL}${rNum}/100, ${hraDef}), 2))`;
        if (mode === 'template') return { f };
        return { f, v: Number(employee?.salaryStructure?.hra) || 0 };
      };
    } else if (c.linkedTo === 'remainder') {
      colDef.getValue = (employee, rNum, mode) => {
        const ctcL = getColLetter('monthlyCTC');
        const otherEarningLetters = activeConfig.salaryComponents
          .filter(e => e.type === 'earning' && e.id !== c.id)
          .map(e => getColLetter(e.id) + rNum);

        const terms = [`${ctcL}${rNum}`, ...otherEarningLetters];
        if (getColLetter('employerNPS')) terms.push(`${getColLetter('employerNPS')}${rNum}`);
        if (getColLetter('insuranceAmount')) terms.push(`${getColLetter('insuranceAmount')}${rNum}`);

        const pfTerm = `IF(${getColLetter('includePfInCTC')}${rNum}="Yes", ${getColLetter('employerPF')}${rNum}, 0)`;
        const gratuityTerm = `IF(${getColLetter('includeGratuityInCTC')}${rNum}="Yes", ${getColLetter('employerGratuity')}${rNum}, 0)`;
        
        const subtractedTerms = terms.slice(1).join(' - ');
        const f = `IF(${getColLetter('useSalaryComponents')}${rNum}="No", 0, ROUND(MAX(${terms[0]}${subtractedTerms ? ' - ' + subtractedTerms : ''} - ${pfTerm} - ${gratuityTerm}, 0), 2))`;
        
        if (mode === 'template') return { f };
        const val = employee?.salaryStructure?.[c.id] !== undefined ? employee.salaryStructure[c.id] : employee[c.id];
        return { f, v: Number(val) || 0 };
      };
    } else if (c.linkedTo === 'ctc_percent') {
      colDef.getValue = (employee, rNum, mode) => {
        const ctcL = getColLetter('monthlyCTC');
        const f = `IF(${getColLetter('useSalaryComponents')}${rNum}="No", 0, ROUND(${ctcL}${rNum} * ${c.linkValue}, 2))`;
        if (mode === 'template') return { f };
        const val = employee?.salaryStructure?.[c.id] !== undefined ? employee.salaryStructure[c.id] : employee[c.id];
        return { f, v: Number(val) || 0 };
      };
    } else if (c.linkedTo === 'basic_percent') {
      colDef.getValue = (employee, rNum, mode) => {
        const basicL = getColLetter('basic');
        const f = `IF(${getColLetter('useSalaryComponents')}${rNum}="No", 0, ROUND(${basicL}${rNum} * ${c.linkValue}, 2))`;
        if (mode === 'template') return { f };
        const val = employee?.salaryStructure?.[c.id] !== undefined ? employee.salaryStructure[c.id] : employee[c.id];
        return { f, v: Number(val) || 0 };
      };
    } else {
      colDef.getValue = (employee, rNum, mode) => {
        if (mode === 'template') return c.linkValue || 0;
        const val = employee?.salaryStructure?.[c.id] !== undefined ? employee.salaryStructure[c.id] : employee[c.id];
        return val !== undefined && val !== null ? Number(val) || 0 : 0;
      };
    }

    columns.push(colDef);
  });

  // Gross Salary, Employer PF, Employer Gratuity, Total Deductions, Net Take Home
  columns.push({
    header: 'Gross Salary',
    group: 'Salary Details',
    key: 'grossSalary',
    isSummable: true,
    getValue: (employee, rNum, mode) => {
      const grossEarningLetters = grossEarnings.map(e => getColLetter(e.id) + rNum);
      const f = `ROUND(${grossEarningLetters.join(' + ')}, 2)`;
      if (mode === 'template') return { f };
      return { f, v: Number(employee?.salaryStructure?.grossSalary) || 0 };
    }
  });

  columns.push({
    header: 'Employer PF',
    group: 'Salary Details',
    key: 'employerPF',
    isSummable: true,
    getValue: (employee, rNum, mode) => {
      const basicL = getColLetter('basic');
      const pfEnabledL = getColLetter('pfEnabled');
      const f = `ROUND(IF(${pfEnabledL}${rNum}="Yes", MIN(${basicL}${rNum}, ${pfCap}) * ${pfEmployerRate}, 0), 2)`;
      if (mode === 'template') return { f };
      return { f, v: Number(employee?.deductions?.pf) || 0 };
    }
  });

  columns.push({
    header: 'Employer Gratuity',
    group: 'Salary Details',
    key: 'employerGratuity',
    isSummable: true,
    getValue: (employee, rNum, mode) => {
      const basicL = getColLetter('basic');
      const gratuityEnabledL = getColLetter('gratuityEnabled');
      const f = `ROUND(IF(${gratuityEnabledL}${rNum}="Yes", ${basicL}${rNum} * ${gratuityRate}, 0), 2)`;
      if (mode === 'template') return { f };
      const val = employee?.salaryStructure?.ctc ? Math.max(0, roundAmount(employee.salaryStructure.ctc - employee.salaryStructure.grossSalary - (employee.deductions?.pf || 0))) : 0;
      return { f, v: val };
    }
  });

  columns.push({
    header: 'Total Deductions',
    group: 'Salary Details',
    key: 'totalDeductions',
    isSummable: true,
    getValue: (employee, rNum, mode) => {
      const basicL = getColLetter('basic');
      const pfEnabledL = getColLetter('pfEnabled');
      const ptL = getColLetter('professionalTax');
      const tdsL = getColLetter('tds');
      const f = `ROUND(IF(${pfEnabledL}${rNum}="Yes", MIN(${basicL}${rNum}, ${pfCap}) * ${pfRate}, 0) + ${ptL}${rNum} + ${tdsL}${rNum}, 2)`;
      if (mode === 'template') return { f };
      const val = (Number(employee?.deductions?.pf) || 0) + (Number(employee?.deductions?.professionalTax) || 0) + (Number(employee?.deductions?.tds) || 0);
      return { f, v: val };
    }
  });

  columns.push({
    header: 'Net Take Home',
    group: 'Salary Details',
    key: 'netTakeHome',
    isSummable: true,
    getValue: (employee, rNum, mode) => {
      const grossSalaryL = getColLetter('grossSalary');
      const totalDeductionsL = getColLetter('totalDeductions');
      const flexiEarningLetters = flexiEarnings.map(e => getColLetter(e.id) + rNum);
      const addedFlexi = flexiEarningLetters.length > 0 ? ' + ' + flexiEarningLetters.join(' + ') : '';
      const f = `ROUND(${grossSalaryL}${rNum} - ${totalDeductionsL}${rNum}${addedFlexi}, 2)`;
      if (mode === 'template') return { f };
      const grossSalaryVal = Number(employee?.salaryStructure?.grossSalary) || 0;
      const totalDeductionsVal = (Number(employee?.deductions?.pf) || 0) + (Number(employee?.deductions?.professionalTax) || 0) + (Number(employee?.deductions?.tds) || 0);
      const flexiVal = flexiEarnings.reduce((sum, e) => {
        const val = employee?.salaryStructure?.[e.id] !== undefined ? employee.salaryStructure[e.id] : employee[e.id];
        return sum + (Number(val) || 0);
      }, 0);
      return { f, v: Math.max(0, roundAmount(grossSalaryVal - totalDeductionsVal + flexiVal)) };
    }
  });

  // Group: Flexi & Other Allowance
  flexiEarnings.forEach(c => {
    let suffix = '';
    if (c.frequency === 'quarterly') suffix = ' (Quarterly)';
    else if (c.frequency === 'semi_annually') suffix = ' (Semi-Annually)';
    else if (c.frequency === 'annually') suffix = ' (Annually)';

    const colDef = {
      header: `${c.name || c.id}${suffix}`,
      group: 'Flexi & Other Allowance',
      key: c.id,
      isSummable: true,
      sample: c.linkedTo === 'remainder' ? 0 : (c.linkedTo === 'fixed' ? c.linkValue : 0),
    };

    if (c.linkedTo === 'remainder') {
      colDef.getValue = (employee, rNum, mode) => {
        const ctcL = getColLetter('monthlyCTC');
        const otherEarningLetters = activeConfig.salaryComponents
          .filter(e => e.type === 'earning' && e.id !== c.id)
          .map(e => getColLetter(e.id) + rNum);

        const terms = [`${ctcL}${rNum}`, ...otherEarningLetters];
        if (getColLetter('employerNPS')) terms.push(`${getColLetter('employerNPS')}${rNum}`);
        if (getColLetter('insuranceAmount')) terms.push(`${getColLetter('insuranceAmount')}${rNum}`);

        const pfTerm = `IF(${getColLetter('includePfInCTC')}${rNum}="Yes", ${getColLetter('employerPF')}${rNum}, 0)`;
        const gratuityTerm = `IF(${getColLetter('includeGratuityInCTC')}${rNum}="Yes", ${getColLetter('employerGratuity')}${rNum}, 0)`;

        const subtractedTerms = terms.slice(1).join(' - ');
        const f = `ROUND(MAX(${terms[0]}${subtractedTerms ? ' - ' + subtractedTerms : ''} - ${pfTerm} - ${gratuityTerm}, 0), 2)`;

        if (mode === 'template') return { f };
        const val = employee?.salaryStructure?.[c.id] !== undefined ? employee.salaryStructure[c.id] : employee[c.id];
        return { f, v: Number(val) || 0 };
      };
    } else if (c.linkedTo === 'ctc_percent') {
      colDef.getValue = (employee, rNum, mode) => {
        const ctcL = getColLetter('monthlyCTC');
        const f = `ROUND(${ctcL}${rNum} * ${c.linkValue}, 2)`;
        if (mode === 'template') return { f };
        const val = employee?.salaryStructure?.[c.id] !== undefined ? employee.salaryStructure[c.id] : employee[c.id];
        return { f, v: Number(val) || 0 };
      };
    } else if (c.linkedTo === 'basic_percent') {
      colDef.getValue = (employee, rNum, mode) => {
        const basicL = getColLetter('basic');
        const f = `ROUND(${basicL}${rNum} * ${c.linkValue}, 2)`;
        if (mode === 'template') return { f };
        const val = employee?.salaryStructure?.[c.id] !== undefined ? employee.salaryStructure[c.id] : employee[c.id];
        return { f, v: Number(val) || 0 };
      };
    } else {
      colDef.getValue = (employee, rNum, mode) => {
        if (mode === 'template') return c.linkValue || 0;
        const val = employee?.salaryStructure?.[c.id] !== undefined ? employee.salaryStructure[c.id] : employee[c.id];
        return val !== undefined && val !== null ? Number(val) || 0 : 0;
      };
    }

    columns.push(colDef);
  });

  // NPS, Insurance, Joining Bonus
  columns.push({
    header: 'Employer NPS',
    group: 'Flexi & Other Allowance',
    key: 'employerNPS',
    isSummable: true,
    sample: 0,
    getValue: (employee) => Number(employee?.employerNPS) || 0
  });

  columns.push({
    header: 'Insurance Amount',
    group: 'Flexi & Other Allowance',
    key: 'insuranceAmount',
    isSummable: true,
    sample: 0,
    getValue: (employee) => Number(employee?.insuranceAmount) || 0
  });

  columns.push({
    header: 'Joining Bonus',
    group: 'Flexi & Other Allowance',
    key: 'joiningBonus',
    isSummable: true,
    sample: 0,
    getValue: (employee) => Number(employee?.joiningBonus) || 0
  });

  // Group: Deductions
  columns.push({
    header: 'Professional Tax',
    group: 'Deductions',
    key: 'professionalTax',
    isSummable: true,
    sample: 200,
    getValue: (employee) => Number(employee?.deductions?.professionalTax) || 0
  });

  columns.push({
    header: 'TDS',
    group: 'Deductions',
    key: 'tds',
    isSummable: true,
    sample: 0,
    getValue: (employee) => Number(employee?.deductions?.tds) || 0
  });

  // Group: Bank Details
  columns.push({ header: 'Account Name', group: 'Bank Details', key: 'bankDetails.accountName', sample: 'John Doe', getValue: (employee) => employee?.bankDetails?.accountName || '' });
  columns.push({ header: 'Account Number', group: 'Bank Details', key: 'bankDetails.accountNumber', sample: '1234567890', getValue: (employee) => employee?.bankDetails?.accountNumber || '' });
  columns.push({ header: 'IFSC Code', group: 'Bank Details', key: 'bankDetails.ifscCode', sample: 'UTIB0000123', getValue: (employee) => employee?.bankDetails?.ifscCode || '' });
  columns.push({ header: 'Bank Name', group: 'Bank Details', key: 'bankDetails.bankName', sample: 'Axis Bank', getValue: (employee) => employee?.bankDetails?.bankName || '' });
  columns.push({ header: 'Branch', group: 'Bank Details', key: 'bankDetails.branch', sample: 'Delhi', getValue: (employee) => employee?.bankDetails?.branch || '' });

  // Group: Identity Details
  columns.push({ header: 'PAN Number', group: 'Identity Details', key: 'panNumber', sample: 'ABCDE1234F', getValue: (employee) => employee?.panNumber || '' });
  columns.push({ header: 'UAN Number', group: 'Identity Details', key: 'uanNumber', sample: '', getValue: (employee) => employee?.uanNumber || '' });
  columns.push({ header: 'Aadhar Number', group: 'Identity Details', key: 'aadharNumber', sample: '123456789012', getValue: (employee) => employee?.aadharNumber || '' });

  // Group: Address Details
  columns.push({ header: 'Address Line 1', group: 'Address Details', key: 'address.line1', sample: '123 Street Name', getValue: (employee) => employee?.address?.line1 || '' });
  columns.push({ header: 'Address Line 2', group: 'Address Details', key: 'address.line2', sample: '', getValue: (employee) => employee?.address?.line2 || '' });
  columns.push({ header: 'City', group: 'Address Details', key: 'address.city', sample: 'Delhi', getValue: (employee) => employee?.address?.city || '' });
  columns.push({ header: 'State', group: 'Address Details', key: 'address.state', sample: 'Delhi', getValue: (employee) => employee?.address?.state || '' });
  columns.push({ header: 'Zip', group: 'Address Details', key: 'address.zip', sample: '110001', getValue: (employee) => employee?.address?.zip || '' });
  columns.push({ header: 'Country', group: 'Address Details', key: 'address.country', sample: 'India', getValue: (employee) => employee?.address?.country || '' });

  // Group: Tax Declarations & Exemptions
  columns.push({ header: 'Section 80C', group: 'Tax Declarations & Exemptions', key: 'declarations.section80C', sample: 0, getValue: (employee) => employee?.declarations?.section80C || 0 });
  columns.push({ header: 'Section 80D', group: 'Tax Declarations & Exemptions', key: 'declarations.section80D', sample: 0, getValue: (employee) => employee?.declarations?.section80D || 0 });
  columns.push({ header: 'Section 24b', group: 'Tax Declarations & Exemptions', key: 'declarations.section24b', sample: 0, getValue: (employee) => employee?.declarations?.section24b || 0 });
  columns.push({ header: 'Section 80CCD(1B)', group: 'Tax Declarations & Exemptions', key: 'declarations.section80CCD1B', sample: 0, getValue: (employee) => employee?.declarations?.section80CCD1B || 0 });
  columns.push({ header: 'Rent Paid Monthly', group: 'Tax Declarations & Exemptions', key: 'declarations.rentPaidMonthly', sample: 0, getValue: (employee) => employee?.declarations?.rentPaidMonthly || 0 });
  columns.push({ header: 'Is Metro City', group: 'Tax Declarations & Exemptions', key: 'declarations.isMetroCity', sample: 'No', getValue: (employee) => employee?.declarations?.isMetroCity ? 'Yes' : 'No' });
  columns.push({ header: 'Other Exemptions', group: 'Tax Declarations & Exemptions', key: 'declarations.otherExemptions', sample: 0, getValue: (employee) => employee?.declarations?.otherExemptions || 0 });

  rootCustomKeys.forEach(key => {
    columns.push({
      header: key,
      group: 'Other Details',
      key: key,
      getValue: (employee) => {
        const val = employee[key];
        if (val && typeof val === 'object') return JSON.stringify(val);
        return val !== undefined && val !== null ? val : '';
      }
    });
  });

  return columns;
};

const buildSalaryStructureFromCTC = (payload, config) => {
  const master = buildMasterSalaryStructure(payload, config);
  const salaryStructure = {
    basic: master.basicMaster,
    hra: master.hraMaster,
    conveyance: Number(payload.salaryStructure?.conveyance) || 0,
    medicalAllowance: Number(payload.salaryStructure?.medicalAllowance) || 0,
    specialAllowance: master.specialAllowance,
    grossSalary: master.grossSalary,
    ctc: master.monthlyCTC,
    otherAllowances: Array.isArray(payload.salaryStructure?.otherAllowances) ? payload.salaryStructure.otherAllowances : [],
  };

  if (config?.salaryComponents) {
    config.salaryComponents.forEach(c => {
      if (!['basic', 'hra', 'special', 'conveyance', 'medical', 'flexi', 'broadband', 'petrol', 'lta'].includes(c.id)) {
        if (payload.salaryStructure?.[c.id] !== undefined) {
          salaryStructure[c.id] = Number(payload.salaryStructure[c.id]) || 0;
        } else if (payload[c.id] !== undefined) {
          salaryStructure[c.id] = Number(payload[c.id]) || 0;
        }
      }
    });
  }

  return salaryStructure;
};

exports.getEmployees = async (req, res) => {
  try {
    const { status, department } = req.query;
    const parsedPage = Number.parseInt(req.query.page, 10);
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const page = Number.isInteger(parsedPage) ? Math.max(1, parsedPage) : 1;
    const limit = Number.isInteger(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 100)) : 20;
    const skip = (page - 1) * limit;
    const query = { user: req.user._id };

    if (status) query.status = status;
    if (department) query.department = department;

    const search = String(req.query.search || '').trim();
    if (search) {
      const safeSearch = escapeRegex(search.slice(0, 100));
      query.$or = [
        { employeeId: { $regex: safeSearch, $options: 'i' } },
        { firstName: { $regex: safeSearch, $options: 'i' } },
        { lastName: { $regex: safeSearch, $options: 'i' } },
        { email: { $regex: safeSearch, $options: 'i' } },
        { panNumber: { $regex: safeSearch, $options: 'i' } },
        { aadharNumber: { $regex: safeSearch, $options: 'i' } },
      ];
    }

    const total = await Employee.countDocuments(query);
    const employees = await Employee.find(query)
      .populate('department', 'name code')
      .select('+panNumber +aadharNumber')
      .select('-documents')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({ data: employees, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    console.error('Error fetching employees:', error);
    res.status(500).json({ message: 'Server error fetching employees' });
  }
};

exports.getActiveEmployees = async (req, res) => {
  try {
    const month = Number(req.query.month);
    const year = Number(req.query.year);
    const query = { user: req.user._id };

    if (Number.isInteger(month) && Number.isInteger(year)) {
      const startOfMonth = new Date(year, month - 1, 1);
      const endOfMonth = new Date(year, month, 0, 23, 59, 59, 999);

      query.joiningDate = { $lte: endOfMonth };
      query.$and = [
        {
          $or: [
            { status: 'active' },
            { dateOfLeaving: { $gte: startOfMonth, $lte: endOfMonth } }
          ]
        },
        {
          $or: [
            { dateOfLeaving: null },
            { dateOfLeaving: { $exists: false } },
            { dateOfLeaving: { $gte: startOfMonth } }
          ]
        }
      ];
    } else {
      query.status = 'active';
      query.$or = [
        { dateOfLeaving: null },
        { dateOfLeaving: { $exists: false } },
      ];
    }

    const employees = await Employee.find(query)
      .populate('department', 'name code')
      .sort({ firstName: 1, lastName: 1 })
      .lean();

    res.json(employees);
  } catch (error) {
    console.error('Error fetching active employees:', error);
    res.status(500).json({ message: 'Server error fetching active employees' });
  }
};

exports.createEmployee = async (req, res) => {
  try {
    const employeeData = { ...req.body, user: req.user._id };
    employeeData.department = await validateDepartment(employeeData.department, req.user._id);

    const employee = await Employee.create(employeeData);
    res.status(201).json(employee);
  } catch (error) {
    console.error('Error creating employee:', error);
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Employee ID already exists' });
    }
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error creating employee' });
  }
};

exports.getEmployeeById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const employee = await Employee.findOne({ _id: req.params.id, user: req.user._id })
      .populate('department', 'name code')
      .select('+panNumber +uanNumber +aadharNumber +bankDetails.accountNumber');

    if (!employee) return res.status(404).json({ message: 'Employee not found' });
    res.json(employee);
  } catch (error) {
    console.error('Error fetching employee:', error);
    res.status(500).json({ message: 'Server error fetching employee' });
  }
};

exports.updateEmployee = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const updateData = { ...req.body };
    if (Object.prototype.hasOwnProperty.call(updateData, 'department')) {
      updateData.department = await validateDepartment(updateData.department, req.user._id);
    }

    const employee = await Employee.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: updateData },
      { returnDocument: 'after', runValidators: true }
    )
      .populate('department', 'name code')
      .select('+panNumber +uanNumber +aadharNumber +bankDetails.accountNumber');

    if (!employee) return res.status(404).json({ message: 'Employee not found' });
    res.json(employee);
  } catch (error) {
    console.error('Error updating employee:', error);
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Employee ID already exists' });
    }
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error updating employee' });
  }
};

exports.deleteEmployee = async (req, res) => {
  try {
    const employeeId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(String(employeeId))) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const employee = await Employee.findOne({ _id: employeeId, user: req.user._id });
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    // 1. Find all payroll records to delete their generated expenses
    const payrolls = await Payroll.find({ user: req.user._id, employee: employeeId }).select('expenseRef');
    const expenseIds = payrolls.map(p => p.expenseRef).filter(Boolean);
    if (expenseIds.length > 0) {
      await Expense.updateMany({ user: req.user._id, _id: { $in: expenseIds } }, { $set: { isDeleted: true, deletedAt: new Date() } });
    }

    // 2. Delete payroll records
    await Payroll.updateMany({ user: req.user._id, employee: employeeId }, { $set: { isDeleted: true, deletedAt: new Date() } });

    // 3. Delete loans
    await Loan.updateMany({ user: req.user._id, employee: employeeId }, { $set: { isDeleted: true, deletedAt: new Date() } });

    // 4. Delete reimbursement claims
    await ReimbursementClaim.updateMany({ user: req.user._id, employee: employeeId }, { $set: { isDeleted: true, deletedAt: new Date() } });

    // 5. Pull employee from project teams
    await Project.updateMany(
      { user: req.user._id, team: employeeId },
      { $pull: { team: employeeId } }
    );

    // 6. Delete the employee profile itself
    await Employee.findOneAndUpdate({ _id: employeeId, user: req.user._id }, { $set: { isDeleted: true, deletedAt: new Date() } });

    res.json({ message: 'Employee and all associated payrolls, expenses, loans, and claims deleted successfully' });
  } catch (error) {
    console.error('Error deleting employee:', error);
    res.status(500).json({ message: 'Server error deleting employee' });
  }
};

exports.bulkDeleteEmployees = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'No employee IDs provided' });
    }

    const employeeIds = ids.filter(id => mongoose.Types.ObjectId.isValid(String(id)));
    if (employeeIds.length === 0) {
      return res.status(400).json({ message: 'No valid employee IDs provided' });
    }

    // 1. Find all payroll records to delete their generated expenses
    const payrolls = await Payroll.find({ user: req.user._id, employee: { $in: employeeIds } }).select('expenseRef');
    const expenseIds = payrolls.map(p => p.expenseRef).filter(Boolean);
    if (expenseIds.length > 0) {
      await Expense.updateMany({ user: req.user._id, _id: { $in: expenseIds } }, { $set: { isDeleted: true, deletedAt: new Date() } });
    }

    // 2. Delete payroll records
    await Payroll.updateMany({ user: req.user._id, employee: { $in: employeeIds } }, { $set: { isDeleted: true, deletedAt: new Date() } });

    // 3. Delete loans
    await Loan.updateMany({ user: req.user._id, employee: { $in: employeeIds } }, { $set: { isDeleted: true, deletedAt: new Date() } });

    // 4. Delete reimbursement claims
    await ReimbursementClaim.updateMany({ user: req.user._id, employee: { $in: employeeIds } }, { $set: { isDeleted: true, deletedAt: new Date() } });

    // 5. Pull employees from project teams
    await Project.updateMany(
      { user: req.user._id, team: { $in: employeeIds } },
      { $pull: { team: { $in: employeeIds } } }
    );

    // 6. Delete the employee profiles
    const result = await Employee.updateMany({ _id: { $in: employeeIds }, user: req.user._id }, { $set: { isDeleted: true, deletedAt: new Date() } });

    res.json({ 
      message: `${result.deletedCount} employees and all associated payrolls, expenses, loans, and claims deleted successfully`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Error bulk deleting employees:', error);
    res.status(500).json({ message: 'Server error bulk deleting employees' });
  }
};

exports.importEmployees = async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ message: 'Excel file is required' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // Detect if the sheet has a two-tier header or a single-tier header
    const firstCellAddress = XLSX.utils.encode_cell({ r: 0, c: 0 }); // A1
    const firstCell = sheet[firstCellAddress];
    const firstCellValue = firstCell ? String(firstCell.v).trim().toLowerCase() : '';

    let rangeStart = 0;
    if (firstCellValue && !['employee id', 'employeeid', 'employee_id'].includes(firstCellValue)) {
      // It's likely a two-tier sheet where Row 1 is a category header (like "Personal Details")
      // and Row 2 is the actual column headers
      rangeStart = 1;
    }

    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', range: rangeStart });
    const config = await getOrCreateConfig(req.user._id);

    let imported = 0;
    let skipped = 0;
    const errors = [];
    const importedEmployees = [];
    const createdDepartments = [];
    const warnings = [];
    const baseSequence = Date.now();
    const createdDeptNames = new Set();

    const parseYesNo = (val) => {
      if (val === '' || val === undefined || val === null) return undefined;
      const s = String(val).trim().toLowerCase();
      if (['yes', 'true', '1'].includes(s)) return true;
      if (['no', 'false', '0'].includes(s)) return false;
      return undefined;
    };

    for (let index = 0; index < rows.length; index += 1) {
      const rawRow = normalizeRow(rows[index]);
      let firstName = String(getCellValue(rawRow, ['FIRST NAME', 'FIRSTNAME'])).trim();
      let lastName = String(getCellValue(rawRow, ['LAST NAME', 'LASTNAME'])).trim();

      if (!firstName) {
        const fullName = getCellValue(rawRow, ['NAME OF EMPLOYEE', 'EMPLOYEE NAME', 'NAME']);
        const parsedName = splitEmployeeName(fullName);
        firstName = parsedName.firstName;
        lastName = parsedName.lastName;
      }

      if (!firstName) {
        skipped += 1;
        errors.push({ row: index + 2, message: 'Employee name is missing' });
        continue;
      }

      const employeeId = String(getCellValue(rawRow, ['EMP NO', 'EMPLOYEE ID', 'EMP ID', 'EMP NO.']) || `EMP-${baseSequence}-${index + 1}`).trim();
      const emailRaw = String(getCellValue(rawRow, ['EMAIL', 'EMAIL ID']) || `${employeeId.toLowerCase()}@import.local`).trim().toLowerCase();
      let monthlyCTC = Number(getCellValue(rawRow, ['MONTHLY CTC', 'CTC', 'MONTHLY SALARY'])) || 0;
      if (!monthlyCTC) {
        const annualCTC = Number(getCellValue(rawRow, ['ANNUAL CTC', 'ANNUAL SALARY', 'YEARLY CTC'])) || 0;
        if (annualCTC) {
          monthlyCTC = annualCTC / 12;
        }
      }
      const location = String(getCellValue(rawRow, ['LOCATION', 'WORK LOCATION']) || '').trim();
      const joiningDate = parsePossibleDate(getCellValue(rawRow, ['DOJ', 'JOINING DATE', 'DATE OF JOINING'])) || new Date();
      const dateOfLeaving = parsePossibleDate(getCellValue(rawRow, ['DOL', 'DATE OF LEAVING']));
      const dateOfBirth = parsePossibleDate(getCellValue(rawRow, ['DOB', 'DATE OF BIRTH']));
      let designation = String(getCellValue(rawRow, ['DESIGNATION']) || '').trim();
      const gender = String(getCellValue(rawRow, ['GENDER']) || '').trim();
      const accountName = String(getCellValue(rawRow, ['ACCOUNT NAME', 'BANK ACCOUNT NAME']) || '').trim();
      const accountNumber = String(getCellValue(rawRow, ['BANK A/C', 'ACCOUNT NUMBER', 'BANK ACCOUNT', 'BANK ACCOUNT NUMBER']) || '').trim();
      const ifscCode = String(getCellValue(rawRow, ['IFSC', 'IFSC CODE']) || '').trim();
      const bankName = String(getCellValue(rawRow, ['BANK NAME']) || '').trim();
      const branch = String(getCellValue(rawRow, ['BRANCH']) || '').trim();
      const panNumber = String(getCellValue(rawRow, ['PAN', 'PAN NO', 'PAN NUMBER']) || '').trim();
      const aadharNumber = String(getCellValue(rawRow, ['AADHAR', 'AADHAR NO', 'AADHAR NUMBER']) || '').trim();
      const uanNumber = String(getCellValue(rawRow, ['UAN', 'UAN NUMBER']) || '').trim();
      const phone = String(getCellValue(rawRow, ['PHONE', 'MOBILE', 'CONTACT']) || '').trim();
      const getStandardOrConfigValue = (cId, defaultAliases) => {
        const comp = config.salaryComponents?.find(c => c.id === cId);
        if (comp) {
          const val = getComponentValueFromRow(rawRow, comp);
          if (val !== undefined && val !== '') return Number(val) || 0;
        }
        return Number(getCellValue(rawRow, defaultAliases)) || 0;
      };

      const flexiAmount = getStandardOrConfigValue('flexi', ['FLEXI AMOUNT', 'FLEXI', 'FLEXI ALLOWANCE', 'MEAL ALLOWANCE']);
      const broadband = getStandardOrConfigValue('broadband', ['BROADBAND']);
      const petrol = getStandardOrConfigValue('petrol', ['PETROL']);
      const lta = getStandardOrConfigValue('lta', ['LTA']);
      const basicOverride = getStandardOrConfigValue('basic', ['BASIC SALARY', 'BASIC']);
      const hraOverride = getStandardOrConfigValue('hra', ['HRA', 'HOUSE RENT ALLOWANCE']);
      const conveyanceOverride = getStandardOrConfigValue('conveyance', ['CONVEYANCE', 'CONVEYANCE ALLOWANCE']);
      const medicalOverride = getStandardOrConfigValue('medical', ['MEDICAL ALLOWANCE', 'MEDICAL']);
      const employerNPS = Number(getCellValue(rawRow, ['EMPLOYER NPS', 'NPS'])) || 0;
      const rawInsurance = getCellValue(rawRow, ['INSURANCE', 'INSURANCE AMOUNT']);
      const insuranceAmount = (rawInsurance !== '' && !isNaN(Number(rawInsurance))) ? Number(rawInsurance) : 0;
      const joiningBonus = Number(getCellValue(rawRow, ['JOINING BONUS'])) || 0;
      const professionalTax = Number(getCellValue(rawRow, ['PROFESSIONAL TAX', 'PT', 'PROFESSIONAL TAX DEDUCTION'])) || 0;
      const tds = Number(getCellValue(rawRow, ['TDS', 'INCOME TAX', 'TDS DEDUCTION'])) || 0;

      // Employment type & status
      const employmentTypeRaw = String(getCellValue(rawRow, ['EMPLOYMENT TYPE']) || '').trim().toLowerCase();
      const employmentType = ['full-time', 'part-time', 'contract', 'intern'].includes(employmentTypeRaw) ? employmentTypeRaw : 'full-time';

      const statusRaw = String(getCellValue(rawRow, ['STATUS']) || '').trim().toLowerCase();
      let status = dateOfLeaving ? 'inactive' : 'active';
      if (['active', 'inactive', 'terminated'].includes(statusRaw)) status = statusRaw;

      const payTypeRaw = String(getCellValue(rawRow, ['PAY TYPE', 'PAYTYPE', 'PAY_TYPE']) || '').trim().toLowerCase();
      const payType = ['salaried', 'hourly'].includes(payTypeRaw) ? payTypeRaw : 'salaried';

      const compensationModelRaw = String(getCellValue(rawRow, ['COMPENSATION MODEL', 'COMPENSATIONMODEL', 'COMPENSATION_MODEL']) || '').trim().toUpperCase();
      const compensationModel = ['SALARIED', 'CONSULTANT', 'PROJECT', 'POSITION', 'INTERVIEW', 'HOURLY', 'CUSTOM'].includes(compensationModelRaw) ? compensationModelRaw : 'SALARIED';

      const paymentBasisRaw = String(getCellValue(rawRow, ['PAYMENT BASIS', 'PAYMENTBASIS', 'PAYMENT_BASIS']) || '').trim().toUpperCase();
      const paymentBasis = ['MONTHLY', 'PROJECT', 'POSITION', 'INTERVIEW', 'HOUR', 'DAY', 'MILESTONE', 'CUSTOM'].includes(paymentBasisRaw) ? paymentBasisRaw : 'MONTHLY';

      // New canonical compensation dimensions
      const VALID_COMP_TYPES = [
        'monthly_salary', 'hourly', 'daily_wage', 'weekly_salary', 'piece_rate',
        'project_based', 'milestone_based', 'attendance_based', 'timesheet_based',
        'commission_only', 'salary_plus_commission', 'retainer',
      ];
      const compensationTypeRaw = String(getCellValue(rawRow, ['COMPENSATION TYPE', 'COMPENSATIONTYPE', 'COMPENSATION_TYPE']) || '').trim().toLowerCase();
      const compensationType = VALID_COMP_TYPES.includes(compensationTypeRaw) ? compensationTypeRaw : null;

      const VALID_PAY_FREQ = ['monthly', 'weekly', 'biweekly', 'semi_monthly'];
      const payFrequencyRaw = String(getCellValue(rawRow, ['PAY FREQUENCY', 'PAYFREQUENCY', 'PAY_FREQUENCY']) || '').trim().toLowerCase();
      const payFrequency = VALID_PAY_FREQ.includes(payFrequencyRaw) ? payFrequencyRaw : 'monthly';

      const VALID_ATTEND_MODES = ['attendance', 'timesheet', 'shift', 'unit_count', 'fixed', 'none'];
      const attendanceModeRaw = String(getCellValue(rawRow, ['ATTENDANCE MODE', 'ATTENDANCEMODE', 'ATTENDANCE_MODE']) || '').trim().toLowerCase();
      const attendanceMode = VALID_ATTEND_MODES.includes(attendanceModeRaw) ? attendanceModeRaw : 'attendance';

      const hourlyRate = Number(getCellValue(rawRow, ['HOURLY RATE', 'HOURLYRATE', 'HOURLY_RATE'])) || 0;

      // Salary ratio overrides
      const basicPercentRaw = getCellValue(rawRow, ['BASIC %', 'BASIC PERCENT']);
      const basicPercent = (basicPercentRaw !== '' && !isNaN(Number(basicPercentRaw)) && Number(basicPercentRaw) > 0) ? Number(basicPercentRaw) : null;

      const hraPercentRaw = getCellValue(rawRow, ['HRA %', 'HRA PERCENT']);
      const hraPercent = (hraPercentRaw !== '' && !isNaN(Number(hraPercentRaw)) && Number(hraPercentRaw) > 0) ? Number(hraPercentRaw) : null;

      // Tax regime
      const taxRegimeRaw = String(getCellValue(rawRow, ['TAX REGIME']) || '').trim().toLowerCase();
      const taxRegime = ['old', 'new'].includes(taxRegimeRaw) ? taxRegimeRaw : 'new';

      // Statutory toggles
      const pfEnabled = parseYesNo(getCellValue(rawRow, ['PF ENABLED']));
      const tdsEnabled = parseYesNo(getCellValue(rawRow, ['TDS ENABLED']));
      const esiEnabled = parseYesNo(getCellValue(rawRow, ['ESI ENABLED']));
      const ptEnabled = parseYesNo(getCellValue(rawRow, ['PT ENABLED']));
      const lwfEnabled = parseYesNo(getCellValue(rawRow, ['LWF ENABLED']));
      const gratuityEnabled = parseYesNo(getCellValue(rawRow, ['GRATUITY ENABLED']));
      const includePfInCTC = parseYesNo(getCellValue(rawRow, ['INCLUDE PF IN CTC']));
      const includeGratuityInCTC = parseYesNo(getCellValue(rawRow, ['INCLUDE GRATUITY IN CTC']));
      const useSalaryComponents = parseYesNo(getCellValue(rawRow, ['USE SALARY COMPONENTS', 'USE_SALARY_COMPONENTS']));

      const isIntern = employmentType === 'intern';
      // Resolve effective compensation type for statutory flag defaults
      const { deriveCompensationTypeFromLegacy, getStrategyStatutoryDefaults } = require('../utils/payrollStrategies/index');
      const effectiveCompType = compensationType || deriveCompensationTypeFromLegacy({ payType, compensationModel, employmentType });
      const stratFlags = getStrategyStatutoryDefaults(effectiveCompType);
      const isHourly = payType === 'hourly' || effectiveCompType === 'hourly';
      const defaultToggle = stratFlags.pfEligible !== false && !isIntern;

      const pfEnabledVal = pfEnabled !== undefined ? pfEnabled : defaultToggle;
      const tdsEnabledVal = tdsEnabled !== undefined ? tdsEnabled : defaultToggle;
      const esiEnabledVal = esiEnabled !== undefined ? esiEnabled : defaultToggle;
      const ptEnabledVal = ptEnabled !== undefined ? ptEnabled : defaultToggle;
      const lwfEnabledVal = lwfEnabled !== undefined ? lwfEnabled : defaultToggle;
      const gratuityEnabledVal = gratuityEnabled !== undefined ? gratuityEnabled : defaultToggle;
      const includePfInCTCVal = includePfInCTC !== undefined ? includePfInCTC : false;
      const includeGratuityInCTCVal = includeGratuityInCTC !== undefined ? includeGratuityInCTC : defaultToggle;
      const useSalaryComponentsVal = useSalaryComponents !== undefined ? useSalaryComponents : defaultToggle;

      // Address
      const addressLine1 = String(getCellValue(rawRow, ['ADDRESS LINE 1']) || '').trim();
      const addressLine2 = String(getCellValue(rawRow, ['ADDRESS LINE 2']) || '').trim();
      const city = String(getCellValue(rawRow, ['CITY']) || '').trim();
      const state = String(getCellValue(rawRow, ['STATE']) || '').trim();
      const zip = String(getCellValue(rawRow, ['ZIP', 'PINCODE', 'PIN CODE']) || '').trim();
      const country = String(getCellValue(rawRow, ['COUNTRY']) || '').trim();

      // Declarations
      const section80C = Number(getCellValue(rawRow, ['SECTION 80C'])) || 0;
      const section80D = Number(getCellValue(rawRow, ['SECTION 80D'])) || 0;
      const section24b = Number(getCellValue(rawRow, ['SECTION 24B'])) || 0;
      const section80CCD1B = Number(getCellValue(rawRow, ['SECTION 80CCD(1B)', 'SECTION 80CCD1B'])) || 0;
      const rentPaidMonthly = Number(getCellValue(rawRow, ['RENT PAID MONTHLY'])) || 0;
      const isMetroCity = parseYesNo(getCellValue(rawRow, ['IS METRO CITY']));
      const otherExemptions = Number(getCellValue(rawRow, ['OTHER EXEMPTIONS'])) || 0;

      // Department lookup or create by name
      let departmentName = String(getCellValue(rawRow, ['DEPARTMENT', 'DEPT']) || '').trim();
      if ((departmentName.startsWith('"') && departmentName.endsWith('"')) || (departmentName.startsWith("'") && departmentName.endsWith("'"))) {
        departmentName = departmentName.slice(1, -1).trim();
      }
      let departmentId = null;
      if (departmentName) {
        let dept = await Department.findOne({
          user: req.user._id,
          name: { $regex: new RegExp(`^${escapeRegex(departmentName)}$`, 'i') },
        });
        if (!dept) {
          let baseCode = departmentName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5).toUpperCase();
          if (!baseCode) baseCode = 'DEPT';
          let code = baseCode;
          let counter = 1;
          while (await Department.exists({ user: req.user._id, code })) {
            code = `${baseCode}${counter}`;
            counter += 1;
          }
          dept = await Department.create({
            user: req.user._id,
            name: departmentName,
            code,
            description: 'Auto-created during employee import',
          });
          if (!createdDeptNames.has(departmentName.toLowerCase())) {
            createdDeptNames.add(departmentName.toLowerCase());
            createdDepartments.push({ name: departmentName, code });
          }
        }
        if (dept) departmentId = dept._id;
      }

      // Role lookup by name or ID
      let roleName = String(getCellValue(rawRow, ['JOB ROLE TEMPLATE', 'ROLE', 'JOB_ROLE_TEMPLATE']) || '').trim();
      if ((roleName.startsWith('"') && roleName.endsWith('"')) || (roleName.startsWith("'") && roleName.endsWith("'"))) {
        roleName = roleName.slice(1, -1).trim();
      }
      if ((designation.startsWith('"') && designation.endsWith('"')) || (designation.startsWith("'") && designation.endsWith("'"))) {
        designation = designation.slice(1, -1).trim();
      }
      let roleId = null;
      let roleDoc = null;
      if (roleName) {
        const Role = mongoose.model('Role');
        if (mongoose.Types.ObjectId.isValid(roleName)) {
          roleDoc = await Role.findOne({ _id: roleName, user: req.user._id });
        }
        if (!roleDoc) {
          roleDoc = await Role.findOne({
            user: req.user._id,
            name: { $regex: new RegExp(`^${escapeRegex(roleName)}$`, 'i') }
          });
        }
        if (roleDoc) {
          roleId = roleDoc._id;
          if (designation && (designation === roleName || designation === String(roleDoc._id) || mongoose.Types.ObjectId.isValid(designation))) {
            designation = roleDoc.name;
          }
        } else {
          if (mongoose.Types.ObjectId.isValid(designation)) {
            designation = '';
          }
        }
      } else {
        if (mongoose.Types.ObjectId.isValid(designation)) {
          designation = '';
        }
      }

      const payload = {
        user: req.user._id,
        employeeId,
        firstName,
        lastName,
        email: emailRaw,
        phone,
        gender: ['Male', 'Female', 'Other'].includes(gender) ? gender : '',
        ...(dateOfBirth && { dateOfBirth }),
        joiningDate,
        location,
        dateOfLeaving,
        designation,
        ...(departmentId && { department: departmentId }),
        ...(roleId && { role: roleId }),
        employmentType,
        compensationModel,
        paymentBasis,
        status,
        monthlyCTC: isHourly ? 0 : monthlyCTC,
        payType,
        compensationType,
        payFrequency,
        attendanceMode,
        hourlyRate: isHourly ? hourlyRate : 0,
        flexiAmount,
        broadband,
        petrol,
        lta,
        employerNPS,
        insuranceAmount,
        joiningBonus,
        basicPercent,
        hraPercent,
        ...(basicOverride > 0 && { basic: basicOverride }),
        ...(hraOverride > 0 && { hra: hraOverride }),
        taxRegime,
        pfEnabled: pfEnabledVal,
        tdsEnabled: tdsEnabledVal,
        esiEnabled: esiEnabledVal,
        ptEnabled: ptEnabledVal,
        lwfEnabled: lwfEnabledVal,
        gratuityEnabled: gratuityEnabledVal,
        includePfInCTC: includePfInCTCVal,
        includeGratuityInCTC: includeGratuityInCTCVal,
        useSalaryComponents: useSalaryComponentsVal,
        address: {
          line1: addressLine1,
          line2: addressLine2,
          city,
          state,
          zip,
          country: country || 'India',
        },
        salaryStructure: {
          conveyance: conveyanceOverride,
          medicalAllowance: medicalOverride,
          otherAllowances: [],
          ...(basicOverride > 0 && { basic: basicOverride }),
          ...(hraOverride > 0 && { hra: hraOverride }),
        },
        deductions: {
          professionalTax,
          tds,
        },
        bankDetails: {
          accountName: accountName || `${firstName} ${lastName}`.trim(),
          accountNumber,
          ifscCode,
          bankName,
          branch,
        },
        panNumber,
        aadharNumber,
        uanNumber,
        declarations: {
          section80C,
          section80D,
          section24b,
          section80CCD1B,
          rentPaidMonthly,
          isMetroCity: isMetroCity === true,
          otherExemptions,
        },
      };

      // Gather any custom components and root custom fields
      if (config.salaryComponents) {
        config.salaryComponents.forEach(c => {
          if (!['basic', 'hra', 'special', 'conveyance', 'medical', 'flexi', 'broadband', 'petrol', 'lta'].includes(c.id)) {
            const val = getComponentValueFromRow(rawRow, c);
            if (val !== undefined && val !== '') {
              payload.salaryStructure[c.id] = Number(val) || 0;
            }
          }
        });
      }

      Object.keys(rawRow).forEach((key) => {
        if (!standardAliases.has(key)) {
          const isSalaryComp = config.salaryComponents?.some(c => {
            const normId = String(c.id).toUpperCase().replace(/[^A-Z0-9]/g, '');
            const normName = String(c.name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
            const normHeader = String(key).toUpperCase().replace(/[^A-Z0-9]/g, '');
            return normHeader === normId || normHeader === normName || normHeader.startsWith(normName) || normName.startsWith(normHeader);
          });
          if (!isSalaryComp) {
            const camelKey = toCamelCase(key);
            if (camelKey) {
              let val = rawRow[key];
              if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
                try {
                  val = JSON.parse(val);
                } catch (e) {
                  // Keep as string
                }
              }
              payload[camelKey] = val;
            }
          }
        }
      });

      const salaryStructure = buildSalaryStructureFromCTC(payload, config);
      payload.salaryStructure = salaryStructure;

      // Collect per-row warnings for data quality issues
      const rowWarnings = [];
      if (emailRaw.endsWith('@import.local')) rowWarnings.push('Email auto-generated (not provided)');
      if (!monthlyCTC) rowWarnings.push('No CTC specified');
      if (!panNumber) rowWarnings.push('PAN missing');
      if (!accountNumber) rowWarnings.push('Bank account missing');

      try {
        let created;
        const existing = await Employee.findOne({ user: req.user._id, employeeId });
        if (existing) {
          created = await Employee.findOneAndUpdate(
            { _id: existing._id, user: req.user._id },
            { $set: payload },
            { returnDocument: 'after', runValidators: true }
          );
        } else {
          created = await Employee.create(payload);
        }
        imported += 1;
        const empSummary = {
          row: index + 2,
          employeeId,
          employeeName: `${firstName} ${lastName}`.trim(),
          email: emailRaw,
          monthlyCTC,
          department: departmentName || null,
          designation: designation || null,
          status,
        };
        if (rowWarnings.length > 0) empSummary.warnings = rowWarnings;
        importedEmployees.push(empSummary);
        if (rowWarnings.length > 0) {
          warnings.push({ row: index + 2, employeeId, employeeName: empSummary.employeeName, issues: rowWarnings });
        }
      } catch (error) {
        skipped += 1;
        errors.push({
          row: index + 2,
          employeeId,
          employeeName: `${firstName} ${lastName}`.trim(),
          email: emailRaw,
          message: error.code === 11000 ? 'Duplicate employee ID or email' : error.message,
        });
      }
    }

    // Build summary statistics
    const totalCTC = importedEmployees.reduce((sum, emp) => sum + (emp.monthlyCTC || 0), 0);
    const byDepartment = {};
    importedEmployees.forEach(emp => {
      const dept = emp.department || 'Unassigned';
      byDepartment[dept] = (byDepartment[dept] || 0) + 1;
    });
    const byStatus = {};
    importedEmployees.forEach(emp => {
      byStatus[emp.status] = (byStatus[emp.status] || 0) + 1;
    });

    res.json({
      imported,
      skipped,
      totalRows: rows.length,
      errors,
      warnings,
      importedEmployees,
      createdDepartments,
      summary: {
        totalMonthlyCTC: Math.round(totalCTC * 100) / 100,
        totalAnnualCTC: Math.round(totalCTC * 12 * 100) / 100,
        byDepartment,
        byStatus,
        withWarnings: warnings.length,
      },
    });
  } catch (error) {
    console.error('Error importing employees:', error);
    res.status(500).json({ message: 'Server error importing employees' });
  }
};

exports.exportEmployeesExcel = async (req, res) => {
  try {
    try {
      mongoose.model('Role');
    } catch (e) {
      require('../models/Role');
    }
    try {
      mongoose.model('Department');
    } catch (e) {
      require('../models/Department');
    }

    const employees = await Employee.find({ user: req.user._id })
      .populate('department', 'name code')
      .populate('role', 'name')
      .select('+panNumber +aadharNumber +uanNumber +bankDetails.accountNumber')
      .sort({ createdAt: -1 })
      .lean();

    const config = await getOrCreateConfig(req.user._id);

    const standardKeys = new Set([
      '_id', 'user', 'employeeId', 'firstName', 'lastName', 'email', 'phone', 'dateOfBirth', 'gender',
      'address', 'designation', 'department', 'joiningDate', 'location', 'dateOfLeaving', 'employmentType',
      'status', 'monthlyCTC', 'flexiAmount', 'broadband', 'petrol', 'lta', 'employerNPS', 'insuranceAmount',
      'joiningBonus', 'basicPercent', 'hraPercent', 'pfEnabled', 'tdsEnabled', 'esiEnabled', 'ptEnabled', 'lwfEnabled',
      'gratuityEnabled', 'includePfInCTC', 'includeGratuityInCTC', 'salaryStructure', 'deductions',
      'bankDetails', 'panNumber', 'uanNumber', 'aadharNumber', 'taxRegime', 'declarations', 'documents',
      'salaryRevisions', 'createdAt', 'updatedAt', '__v', 'payType', 'hourlyRate', 'role',
      'compensationModel', 'paymentBasis'
    ]);

    const rootCustomKeysSet = new Set();
    employees.forEach((employee) => {
      Object.keys(employee).forEach((key) => {
        if (!standardKeys.has(key) && !key.startsWith('_') && !key.startsWith('$')) {
          const isSalaryComp = config.salaryComponents?.some(c => c.id === key);
          if (!isSalaryComp) {
            rootCustomKeysSet.add(key);
          }
        }
      });
    });
    const rootCustomKeys = Array.from(rootCustomKeysSet).sort();

    const columns = buildExcelColumns(config, rootCustomKeys);

    // Compute Merges dynamically
    const merges = [];
    let start = 0;
    for (let i = 1; i <= columns.length; i++) {
      if (i === columns.length || columns[i].group !== columns[start].group) {
        if (columns[start].group) {
          merges.push({
            s: { r: 0, c: start },
            e: { r: 0, c: i - 1 }
          });
        }
        start = i;
      }
    }

    const headerGroups = Array(columns.length).fill('');
    merges.forEach(merge => {
      headerGroups[merge.s.c] = columns[merge.s.c].group;
    });

    const headers = columns.map(c => c.header);

    const dataRows = employees.map((employee, index) => {
      const rNum = index + 3;
      return columns.map(col => {
        if (typeof col.getValue === 'function') {
          return col.getValue(employee, rNum, 'export');
        }
        const keys = col.key.split('.');
        let val = employee;
        for (const k of keys) {
          val = val ? val[k] : undefined;
        }
        if (['pfEnabled', 'tdsEnabled', 'esiEnabled', 'ptEnabled', 'lwfEnabled', 'gratuityEnabled', 'includePfInCTC', 'includeGratuityInCTC'].includes(col.key)) {
          if (val === true || val === 'true') return 'Yes';
          if (val === false || val === 'false') return 'No';
          if (col.key === 'includePfInCTC') return 'No';
          return 'Yes';
        }
        if (col.type === 'date') {
          return formatDateOnly(val);
        }
        return val !== undefined && val !== null ? val : '';
      });
    });

    const startRow = 3;
    const endRow = employees.length + 2;
    const totals = Array(columns.length).fill('');
    totals[0] = 'TOTAL';
    columns.forEach((col, colIdx) => {
      if (col.isSummable) {
        const colLetter = XLSX.utils.encode_col(colIdx);
        totals[colIdx] = { f: `SUM(${colLetter}${startRow}:${colLetter}${endRow})` };
      }
    });

    const rows = [
      headerGroups,
      headers,
      ...dataRows,
      totals
    ];

    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    worksheet['!merges'] = merges;
    const workbook = XLSX.utils.book_new();
    workbook.Workbook = { WBProps: { fullCalcOnLoad: true } };

    columns.forEach((col, colIdx) => {
      const grp = col.group;
      const colors = GROUP_COLORS[grp] || { bg: 'FFFFFF', fg: '000000' };
      const colLetter = XLSX.utils.encode_col(colIdx);
      const addr1 = `${colLetter}1`;
      const addr2 = `${colLetter}2`;
      [addr1, addr2].forEach((addr) => {
        if (!worksheet[addr]) return;
        worksheet[addr].s = {
          font: { bold: true, color: { rgb: colors.fg } },
          fill: { fgColor: { rgb: colors.bg } },
          alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
          border: {
            top: { style: 'thin', color: { rgb: 'D9D9D9' } },
            bottom: { style: 'thin', color: { rgb: 'D9D9D9' } },
            left: { style: 'thin', color: { rgb: 'D9D9D9' } },
            right: { style: 'thin', color: { rgb: 'D9D9D9' } }
          }
        };
      });
    });

    const totalRowIndex = employees.length + 3;
    for (let c = 0; c < columns.length; c++) {
      const cellAddress = `${XLSX.utils.encode_col(c)}${totalRowIndex}`;
      if (worksheet[cellAddress]) {
        worksheet[cellAddress].s = {
          font: { bold: true, color: { rgb: '000000' } },
          fill: { fgColor: { rgb: 'F2F2F2' } },
          alignment: { horizontal: c === 0 ? 'left' : 'right', vertical: 'center' },
          border: {
            top: { style: 'thin', color: { rgb: 'A0A0A0' } },
            bottom: { style: 'double', color: { rgb: '000000' } }
          }
        };
      }
    }

    worksheet['!cols'] = columns.map(() => ({ wch: 18 }));

    XLSX.utils.book_append_sheet(workbook, worksheet, 'Employees');
    sendWorkbook(res, workbook, 'employees.xlsx');
  } catch (error) {
    console.error('Error exporting employees:', error);
    res.status(500).json({ message: 'Server error exporting employees' });
  }
};


exports.downloadImportTemplateExcel = async (req, res) => {
  try {
    const config = await getOrCreateConfig(req.user._id);
    const columns = buildExcelColumns(config);

    // Compute Merges dynamically
    const merges = [];
    let start = 0;
    for (let i = 1; i <= columns.length; i++) {
      if (i === columns.length || columns[i].group !== columns[start].group) {
        if (columns[start].group) {
          merges.push({
            s: { r: 0, c: start },
            e: { r: 0, c: i - 1 }
          });
        }
        start = i;
      }
    }

    const headerGroups = Array(columns.length).fill('');
    merges.forEach(merge => {
      headerGroups[merge.s.c] = columns[merge.s.c].group;
    });

    const headers = columns.map(c => c.header);

    const sampleRow = columns.map(col => {
      if (typeof col.getValue === 'function') {
        return col.getValue(null, 3, 'template');
      }
      return col.sample !== undefined ? col.sample : '';
    });

    const rows = [headerGroups, headers, sampleRow];

    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    worksheet['!merges'] = merges;
    const workbook = XLSX.utils.book_new();
    workbook.Workbook = { WBProps: { fullCalcOnLoad: true } };

    columns.forEach((col, colIdx) => {
      const grp = col.group;
      const colors = GROUP_COLORS[grp] || { bg: 'FFFFFF', fg: '000000' };
      const colLetter = XLSX.utils.encode_col(colIdx);
      const addr1 = `${colLetter}1`;
      const addr2 = `${colLetter}2`;
      [addr1, addr2].forEach((addr) => {
        if (!worksheet[addr]) return;
        worksheet[addr].s = {
          font: { bold: true, color: { rgb: colors.fg } },
          fill: { fgColor: { rgb: colors.bg } },
          alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
          border: {
            top: { style: 'thin', color: { rgb: 'D9D9D9' } },
            bottom: { style: 'thin', color: { rgb: 'D9D9D9' } },
            left: { style: 'thin', color: { rgb: 'D9D9D9' } },
            right: { style: 'thin', color: { rgb: 'D9D9D9' } }
          }
        };
      });
    });

    worksheet['!cols'] = headers.map(() => ({ wch: 18 }));

    XLSX.utils.book_append_sheet(workbook, worksheet, 'Template');
    sendWorkbook(res, workbook, 'employee_import_template.xlsx');
  } catch (error) {
    console.error('Error generating import template:', error);
    res.status(500).json({ message: 'Server error generating import template' });
  }
};


/**
 * Validates payload values according to the requirements of the selected compensationType.
 * Returns null if valid, or a string error message if invalid.
 */
function validateCompensationTypePayload(compensationType, payload) {
  const compType = compensationType || 'monthly_salary';
  const monthlyCTC = Number(payload.monthlyCTC ?? payload.newCTC) || 0;
  const hourlyRate = Number(payload.hourlyRate ?? payload.newHourlyRate) || 0;
  const dailyRate = Number(payload.dailyRate) || 0;
  const rateCard = Array.isArray(payload.rateCard) ? payload.rateCard : [];

  if (compType === 'hourly') {
    if (hourlyRate <= 0) {
      return 'Hourly employees require a positive hourly rate (hourlyRate > 0)';
    }
  } else if (compType === 'daily_wage') {
    if (dailyRate <= 0 && monthlyCTC <= 0) {
      return 'Daily wage employees require a positive daily rate or monthly CTC';
    }
  } else if (compType === 'piece_rate') {
    const hasUnitRate = rateCard.some(r => (r.paymentType === 'UNIT' || r.unit === 'unit') && Number(r.rate) > 0);
    if (!hasUnitRate) {
      return 'Piece rate employees require at least one rate card item with paymentType UNIT and rate > 0';
    }
  } else if (['monthly_salary', 'attendance_based', 'salary_plus_commission', 'weekly_salary'].includes(compType)) {
    if (monthlyCTC <= 0) {
      return `Employees on ${compType.replace(/_/g, ' ')} require a positive monthly CTC (monthlyCTC > 0)`;
    }
  } else if (compType === 'retainer') {
    const hasMonthlyRateCard = rateCard.some(r => (r.paymentType === 'MONTHLY' || r.unit === 'month') && Number(r.rate) > 0);
    if (monthlyCTC <= 0 && !hasMonthlyRateCard) {
      return 'Retainer employees require either a positive monthly CTC or a MONTHLY rate card entry';
    }
  }
  return null;
}

exports.addSalaryRevision = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const employee = await Employee.findOne({ _id: req.params.id, user: req.user._id });
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    const effectiveDate = parsePossibleDate(req.body.effectiveDate);
    const { resolveStrategy, resolveCompensationType } = require('../utils/payrollStrategies/index');
    const effectiveCompType = resolveCompensationType(req.body.compensationType ? req.body : employee);
    const strategyMeta = resolveStrategy(effectiveCompType);
    const stratFlags = strategyMeta.defaultStatutoryFlags();
    const isHourly = effectiveCompType === 'hourly';
    const skipFixedComponents = !strategyMeta.usesSalaryComponents;

    let newCTC = Number(req.body.newCTC);
    let newHourlyRate = Number(req.body.newHourlyRate);

    if (isHourly) {
      if (!effectiveDate || !newHourlyRate || newHourlyRate < 0) {
        return res.status(400).json({ message: 'Effective date and new hourly rate are required' });
      }
      newCTC = 0;
    } else {
      if (!effectiveDate || (newCTC === undefined || newCTC === null || newCTC < 0)) {
        return res.status(400).json({ message: 'Effective date and new monthly CTC are required' });
      }
    }

    const valError = validateCompensationTypePayload(effectiveCompType, {
      monthlyCTC: newCTC,
      hourlyRate: newHourlyRate,
      dailyRate: req.body.dailyRate,
      rateCard: req.body.rateCard !== undefined ? req.body.rateCard : employee.rateCard,
    });
    if (valError) {
      return res.status(400).json({ message: valError });
    }

    const config = await getOrCreateConfig(req.user._id);
    const previousCTC = Number(employee.monthlyCTC) || Number(employee.salaryStructure?.ctc) || 0;
    const previousHourlyRate = Number(employee.hourlyRate) || 0;
    
    let revisedRole = employee.role;
    let roleDoc = null;
    if (req.body.role !== undefined) {
      const roleId = req.body.role;
      if (roleId) {
        if (!mongoose.Types.ObjectId.isValid(String(roleId))) {
          return res.status(400).json({ message: 'Invalid Role ID format' });
        }
        const Role = mongoose.model('Role');
        roleDoc = await Role.findOne({ _id: roleId, user: req.user._id });
        if (!roleDoc) {
          return res.status(400).json({ message: 'Job Role Template not found' });
        }
        revisedRole = roleDoc._id;
      } else {
        revisedRole = null;
      }
    }

    const getVal = (field) => {
      if (req.body[field] !== undefined) return req.body[field];
      if (roleDoc && roleDoc[field] !== undefined && roleDoc[field] !== null) return roleDoc[field];
      return employee[field];
    };

    const nextPayload = {
      ...employee.toObject(),
      role: revisedRole,
      monthlyCTC: isHourly ? 0 : newCTC,
      hourlyRate: isHourly ? newHourlyRate : 0,
      useSalaryComponents: skipFixedComponents ? false : getVal('useSalaryComponents'),
      employmentType: isHourly ? 'contract' : getVal('employmentType'),
      compensationModel: req.body.compensationModel !== undefined ? req.body.compensationModel : employee.compensationModel,
      paymentBasis: req.body.paymentBasis !== undefined ? req.body.paymentBasis : employee.paymentBasis,
      rateCard: req.body.rateCard !== undefined ? req.body.rateCard : employee.rateCard,
      pfEnabled: req.body.pfEnabled !== undefined ? req.body.pfEnabled : (skipFixedComponents ? stratFlags.pfEligible : getVal('pfEnabled')),
      tdsEnabled: getVal('tdsEnabled') !== false,
      esiEnabled: req.body.esiEnabled !== undefined ? req.body.esiEnabled : (skipFixedComponents ? stratFlags.esiEligible : getVal('esiEnabled')),
      ptEnabled: req.body.ptEnabled !== undefined ? req.body.ptEnabled : (skipFixedComponents ? stratFlags.ptApplicable : getVal('ptEnabled')),
      lwfEnabled: req.body.lwfEnabled !== undefined ? req.body.lwfEnabled : (skipFixedComponents ? stratFlags.lwfApplicable : getVal('lwfEnabled')),
      gratuityEnabled: req.body.gratuityEnabled !== undefined ? req.body.gratuityEnabled : (skipFixedComponents ? stratFlags.gratuityEligible : getVal('gratuityEnabled')),
      includePfInCTC: skipFixedComponents ? false : getVal('includePfInCTC'),
      includeGratuityInCTC: skipFixedComponents ? false : getVal('includeGratuityInCTC'),
      basicPercent: skipFixedComponents ? null : getVal('basicPercent'),
      hraPercent: skipFixedComponents ? null : getVal('hraPercent'),
      joiningBonus: skipFixedComponents ? 0 : (req.body.joiningBonus !== undefined ? Number(req.body.joiningBonus) : (Number(employee.joiningBonus) || 0)),
      flexiAmount: skipFixedComponents ? 0 : (req.body.flexiAmount !== undefined ? Number(req.body.flexiAmount) : (Number(employee.flexiAmount) || 0)),
      broadband: skipFixedComponents ? 0 : (req.body.broadband !== undefined ? Number(req.body.broadband) : (Number(employee.broadband) || 0)),
      petrol: skipFixedComponents ? 0 : (req.body.petrol !== undefined ? Number(req.body.petrol) : (Number(employee.petrol) || 0)),
      lta: skipFixedComponents ? 0 : (req.body.lta !== undefined ? Number(req.body.lta) : (Number(employee.lta) || 0)),
      employerNPS: skipFixedComponents ? 0 : (req.body.employerNPS !== undefined ? Number(req.body.employerNPS) : (Number(employee.employerNPS) || 0)),
      insuranceAmount: skipFixedComponents ? 0 : (req.body.insuranceAmount !== undefined ? Number(req.body.insuranceAmount) : (Number(employee.insuranceAmount) || 0)),
      deductions: {
        ...(employee.deductions || {}),
        tds: req.body.tds !== undefined ? Number(req.body.tds) : (employee.deductions?.tds || 0),
        professionalTax: skipFixedComponents ? 0 : (req.body.professionalTax !== undefined ? Number(req.body.professionalTax) : (employee.deductions?.professionalTax || 0)),
        otherDeductions: isHourly ? [] : (req.body.otherDeductions !== undefined ? req.body.otherDeductions : (employee.deductions?.otherDeductions || [])),
      },
      salaryStructure: {
        conveyance: isHourly ? 0 : (req.body.conveyance !== undefined ? Number(req.body.conveyance) : (Number(employee.salaryStructure?.conveyance) || 0)),
        medicalAllowance: isHourly ? 0 : (req.body.medicalAllowance !== undefined ? Number(req.body.medicalAllowance) : (Number(employee.salaryStructure?.medicalAllowance) || 0)),
        otherAllowances: isHourly ? [] : (req.body.otherAllowances !== undefined ? req.body.otherAllowances : (employee.salaryStructure?.otherAllowances || [])),
        ...(req.body.basic !== undefined && { basic: Number(req.body.basic) }),
        ...(req.body.hra !== undefined && { hra: Number(req.body.hra) }),
      },
    };

    // Copy any custom percentage overrides from req.body to nextPayload
    Object.keys(req.body).forEach(key => {
      if (key.endsWith('Percent') && !['basicPercent', 'hraPercent'].includes(key)) {
        nextPayload[key] = req.body[key] === null || req.body[key] === '' ? null : Number(req.body[key]);
      }
    });

    const salaryStructure = buildSalaryStructureFromCTC(nextPayload, config);

    if (!employee.salaryRevisions || employee.salaryRevisions.length === 0) {
      employee.salaryRevisions.push({
        effectiveDate: employee.joiningDate || new Date(0),
        previousCTC: isHourly ? 0 : 0,
        newCTC: isHourly ? 0 : previousCTC,
        previousHourlyRate: isHourly ? 0 : undefined,
        newHourlyRate: isHourly ? previousHourlyRate : undefined,
        hourlyRate: isHourly ? previousHourlyRate : undefined,
        reason: 'Initial Salary Setup',
        revisedBy: 'System',
        createdAt: employee.createdAt || new Date(),
        role: employee.role || null,
        useSalaryComponents: isHourly ? false : employee.useSalaryComponents !== false,
        employmentType: employee.employmentType || 'full-time',
        compensationModel: employee.compensationModel || 'SALARIED',
        paymentBasis: employee.paymentBasis || 'MONTHLY',
        
        monthlyCTC: isHourly ? 0 : previousCTC,
        pfEnabled: isHourly ? false : employee.pfEnabled !== false,
        esiEnabled: isHourly ? false : employee.esiEnabled !== false,
        ptEnabled: isHourly ? false : employee.ptEnabled !== false,
        lwfEnabled: isHourly ? false : employee.lwfEnabled !== false,
        gratuityEnabled: isHourly ? false : employee.gratuityEnabled !== false,
        includePfInCTC: isHourly ? false : employee.includePfInCTC === true,
        includeGratuityInCTC: isHourly ? false : employee.includeGratuityInCTC !== false,
        basicPercent: isHourly ? null : employee.basicPercent,
        hraPercent: isHourly ? null : employee.hraPercent,
        joiningBonus: isHourly ? 0 : (Number(employee.joiningBonus) || 0),
        flexiAmount: isHourly ? 0 : (Number(employee.flexiAmount) || 0),
        broadband: isHourly ? 0 : (Number(employee.broadband) || 0),
        petrol: isHourly ? 0 : (Number(employee.petrol) || 0),
        lta: isHourly ? 0 : (Number(employee.lta) || 0),
        employerNPS: isHourly ? 0 : (Number(employee.employerNPS) || 0),
        insuranceAmount: isHourly ? 0 : (Number(employee.insuranceAmount) || 0),
        deductions: {
          tds: employee.deductions?.tds || 0,
          professionalTax: isHourly ? 0 : (employee.deductions?.professionalTax || 0),
          otherDeductions: isHourly ? [] : (employee.deductions?.otherDeductions || []),
        },
        salaryStructure: {
          conveyance: isHourly ? 0 : (Number(employee.salaryStructure?.conveyance) || 0),
          medicalAllowance: isHourly ? 0 : (Number(employee.salaryStructure?.medicalAllowance) || 0),
          otherAllowances: isHourly ? [] : (employee.salaryStructure?.otherAllowances || []),
        },
      });
    } else {
      const sortedRevs = [...employee.salaryRevisions].sort((a, b) => new Date(a.effectiveDate) - new Date(b.effectiveDate));
      const latestExisting = sortedRevs[sortedRevs.length - 1];
      const latestInDoc = employee.salaryRevisions.find(r => String(r._id) === String(latestExisting._id));
      if (latestInDoc) {
        if (latestInDoc.pfEnabled === undefined || latestInDoc.pfEnabled === null) {
          latestInDoc.monthlyCTC = isHourly ? 0 : (Number(latestInDoc.newCTC) || previousCTC);
          latestInDoc.hourlyRate = isHourly ? (Number(latestInDoc.newHourlyRate) || previousHourlyRate) : 0;
          latestInDoc.useSalaryComponents = isHourly ? false : employee.useSalaryComponents !== false;
          latestInDoc.employmentType = latestInDoc.employmentType || employee.employmentType || 'full-time';
          latestInDoc.compensationModel = latestInDoc.compensationModel || employee.compensationModel || 'SALARIED';
          latestInDoc.paymentBasis = latestInDoc.paymentBasis || employee.paymentBasis || 'MONTHLY';
          latestInDoc.pfEnabled = isHourly ? false : employee.pfEnabled !== false;
          latestInDoc.tdsEnabled = employee.tdsEnabled !== false;
          latestInDoc.esiEnabled = isHourly ? false : employee.esiEnabled !== false;
          latestInDoc.ptEnabled = isHourly ? false : employee.ptEnabled !== false;
          latestInDoc.lwfEnabled = isHourly ? false : employee.lwfEnabled !== false;
          latestInDoc.gratuityEnabled = isHourly ? false : employee.gratuityEnabled !== false;
          latestInDoc.includePfInCTC = isHourly ? false : employee.includePfInCTC === true;
          latestInDoc.includeGratuityInCTC = isHourly ? false : employee.includeGratuityInCTC !== false;
          latestInDoc.basicPercent = isHourly ? null : employee.basicPercent;
          latestInDoc.hraPercent = isHourly ? null : employee.hraPercent;
          latestInDoc.joiningBonus = isHourly ? 0 : (Number(employee.joiningBonus) || 0);
          latestInDoc.flexiAmount = isHourly ? 0 : (Number(employee.flexiAmount) || 0);
          latestInDoc.broadband = isHourly ? 0 : (Number(employee.broadband) || 0);
          latestInDoc.petrol = isHourly ? 0 : (Number(employee.petrol) || 0);
          latestInDoc.lta = isHourly ? 0 : (Number(employee.lta) || 0);
          latestInDoc.employerNPS = isHourly ? 0 : (Number(employee.employerNPS) || 0);
          latestInDoc.insuranceAmount = isHourly ? 0 : (Number(employee.insuranceAmount) || 0);
          latestInDoc.deductions = {
            tds: employee.deductions?.tds || 0,
            professionalTax: isHourly ? 0 : (employee.deductions?.professionalTax || 0),
            otherDeductions: isHourly ? [] : (employee.deductions?.otherDeductions || []),
          };
          latestInDoc.salaryStructure = {
            conveyance: isHourly ? 0 : (Number(employee.salaryStructure?.conveyance) || 0),
            medicalAllowance: isHourly ? 0 : (Number(employee.salaryStructure?.medicalAllowance) || 0),
            otherAllowances: isHourly ? [] : (employee.salaryStructure?.otherAllowances || []),
          };
        }
      }
    }

    const newRevisionObj = {
      effectiveDate,
      previousCTC: isHourly ? 0 : previousCTC,
      newCTC: isHourly ? 0 : newCTC,
      previousHourlyRate: isHourly ? previousHourlyRate : undefined,
      newHourlyRate: isHourly ? newHourlyRate : undefined,
      reason: req.body.reason || '',
      revisedBy: req.user?.email || req.user?.username || String(req.user?._id || ''),
      role: revisedRole,
      useSalaryComponents: isHourly ? false : nextPayload.useSalaryComponents,
      employmentType: isHourly ? 'contract' : nextPayload.employmentType,
      compensationModel: req.body.compensationModel || employee.compensationModel || 'SALARIED',
      paymentBasis: req.body.paymentBasis || employee.paymentBasis || 'MONTHLY',
      rateCard: req.body.rateCard !== undefined ? req.body.rateCard : employee.rateCard,

      monthlyCTC: isHourly ? 0 : newCTC,
      hourlyRate: isHourly ? newHourlyRate : 0,
      pfEnabled: isHourly ? false : nextPayload.pfEnabled,
      tdsEnabled: nextPayload.tdsEnabled !== false,
      esiEnabled: isHourly ? false : nextPayload.esiEnabled,
      ptEnabled: isHourly ? false : nextPayload.ptEnabled,
      lwfEnabled: isHourly ? false : nextPayload.lwfEnabled,
      gratuityEnabled: isHourly ? false : nextPayload.gratuityEnabled,
      includePfInCTC: isHourly ? false : nextPayload.includePfInCTC,
      includeGratuityInCTC: isHourly ? false : nextPayload.includeGratuityInCTC,
      basicPercent: isHourly ? null : nextPayload.basicPercent,
      hraPercent: isHourly ? null : nextPayload.hraPercent,
      joiningBonus: isHourly ? 0 : nextPayload.joiningBonus,
      flexiAmount: isHourly ? 0 : nextPayload.flexiAmount,
      broadband: isHourly ? 0 : nextPayload.broadband,
      petrol: isHourly ? 0 : nextPayload.petrol,
      lta: isHourly ? 0 : nextPayload.lta,
      employerNPS: isHourly ? 0 : nextPayload.employerNPS,
      insuranceAmount: isHourly ? 0 : nextPayload.insuranceAmount,
      deductions: nextPayload.deductions,
      salaryStructure: {
        conveyance: nextPayload.salaryStructure?.conveyance || 0,
        medicalAllowance: nextPayload.salaryStructure?.medicalAllowance || 0,
        otherAllowances: nextPayload.salaryStructure?.otherAllowances || [],
      },
    };

    // Copy any custom percentage overrides from nextPayload to newRevisionObj
    Object.keys(nextPayload).forEach(key => {
      if (key.endsWith('Percent') && !['basicPercent', 'hraPercent'].includes(key)) {
        newRevisionObj[key] = nextPayload[key];
      }
    });

    employee.salaryRevisions.push(newRevisionObj);

    employee.monthlyCTC = isHourly ? 0 : newCTC;
    employee.hourlyRate = isHourly ? newHourlyRate : 0;
    employee.role = revisedRole;
    employee.useSalaryComponents = isHourly ? false : nextPayload.useSalaryComponents;
    employee.employmentType = isHourly ? 'contract' : nextPayload.employmentType;
    employee.compensationModel = req.body.compensationModel || employee.compensationModel || 'SALARIED';
    employee.paymentBasis = req.body.paymentBasis || employee.paymentBasis || 'MONTHLY';
    if (req.body.rateCard !== undefined) {
      employee.rateCard = req.body.rateCard;
    }
    employee.pfEnabled = isHourly ? false : nextPayload.pfEnabled;
    employee.tdsEnabled = nextPayload.tdsEnabled !== false;
    employee.esiEnabled = isHourly ? false : nextPayload.esiEnabled;
    employee.ptEnabled = isHourly ? false : nextPayload.ptEnabled;
    employee.lwfEnabled = isHourly ? false : nextPayload.lwfEnabled;
    employee.gratuityEnabled = isHourly ? false : nextPayload.gratuityEnabled;
    employee.includePfInCTC = isHourly ? false : nextPayload.includePfInCTC;
    employee.includeGratuityInCTC = isHourly ? false : nextPayload.includeGratuityInCTC;
    employee.basicPercent = isHourly ? null : nextPayload.basicPercent;
    employee.hraPercent = isHourly ? null : nextPayload.hraPercent;
    employee.joiningBonus = isHourly ? 0 : nextPayload.joiningBonus;
    employee.flexiAmount = isHourly ? 0 : nextPayload.flexiAmount;
    employee.broadband = isHourly ? 0 : nextPayload.broadband;
    employee.petrol = isHourly ? 0 : nextPayload.petrol;
    employee.lta = isHourly ? 0 : nextPayload.lta;
    employee.employerNPS = isHourly ? 0 : nextPayload.employerNPS;
    employee.insuranceAmount = isHourly ? 0 : nextPayload.insuranceAmount;
    employee.deductions = nextPayload.deductions;
    employee.salaryStructure = salaryStructure;

    // Copy any custom percentage overrides to employee document
    Object.keys(nextPayload).forEach(key => {
      if (key.endsWith('Percent') && !['basicPercent', 'hraPercent'].includes(key)) {
        employee.set(key, nextPayload[key]);
      }
    });

    await employee.save();

    // Retroactive Salary Revision Arrears Calculation Step
    try {
      const closedPayrolls = await Payroll.find({
        employee: employee._id,
        user: req.user._id,
        status: 'paid'
      }).sort({ year: 1, month: 1 });

      const revDate = new Date(effectiveDate);
      const affectedPayrolls = closedPayrolls.filter(p => {
        const pDate = new Date(p.year, p.month - 1, 1);
        const rDate = new Date(revDate.getFullYear(), revDate.getMonth(), 1);
        return pDate >= rDate;
      });

      if (affectedPayrolls.length > 0) {
        let totalArrears = 0;
        for (const p of affectedPayrolls) {
          const recalcSnapshot = buildPayrollSnapshot(nextPayload, config, { paidDays: p.paidDays }, {}, p.month, p.year);
          const diff = roundAmount((recalcSnapshot.netSalary || 0) - (p.netSalary || 0));
          if (diff > 0) {
            totalArrears += diff;
          }
        }
        if (totalArrears > 0) {
          const PayrollVariableTransaction = mongoose.model('PayrollVariableTransaction');
          const now = new Date();
          const nextMonth = now.getUTCMonth() + 1;
          const nextYear = now.getUTCFullYear();
          await PayrollVariableTransaction.create({
            user: req.user._id,
            employee: employee._id,
            month: nextMonth,
            year: nextYear,
            paymentType: 'ARREARS',
            amount: roundAmount(totalArrears),
            reference: `Arrears for salary revision effective ${revDate.toISOString().slice(0, 10)}`,
            status: 'approved',
            remarks: `Auto-computed arrears for ${affectedPayrolls.length} closed payroll cycle(s)`,
          });
        }
      }
    } catch (arrErr) {
      console.error('Error calculating retroactive revision arrears:', arrErr);
    }

    res.json(employee);
  } catch (error) {
    console.error('Error adding salary revision:', error);
    res.status(500).json({ message: 'Server error updating salary revision' });
  }
};

exports.updateEmployeeDeclarations = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const { taxRegime, declarations } = req.body;

    const employee = await Employee.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: { taxRegime, declarations } },
      { returnDocument: 'after', runValidators: true }
    )
      .populate('department', 'name code')
      .select('+panNumber +uanNumber +aadharNumber +bankDetails.accountNumber');

    if (!employee) return res.status(404).json({ message: 'Employee not found' });
    res.json(employee);
  } catch (error) {
    console.error('Error updating declarations:', error);
    res.status(500).json({ message: 'Server error updating declarations' });
  }
};

exports.updateSalaryRevision = async (req, res) => {
  try {
    const { id, revisionId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(id)) || !mongoose.Types.ObjectId.isValid(String(revisionId))) {
      return res.status(404).json({ message: 'Invalid employee or revision ID' });
    }

    const employee = await Employee.findOne({ _id: id, user: req.user._id });
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    const revision = employee.salaryRevisions.id(revisionId);
    if (!revision) return res.status(404).json({ message: 'Salary revision not found' });

    const effectiveDate = parsePossibleDate(req.body.effectiveDate);
    const { resolveCompensationType, resolveStrategy } = require('../utils/payrollStrategies/index');
    // Resolve from explicit body field first, then employee's current value
    const effectiveCompType = req.body.compensationType || resolveCompensationType(employee);
    const strategy = resolveStrategy(effectiveCompType);
    const stratFlags = strategy.defaultStatutoryFlags();
    const isHourly = effectiveCompType === 'hourly';
    const skipFixedComponents = !strategy.usesSalaryComponents;
    let newCTC = Number(req.body.newCTC);
    let newHourlyRate = Number(req.body.newHourlyRate);

    if (isHourly) {
      if (!effectiveDate || !newHourlyRate || newHourlyRate < 0) {
        return res.status(400).json({ message: 'Effective date and new hourly rate are required' });
      }
      newCTC = 0;
    } else {
      if (!effectiveDate || (newCTC === undefined || newCTC === null || newCTC < 0)) {
        return res.status(400).json({ message: 'Effective date and new monthly CTC are required' });
      }
    }

    const valError = validateCompensationTypePayload(effectiveCompType, {
      monthlyCTC: newCTC,
      hourlyRate: newHourlyRate,
      dailyRate: req.body.dailyRate,
      rateCard: req.body.rateCard !== undefined ? req.body.rateCard : (revision.rateCard || employee.rateCard),
    });
    if (valError) {
      return res.status(400).json({ message: valError });
    }

    const config = await getOrCreateConfig(req.user._id);

    let revisedRole = employee.role;
    let roleDoc = null;
    if (req.body.role !== undefined) {
      const roleId = req.body.role;
      if (roleId) {
        if (!mongoose.Types.ObjectId.isValid(String(roleId))) {
          return res.status(400).json({ message: 'Invalid Role ID format' });
        }
        const Role = mongoose.model('Role');
        roleDoc = await Role.findOne({ _id: roleId, user: req.user._id });
        if (!roleDoc) {
          return res.status(400).json({ message: 'Job Role Template not found' });
        }
        revisedRole = roleDoc._id;
      } else {
        revisedRole = null;
      }
    }

    const getVal = (field) => {
      if (req.body[field] !== undefined) return req.body[field];
      if (roleDoc && roleDoc[field] !== undefined && roleDoc[field] !== null) return roleDoc[field];
      return revision[field] !== undefined ? revision[field] : employee[field];
    };

    const nextPayload = {
      ...employee.toObject(),
      role: revisedRole,
      monthlyCTC: isHourly ? 0 : newCTC,
      hourlyRate: isHourly ? newHourlyRate : 0,
      useSalaryComponents: skipFixedComponents ? false : getVal('useSalaryComponents'),
      employmentType: isHourly ? 'contract' : getVal('employmentType'),
      compensationModel: getVal('compensationModel'),
      paymentBasis: getVal('paymentBasis'),
      rateCard: req.body.rateCard !== undefined ? req.body.rateCard : (revision.rateCard || employee.rateCard),
      pfEnabled: req.body.pfEnabled !== undefined ? req.body.pfEnabled : (skipFixedComponents ? stratFlags.pfEligible : getVal('pfEnabled')),
      tdsEnabled: getVal('tdsEnabled') !== false,
      esiEnabled: req.body.esiEnabled !== undefined ? req.body.esiEnabled : (skipFixedComponents ? stratFlags.esiEligible : getVal('esiEnabled')),
      ptEnabled: req.body.ptEnabled !== undefined ? req.body.ptEnabled : (skipFixedComponents ? stratFlags.ptApplicable : getVal('ptEnabled')),
      lwfEnabled: req.body.lwfEnabled !== undefined ? req.body.lwfEnabled : (skipFixedComponents ? stratFlags.lwfApplicable : getVal('lwfEnabled')),
      gratuityEnabled: req.body.gratuityEnabled !== undefined ? req.body.gratuityEnabled : (skipFixedComponents ? stratFlags.gratuityEligible : getVal('gratuityEnabled')),
      includePfInCTC: skipFixedComponents ? false : getVal('includePfInCTC'),
      includeGratuityInCTC: skipFixedComponents ? false : getVal('includeGratuityInCTC'),
      basicPercent: skipFixedComponents ? null : getVal('basicPercent'),
      hraPercent: skipFixedComponents ? null : getVal('hraPercent'),
      joiningBonus: skipFixedComponents ? 0 : (req.body.joiningBonus !== undefined ? Number(req.body.joiningBonus) : (Number(revision.joiningBonus) || 0)),
      flexiAmount: skipFixedComponents ? 0 : (req.body.flexiAmount !== undefined ? Number(req.body.flexiAmount) : (Number(revision.flexiAmount) || 0)),
      broadband: skipFixedComponents ? 0 : (req.body.broadband !== undefined ? Number(req.body.broadband) : (Number(revision.broadband) || 0)),
      petrol: skipFixedComponents ? 0 : (req.body.petrol !== undefined ? Number(req.body.petrol) : (Number(revision.petrol) || 0)),
      lta: skipFixedComponents ? 0 : (req.body.lta !== undefined ? Number(req.body.lta) : (Number(revision.lta) || 0)),
      employerNPS: skipFixedComponents ? 0 : (req.body.employerNPS !== undefined ? Number(req.body.employerNPS) : (Number(revision.employerNPS) || 0)),
      insuranceAmount: skipFixedComponents ? 0 : (req.body.insuranceAmount !== undefined ? Number(req.body.insuranceAmount) : (Number(revision.insuranceAmount) || 0)),
      deductions: {
        ...(revision.deductions || {}),
        tds: req.body.tds !== undefined ? Number(req.body.tds) : (revision.deductions?.tds || 0),
        professionalTax: skipFixedComponents ? 0 : (req.body.professionalTax !== undefined ? Number(req.body.professionalTax) : (revision.deductions?.professionalTax || 0)),
        otherDeductions: isHourly ? [] : (req.body.otherDeductions !== undefined ? req.body.otherDeductions : (revision.deductions?.otherDeductions || [])),
      },
      salaryStructure: {
        conveyance: skipFixedComponents ? 0 : (req.body.conveyance !== undefined ? Number(req.body.conveyance) : (Number(revision.salaryStructure?.conveyance) || 0)),
        medicalAllowance: skipFixedComponents ? 0 : (req.body.medicalAllowance !== undefined ? Number(req.body.medicalAllowance) : (Number(revision.salaryStructure?.medicalAllowance) || 0)),
        otherAllowances: skipFixedComponents ? [] : (req.body.otherAllowances !== undefined ? req.body.otherAllowances : (revision.salaryStructure?.otherAllowances || [])),
        ...(req.body.basic !== undefined && { basic: Number(req.body.basic) }),
        ...(req.body.hra !== undefined && { hra: Number(req.body.hra) }),
      },
    };

    // Copy any custom percentage overrides from req.body to nextPayload
    Object.keys(req.body).forEach(key => {
      if (key.endsWith('Percent') && !['basicPercent', 'hraPercent'].includes(key)) {
        nextPayload[key] = req.body[key] === null || req.body[key] === '' ? null : Number(req.body[key]);
      }
    });

    const salaryStructure = buildSalaryStructureFromCTC(nextPayload, config);

    // Update revision fields
    revision.effectiveDate = effectiveDate;
    revision.newCTC = isHourly ? 0 : newCTC;
    revision.newHourlyRate = isHourly ? newHourlyRate : undefined;
    revision.reason = req.body.reason || '';
    revision.role = revisedRole;
    revision.compensationType = effectiveCompType;
    revision.attendanceMode = req.body.attendanceMode || employee.attendanceMode || 'attendance';
    revision.payFrequency = req.body.payFrequency || employee.payFrequency || 'monthly';
    revision.useSalaryComponents = stratFlags.pfEligible ? nextPayload.useSalaryComponents : false;
    revision.employmentType = nextPayload.employmentType;
    revision.compensationModel = nextPayload.compensationModel;
    revision.paymentBasis = nextPayload.paymentBasis;
    if (req.body.rateCard !== undefined) {
      revision.rateCard = req.body.rateCard;
    }
    revision.monthlyCTC = isHourly ? 0 : newCTC;
    revision.hourlyRate = isHourly ? newHourlyRate : 0;
    revision.pfEnabled = stratFlags.pfEligible ? nextPayload.pfEnabled : false;
    revision.tdsEnabled = nextPayload.tdsEnabled !== false;
    revision.esiEnabled = stratFlags.esiEligible ? nextPayload.esiEnabled : false;
    revision.ptEnabled = stratFlags.ptApplicable ? nextPayload.ptEnabled : false;
    revision.lwfEnabled = stratFlags.lwfApplicable ? nextPayload.lwfEnabled : false;
    revision.gratuityEnabled = stratFlags.gratuityEligible ? nextPayload.gratuityEnabled : false;
    revision.includePfInCTC = stratFlags.pfEligible ? nextPayload.includePfInCTC : false;
    revision.includeGratuityInCTC = stratFlags.gratuityEligible ? nextPayload.includeGratuityInCTC : false;
    revision.basicPercent = stratFlags.pfEligible ? nextPayload.basicPercent : null;
    revision.hraPercent = stratFlags.pfEligible ? nextPayload.hraPercent : null;
    revision.joiningBonus = stratFlags.pfEligible ? nextPayload.joiningBonus : 0;
    revision.flexiAmount = stratFlags.pfEligible ? nextPayload.flexiAmount : 0;
    revision.broadband = stratFlags.pfEligible ? nextPayload.broadband : 0;
    revision.petrol = stratFlags.pfEligible ? nextPayload.petrol : 0;
    revision.lta = stratFlags.pfEligible ? nextPayload.lta : 0;
    revision.employerNPS = stratFlags.pfEligible ? nextPayload.employerNPS : 0;
    revision.insuranceAmount = stratFlags.pfEligible ? nextPayload.insuranceAmount : 0;
    revision.deductions = nextPayload.deductions;
    revision.salaryStructure = {
      conveyance: nextPayload.salaryStructure?.conveyance || 0,
      medicalAllowance: nextPayload.salaryStructure?.medicalAllowance || 0,
      otherAllowances: nextPayload.salaryStructure?.otherAllowances || [],
    };

    // Copy any custom percentage overrides from nextPayload to revision
    Object.keys(nextPayload).forEach(key => {
      if (key.endsWith('Percent') && !['basicPercent', 'hraPercent'].includes(key)) {
        revision.set(key, nextPayload[key]);
      }
    });

    // Sort revisions to find the latest one
    const sorted = [...employee.salaryRevisions].sort((a, b) => new Date(a.effectiveDate) - new Date(b.effectiveDate));
    const latest = sorted[sorted.length - 1];

    // If we just edited the latest revision, sync employee's active salary settings
    if (String(latest._id) === String(revisionId)) {
      employee.monthlyCTC = isHourly ? 0 : newCTC;
      employee.hourlyRate = isHourly ? newHourlyRate : 0;
      employee.role = revisedRole;
      employee.compensationType = effectiveCompType;
      employee.attendanceMode = req.body.attendanceMode || employee.attendanceMode;
      employee.payFrequency = req.body.payFrequency || employee.payFrequency;
      employee.useSalaryComponents = stratFlags.pfEligible ? nextPayload.useSalaryComponents : false;
      employee.employmentType = nextPayload.employmentType;
      employee.compensationModel = nextPayload.compensationModel;
      employee.paymentBasis = nextPayload.paymentBasis;
      if (req.body.rateCard !== undefined) {
        employee.rateCard = req.body.rateCard;
      }
      employee.pfEnabled = stratFlags.pfEligible ? nextPayload.pfEnabled : false;
      employee.tdsEnabled = nextPayload.tdsEnabled !== false;
      employee.esiEnabled = stratFlags.esiEligible ? nextPayload.esiEnabled : false;
      employee.ptEnabled = stratFlags.ptApplicable ? nextPayload.ptEnabled : false;
      employee.lwfEnabled = stratFlags.lwfApplicable ? nextPayload.lwfEnabled : false;
      employee.gratuityEnabled = stratFlags.gratuityEligible ? nextPayload.gratuityEnabled : false;
      employee.includePfInCTC = stratFlags.pfEligible ? nextPayload.includePfInCTC : false;
      employee.includeGratuityInCTC = stratFlags.gratuityEligible ? nextPayload.includeGratuityInCTC : false;
      employee.basicPercent = stratFlags.pfEligible ? nextPayload.basicPercent : null;
      employee.hraPercent = stratFlags.pfEligible ? nextPayload.hraPercent : null;
      employee.joiningBonus = stratFlags.pfEligible ? nextPayload.joiningBonus : 0;
      employee.flexiAmount = stratFlags.pfEligible ? nextPayload.flexiAmount : 0;
      employee.broadband = stratFlags.pfEligible ? nextPayload.broadband : 0;
      employee.petrol = stratFlags.pfEligible ? nextPayload.petrol : 0;
      employee.lta = stratFlags.pfEligible ? nextPayload.lta : 0;
      employee.employerNPS = stratFlags.pfEligible ? nextPayload.employerNPS : 0;
      employee.insuranceAmount = stratFlags.pfEligible ? nextPayload.insuranceAmount : 0;
      employee.deductions = nextPayload.deductions;
      employee.salaryStructure = salaryStructure;

      // Copy any custom percentage overrides to employee document
      Object.keys(nextPayload).forEach(key => {
        if (key.endsWith('Percent') && !['basicPercent', 'hraPercent'].includes(key)) {
          employee.set(key, nextPayload[key]);
        }
      });
    }

    await employee.save();
    res.json(employee);
  } catch (error) {
    console.error('Error updating salary revision:', error);
    res.status(500).json({ message: 'Server error updating salary revision' });
  }
};

exports.deleteSalaryRevision = async (req, res) => {
  try {
    const { id, revisionId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(id)) || !mongoose.Types.ObjectId.isValid(String(revisionId))) {
      return res.status(404).json({ message: 'Invalid employee or revision ID' });
    }

    const employee = await Employee.findOne({ _id: id, user: req.user._id });
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    const revision = employee.salaryRevisions.id(revisionId);
    if (!revision) return res.status(404).json({ message: 'Salary revision not found' });

    // Determine if we are deleting the latest revision
    const sortedBefore = [...employee.salaryRevisions].sort((a, b) => new Date(a.effectiveDate) - new Date(b.effectiveDate));
    const latestBefore = sortedBefore[sortedBefore.length - 1];

    employee.salaryRevisions.pull(revisionId);

    // If we are deleting the latest revision, sync employee's active salary settings with the previous one
    if (String(latestBefore._id) === String(revisionId)) {
      const sortedAfter = [...employee.salaryRevisions].sort((a, b) => new Date(a.effectiveDate) - new Date(b.effectiveDate));
      if (sortedAfter.length > 0) {
        const newLatest = sortedAfter[sortedAfter.length - 1];
        
        employee.monthlyCTC = newLatest.monthlyCTC || 0;
        employee.hourlyRate = newLatest.hourlyRate || 0;
        employee.role = newLatest.role || null;
        employee.useSalaryComponents = newLatest.useSalaryComponents !== false;
        employee.employmentType = newLatest.employmentType || 'full-time';
        employee.pfEnabled = newLatest.pfEnabled !== false;
        employee.tdsEnabled = newLatest.tdsEnabled !== false;
        employee.esiEnabled = newLatest.esiEnabled !== false;
        employee.ptEnabled = newLatest.ptEnabled !== false;
        employee.lwfEnabled = newLatest.lwfEnabled !== false;
        employee.gratuityEnabled = newLatest.gratuityEnabled !== false;
        employee.includePfInCTC = newLatest.includePfInCTC === true;
        employee.includeGratuityInCTC = newLatest.includeGratuityInCTC !== false;
        employee.basicPercent = newLatest.basicPercent;
        employee.hraPercent = newLatest.hraPercent;
        employee.joiningBonus = newLatest.joiningBonus || 0;
        employee.flexiAmount = newLatest.flexiAmount || 0;
        employee.broadband = newLatest.broadband || 0;
        employee.petrol = newLatest.petrol || 0;
        employee.lta = newLatest.lta || 0;
        employee.employerNPS = newLatest.employerNPS || 0;
        employee.insuranceAmount = newLatest.insuranceAmount || 0;
        employee.deductions = {
          pf: newLatest.deductions?.pf || 0,
          esi: newLatest.deductions?.esi || 0,
          professionalTax: newLatest.deductions?.professionalTax || 0,
          tds: newLatest.deductions?.tds || 0,
          otherDeductions: newLatest.deductions?.otherDeductions || [],
        };
        employee.salaryStructure = {
          basic: newLatest.salaryStructure?.basic || 0,
          hra: newLatest.salaryStructure?.hra || 0,
          conveyance: newLatest.salaryStructure?.conveyance || 0,
          medicalAllowance: newLatest.salaryStructure?.medicalAllowance || 0,
          specialAllowance: newLatest.salaryStructure?.specialAllowance || 0,
          otherAllowances: newLatest.salaryStructure?.otherAllowances || [],
        };

        // Reset existing overrides to null first
        Object.keys(employee.toObject ? employee.toObject() : employee).forEach(key => {
          if (key.endsWith('Percent') && !['basicPercent', 'hraPercent'].includes(key)) {
            employee.set(key, null);
          }
        });

        // Copy custom percentage overrides from newLatest to employee
        const newLatestObj = newLatest.toObject ? newLatest.toObject() : newLatest;
        Object.keys(newLatestObj).forEach(key => {
          if (key.endsWith('Percent') && !['basicPercent', 'hraPercent'].includes(key)) {
            employee.set(key, newLatestObj[key]);
          }
        });
      }
    }

    await employee.save();
    res.json(employee);
  } catch (error) {
    console.error('Error deleting salary revision:', error);
    res.status(500).json({ message: 'Server error deleting salary revision' });
  }
};

exports.validateCompensationTypePayload = validateCompensationTypePayload;

exports.bulkSalaryRevision = async (req, res) => {
  try {
    const ALLOWED_ROLES = ['admin', 'owner', 'superadmin', 'hr_admin', 'payroll_admin'];
    if (req.user?.role && !ALLOWED_ROLES.includes(String(req.user.role).toLowerCase())) {
      return res.status(403).json({ message: 'Access denied: Admin or HR Owner privilege required for bulk salary revisions' });
    }

    const { effectiveDate, incrementType, incrementValue, department, designation, employeeIds, revisions, reason, preview, previewOnly } = req.body;
    const isPreview = Boolean(preview || previewOnly);
    const parsedDate = parsePossibleDate(effectiveDate);
    if (!parsedDate) {
      return res.status(400).json({ message: 'Valid effectiveDate is required' });
    }

    const config = await getOrCreateConfig(req.user._id);

    let targetEmployees = [];
    if (Array.isArray(revisions) && revisions.length > 0) {
      const ids = revisions.map(r => r.employeeId).filter(id => mongoose.Types.ObjectId.isValid(String(id)));
      targetEmployees = await Employee.find({ _id: { $in: ids }, user: req.user._id });
    } else {
      const filter = { user: req.user._id, status: { $ne: 'terminated' } };
      if (department && mongoose.Types.ObjectId.isValid(String(department))) {
        filter.department = department;
      }
      if (designation) {
        filter.designation = designation;
      }
      if (Array.isArray(employeeIds) && employeeIds.length > 0) {
        const ids = employeeIds.filter(id => mongoose.Types.ObjectId.isValid(String(id)));
        filter._id = { $in: ids };
      }
      targetEmployees = await Employee.find(filter);
    }

    if (targetEmployees.length === 0) {
      return res.status(404).json({ message: 'No eligible employees found for bulk salary revision' });
    }

    const success = [];
    const errors = [];

    const revisionsMap = new Map();
    if (Array.isArray(revisions)) {
      revisions.forEach(r => revisionsMap.set(String(r.employeeId), r));
    }

    const { resolveStrategy, resolveCompensationType } = require('../utils/payrollStrategies/index');

    for (const employee of targetEmployees) {
      const employeeName = `${employee.firstName} ${employee.lastName}`;
      try {
        const itemOverride = revisionsMap.get(String(employee._id)) || {};
        const effectiveCompType = resolveCompensationType(itemOverride.compensationType ? itemOverride : employee);
        const strategyMeta = resolveStrategy(effectiveCompType);
        const isHourly = effectiveCompType === 'hourly';
        const skipFixedComponents = !strategyMeta.usesSalaryComponents;

        const previousCTC = Number(employee.monthlyCTC) || Number(employee.salaryStructure?.ctc) || 0;
        const previousHourlyRate = Number(employee.hourlyRate) || 0;
        const previousDailyRate = Number(employee.dailyRate) || 0;

        let newCTC = Number(itemOverride.newCTC !== undefined ? itemOverride.newCTC : previousCTC);
        let newHourlyRate = Number(itemOverride.newHourlyRate !== undefined ? itemOverride.newHourlyRate : previousHourlyRate);
        let newDailyRate = Number(itemOverride.dailyRate !== undefined ? itemOverride.dailyRate : previousDailyRate);

        if (incrementType && incrementValue !== undefined) {
          const incVal = Number(incrementValue) || 0;
          if (incrementType === 'percentage') {
            if (isHourly) {
              newHourlyRate = Math.round((newHourlyRate * (1 + incVal / 100)) * 100) / 100;
            } else if (effectiveCompType === 'daily_wage') {
              newDailyRate = Math.round((newDailyRate * (1 + incVal / 100)) * 100) / 100;
            } else {
              newCTC = Math.round((newCTC * (1 + incVal / 100)) * 100) / 100;
            }
          } else if (incrementType === 'flat_amount') {
            if (isHourly) {
              newHourlyRate = Math.round((newHourlyRate + incVal) * 100) / 100;
            } else if (effectiveCompType === 'daily_wage') {
              newDailyRate = Math.round((newDailyRate + incVal) * 100) / 100;
            } else {
              newCTC = Math.round((newCTC + incVal) * 100) / 100;
            }
          }
        }

        const valError = validateCompensationTypePayload(effectiveCompType, {
          monthlyCTC: newCTC,
          hourlyRate: newHourlyRate,
          dailyRate: newDailyRate,
          rateCard: itemOverride.rateCard !== undefined ? itemOverride.rateCard : employee.rateCard,
        });

        if (isPreview) {
          success.push({
            employeeId: employee._id,
            employeeCode: employee.employeeId,
            employeeName,
            compensationType: effectiveCompType,
            previousCTC,
            newCTC: isHourly ? 0 : newCTC,
            previousHourlyRate,
            newHourlyRate: isHourly ? newHourlyRate : 0,
            previousDailyRate,
            newDailyRate: effectiveCompType === 'daily_wage' ? newDailyRate : previousDailyRate,
            validationError: valError || null,
            effectiveDate: parsedDate,
          });
          continue;
        }

        if (valError) throw new Error(valError);

        const nextPayload = {
          ...employee.toObject(),
          monthlyCTC: isHourly ? 0 : newCTC,
          hourlyRate: isHourly ? newHourlyRate : 0,
          dailyRate: effectiveCompType === 'daily_wage' ? newDailyRate : employee.dailyRate,
          useSalaryComponents: skipFixedComponents ? false : employee.useSalaryComponents,
        };

        const salaryStructure = buildSalaryStructureFromCTC(nextPayload, config);

        if (!employee.salaryRevisions) {
          employee.salaryRevisions = [];
        }
        if (employee.salaryRevisions.length === 0) {
          employee.salaryRevisions.push({
            effectiveDate: employee.joiningDate || new Date(0),
            previousCTC: 0,
            newCTC: isHourly ? 0 : previousCTC,
            previousHourlyRate: isHourly ? 0 : undefined,
            newHourlyRate: isHourly ? previousHourlyRate : undefined,
            hourlyRate: isHourly ? previousHourlyRate : undefined,
            reason: 'Initial Salary Setup',
            revisedBy: 'System',
            createdAt: employee.createdAt || new Date(),
          });
        }

        employee.salaryRevisions.push({
          effectiveDate: parsedDate,
          previousCTC,
          newCTC: isHourly ? 0 : newCTC,
          previousHourlyRate,
          newHourlyRate: isHourly ? newHourlyRate : 0,
          basic: salaryStructure.basic,
          hra: salaryStructure.hra,
          specialAllowance: salaryStructure.specialAllowance,
          grossSalary: salaryStructure.grossSalary,
          ctc: isHourly ? 0 : newCTC,
          reason: reason || 'Bulk Annual Salary Increment',
          revisedBy: req.user.name || req.user.email || 'Admin',
          createdAt: new Date(),
        });

        employee.monthlyCTC = isHourly ? 0 : newCTC;
        employee.hourlyRate = isHourly ? newHourlyRate : 0;
        employee.dailyRate = effectiveCompType === 'daily_wage' ? newDailyRate : employee.dailyRate;
        employee.salaryStructure = salaryStructure;

        await employee.save();

        success.push({
          employeeId: employee._id,
          employeeCode: employee.employeeId,
          employeeName,
          compensationType: effectiveCompType,
          previousCTC,
          newCTC: isHourly ? 0 : newCTC,
          previousHourlyRate,
          newHourlyRate: isHourly ? newHourlyRate : 0,
          previousDailyRate,
          newDailyRate: effectiveCompType === 'daily_wage' ? newDailyRate : employee.dailyRate,
          effectiveDate: parsedDate,
        });
      } catch (err) {
        console.error(`Error in bulk salary revision for employee ${employee._id}:`, err);
        errors.push({
          employeeId: employee._id,
          employeeName,
          error: err.message || 'Failed to process salary revision'
        });
      }
    }

    if (isPreview) {
      return res.json({ preview: success, errors });
    }

    res.json({
      message: `Bulk salary revision completed for ${success.length} employee(s)`,
      success,
      errors,
    });
  } catch (error) {
    console.error('Error processing bulk salary revision:', error);
    res.status(500).json({ message: 'Server error processing bulk salary revision' });
  }
};

