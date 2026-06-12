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
  'DESIGNATION', 'ROLE',
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
  'OTHER EXEMPTIONS'
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
      { id: 'special',                  name: 'Special Allowance',             type: 'earning',   taxable: true,  linkedTo: 'remainder',     linkValue: 0,             frequency: 'monthly' },
      { id: 'flexi',                    name: 'Flexi Allowance',               type: 'earning',   taxable: false, linkedTo: 'fixed',         linkValue: 0,             frequency: 'monthly' },
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
  columns.push({ header: 'Designation', group: 'Employment Details', key: 'designation', sample: 'Software Engineer' });
  columns.push({ header: 'Department', group: 'Employment Details', key: 'department', sample: 'Engineering', getValue: (employee) => {
    if (!employee?.department) return '';
    if (typeof employee.department === 'string') return employee.department;
    return employee.department.name || '';
  }});
  columns.push({ header: 'Employment Type', group: 'Employment Details', key: 'employmentType', sample: 'full-time' });
  columns.push({ header: 'Status', group: 'Employment Details', key: 'status', sample: 'active' });

  // Group: Statutory Toggles
  columns.push({ header: 'Tax Regime', group: 'Statutory Toggles', key: 'taxRegime', sample: 'new' });
  columns.push({ header: 'PF Enabled', group: 'Statutory Toggles', key: 'pfEnabled', sample: 'No' });
  columns.push({ header: 'ESI Enabled', group: 'Statutory Toggles', key: 'esiEnabled', sample: 'No' });
  columns.push({ header: 'PT Enabled', group: 'Statutory Toggles', key: 'ptEnabled', sample: 'No' });
  columns.push({ header: 'LWF Enabled', group: 'Statutory Toggles', key: 'lwfEnabled', sample: 'No' });
  columns.push({ header: 'Gratuity Enabled', group: 'Statutory Toggles', key: 'gratuityEnabled', sample: 'No' });
  columns.push({ header: 'Include PF in CTC', group: 'Statutory Toggles', key: 'includePfInCTC', sample: 'No' });
  columns.push({ header: 'Include Gratuity in CTC', group: 'Statutory Toggles', key: 'includeGratuityInCTC', sample: 'No' });

  // Helper to find dynamic column letters
  const getColLetter = (k) => {
    const idx = columns.findIndex(c => c.key === k);
    return idx !== -1 ? XLSX.utils.encode_col(idx) : '';
  };

  // Group: Salary Details
  columns.push({
    header: 'Annual CTC',
    group: 'Salary Details',
    key: 'annualCTC',
    isSummable: true,
    sample: 600000,
    getValue: (employee, rNum, mode) => {
      if (mode === 'template') return 600000;
      return Number(employee?.monthlyCTC || 0) * 12;
    }
  });

  columns.push({
    header: 'Monthly CTC',
    group: 'Salary Details',
    key: 'monthlyCTC',
    isSummable: true,
    sample: 50000,
    getValue: (employee, rNum, mode) => {
      const annualCtcL = getColLetter('annualCTC');
      const f = `${annualCtcL}${rNum} / 12`;
      if (mode === 'template') return { f };
      return { f, v: Number(employee?.monthlyCTC || 0) };
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
        const f = `ROUND(${ctcL}${rNum} * IF(${basicPctL}${rNum}<>"", ${basicPctL}${rNum}/100, ${basicDef}), 2)`;
        if (mode === 'template') return { f };
        return { f, v: Number(employee?.salaryStructure?.basic) || 0 };
      };
    } else if (c.id === 'hra') {
      colDef.getValue = (employee, rNum, mode) => {
        const basicL = getColLetter('basic');
        const hraPctL = getColLetter('hraPercent');
        const f = `ROUND(${basicL}${rNum} * IF(${hraPctL}${rNum}<>"", ${hraPctL}${rNum}/100, ${hraDef}), 2)`;
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
      .select('employeeId firstName lastName email designation department salaryStructure deductions monthlyCTC flexiAmount broadband petrol lta employerNPS insuranceAmount joiningBonus joiningDate location dateOfLeaving pfEnabled esiEnabled ptEnabled lwfEnabled gratuityEnabled includePfInCTC includeGratuityInCTC basicPercent hraPercent salaryRevisions')
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
      await Expense.deleteMany({ user: req.user._id, _id: { $in: expenseIds } });
    }

    // 2. Delete payroll records
    await Payroll.deleteMany({ user: req.user._id, employee: employeeId });

    // 3. Delete loans
    await Loan.deleteMany({ user: req.user._id, employee: employeeId });

    // 4. Delete reimbursement claims
    await ReimbursementClaim.deleteMany({ user: req.user._id, employee: employeeId });

    // 5. Pull employee from project teams
    await Project.updateMany(
      { user: req.user._id, team: employeeId },
      { $pull: { team: employeeId } }
    );

    // 6. Delete the employee profile itself
    await Employee.findOneAndDelete({ _id: employeeId, user: req.user._id });

    res.json({ message: 'Employee and all associated payrolls, expenses, loans, and claims deleted successfully' });
  } catch (error) {
    console.error('Error deleting employee:', error);
    res.status(500).json({ message: 'Server error deleting employee' });
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
      const designation = String(getCellValue(rawRow, ['DESIGNATION', 'ROLE']) || '').trim();
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
      const esiEnabled = parseYesNo(getCellValue(rawRow, ['ESI ENABLED']));
      const ptEnabled = parseYesNo(getCellValue(rawRow, ['PT ENABLED']));
      const lwfEnabled = parseYesNo(getCellValue(rawRow, ['LWF ENABLED']));
      const gratuityEnabled = parseYesNo(getCellValue(rawRow, ['GRATUITY ENABLED']));
      const includePfInCTC = parseYesNo(getCellValue(rawRow, ['INCLUDE PF IN CTC']));
      const includeGratuityInCTC = parseYesNo(getCellValue(rawRow, ['INCLUDE GRATUITY IN CTC']));

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
      const departmentName = String(getCellValue(rawRow, ['DEPARTMENT', 'DEPT']) || '').trim();
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
        employmentType,
        status,
        monthlyCTC,
        flexiAmount,
        broadband,
        petrol,
        lta,
        employerNPS,
        insuranceAmount,
        joiningBonus,
        basicPercent,
        hraPercent,
        taxRegime,
        pfEnabled: pfEnabled !== undefined ? pfEnabled : true,
        esiEnabled: esiEnabled !== undefined ? esiEnabled : true,
        ptEnabled: ptEnabled !== undefined ? ptEnabled : true,
        lwfEnabled: lwfEnabled !== undefined ? lwfEnabled : true,
        gratuityEnabled: gratuityEnabled !== undefined ? gratuityEnabled : true,
        includePfInCTC: includePfInCTC !== undefined ? includePfInCTC : true,
        includeGratuityInCTC: includeGratuityInCTC !== undefined ? includeGratuityInCTC : true,
        address: {
          line1: addressLine1,
          line2: addressLine2,
          city,
          state,
          zip,
          country: country || 'India',
        },
        salaryStructure: {
          conveyance: 0,
          medicalAllowance: 0,
          otherAllowances: [],
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
        const created = await Employee.create(payload);
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
    const employees = await Employee.find({ user: req.user._id })
      .populate('department', 'name code')
      .select('+panNumber +aadharNumber +uanNumber +bankDetails.accountNumber')
      .sort({ createdAt: -1 })
      .lean();

    const config = await getOrCreateConfig(req.user._id);

    const standardKeys = new Set([
      '_id', 'user', 'employeeId', 'firstName', 'lastName', 'email', 'phone', 'dateOfBirth', 'gender',
      'address', 'designation', 'department', 'joiningDate', 'location', 'dateOfLeaving', 'employmentType',
      'status', 'monthlyCTC', 'flexiAmount', 'broadband', 'petrol', 'lta', 'employerNPS', 'insuranceAmount',
      'joiningBonus', 'basicPercent', 'hraPercent', 'pfEnabled', 'esiEnabled', 'ptEnabled', 'lwfEnabled',
      'gratuityEnabled', 'includePfInCTC', 'includeGratuityInCTC', 'salaryStructure', 'deductions',
      'bankDetails', 'panNumber', 'uanNumber', 'aadharNumber', 'taxRegime', 'declarations', 'documents',
      'salaryRevisions', 'createdAt', 'updatedAt', '__v'
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
        if (['pfEnabled', 'esiEnabled', 'ptEnabled', 'lwfEnabled', 'gratuityEnabled', 'includePfInCTC', 'includeGratuityInCTC'].includes(col.key)) {
          if (val === true || val === 'true') return 'Yes';
          if (val === false || val === 'false') return 'No';
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


exports.addSalaryRevision = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const employee = await Employee.findOne({ _id: req.params.id, user: req.user._id });
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    const effectiveDate = parsePossibleDate(req.body.effectiveDate);
    const newCTC = Number(req.body.newCTC);
    if (!effectiveDate || !newCTC || newCTC < 0) {
      return res.status(400).json({ message: 'Effective date and new monthly CTC are required' });
    }

    const config = await getOrCreateConfig(req.user._id);
    const previousCTC = Number(employee.monthlyCTC) || Number(employee.salaryStructure?.ctc) || 0;
    
    const getVal = (field) => req.body[field] !== undefined ? req.body[field] : employee[field];

    const nextPayload = {
      ...employee.toObject(),
      monthlyCTC: newCTC,
      pfEnabled: getVal('pfEnabled'),
      esiEnabled: getVal('esiEnabled'),
      ptEnabled: getVal('ptEnabled'),
      lwfEnabled: getVal('lwfEnabled'),
      gratuityEnabled: getVal('gratuityEnabled'),
      includePfInCTC: getVal('includePfInCTC'),
      includeGratuityInCTC: getVal('includeGratuityInCTC'),
      basicPercent: getVal('basicPercent'),
      hraPercent: getVal('hraPercent'),
      joiningBonus: req.body.joiningBonus !== undefined ? Number(req.body.joiningBonus) : (Number(employee.joiningBonus) || 0),
      flexiAmount: req.body.flexiAmount !== undefined ? Number(req.body.flexiAmount) : (Number(employee.flexiAmount) || 0),
      broadband: req.body.broadband !== undefined ? Number(req.body.broadband) : (Number(employee.broadband) || 0),
      petrol: req.body.petrol !== undefined ? Number(req.body.petrol) : (Number(employee.petrol) || 0),
      lta: req.body.lta !== undefined ? Number(req.body.lta) : (Number(employee.lta) || 0),
      employerNPS: req.body.employerNPS !== undefined ? Number(req.body.employerNPS) : (Number(employee.employerNPS) || 0),
      insuranceAmount: req.body.insuranceAmount !== undefined ? Number(req.body.insuranceAmount) : (Number(employee.insuranceAmount) || 0),
      deductions: {
        ...(employee.deductions || {}),
        tds: req.body.tds !== undefined ? Number(req.body.tds) : (employee.deductions?.tds || 0),
        professionalTax: req.body.professionalTax !== undefined ? Number(req.body.professionalTax) : (employee.deductions?.professionalTax || 0),
        otherDeductions: req.body.otherDeductions !== undefined ? req.body.otherDeductions : (employee.deductions?.otherDeductions || []),
      },
      salaryStructure: {
        conveyance: req.body.conveyance !== undefined ? Number(req.body.conveyance) : (Number(employee.salaryStructure?.conveyance) || 0),
        medicalAllowance: req.body.medicalAllowance !== undefined ? Number(req.body.medicalAllowance) : (Number(employee.salaryStructure?.medicalAllowance) || 0),
        otherAllowances: req.body.otherAllowances !== undefined ? req.body.otherAllowances : (employee.salaryStructure?.otherAllowances || []),
      },
    };
    
    const salaryStructure = buildSalaryStructureFromCTC(nextPayload, config);

    if (!employee.salaryRevisions || employee.salaryRevisions.length === 0) {
      employee.salaryRevisions.push({
        effectiveDate: employee.joiningDate || new Date(0),
        previousCTC: 0,
        newCTC: previousCTC,
        reason: 'Initial Salary Setup',
        revisedBy: 'System',
        createdAt: employee.createdAt || new Date(),
        
        monthlyCTC: previousCTC,
        pfEnabled: employee.pfEnabled !== false,
        esiEnabled: employee.esiEnabled !== false,
        ptEnabled: employee.ptEnabled !== false,
        lwfEnabled: employee.lwfEnabled !== false,
        gratuityEnabled: employee.gratuityEnabled !== false,
        includePfInCTC: employee.includePfInCTC !== false,
        includeGratuityInCTC: employee.includeGratuityInCTC !== false,
        basicPercent: employee.basicPercent,
        hraPercent: employee.hraPercent,
        joiningBonus: Number(employee.joiningBonus) || 0,
        flexiAmount: Number(employee.flexiAmount) || 0,
        broadband: Number(employee.broadband) || 0,
        petrol: Number(employee.petrol) || 0,
        lta: Number(employee.lta) || 0,
        employerNPS: Number(employee.employerNPS) || 0,
        insuranceAmount: Number(employee.insuranceAmount) || 0,
        deductions: {
          tds: employee.deductions?.tds || 0,
          professionalTax: employee.deductions?.professionalTax || 0,
          otherDeductions: employee.deductions?.otherDeductions || [],
        },
        salaryStructure: {
          conveyance: Number(employee.salaryStructure?.conveyance) || 0,
          medicalAllowance: Number(employee.salaryStructure?.medicalAllowance) || 0,
          otherAllowances: employee.salaryStructure?.otherAllowances || [],
        },
      });
    } else {
      const sortedRevs = [...employee.salaryRevisions].sort((a, b) => new Date(a.effectiveDate) - new Date(b.effectiveDate));
      const latestExisting = sortedRevs[sortedRevs.length - 1];
      const latestInDoc = employee.salaryRevisions.find(r => String(r._id) === String(latestExisting._id));
      if (latestInDoc) {
        if (latestInDoc.pfEnabled === undefined || latestInDoc.pfEnabled === null) {
          latestInDoc.monthlyCTC = Number(latestInDoc.newCTC) || previousCTC;
          latestInDoc.pfEnabled = employee.pfEnabled !== false;
          latestInDoc.esiEnabled = employee.esiEnabled !== false;
          latestInDoc.ptEnabled = employee.ptEnabled !== false;
          latestInDoc.lwfEnabled = employee.lwfEnabled !== false;
          latestInDoc.gratuityEnabled = employee.gratuityEnabled !== false;
          latestInDoc.includePfInCTC = employee.includePfInCTC !== false;
          latestInDoc.includeGratuityInCTC = employee.includeGratuityInCTC !== false;
          latestInDoc.basicPercent = employee.basicPercent;
          latestInDoc.hraPercent = employee.hraPercent;
          latestInDoc.joiningBonus = Number(employee.joiningBonus) || 0;
          latestInDoc.flexiAmount = Number(employee.flexiAmount) || 0;
          latestInDoc.broadband = Number(employee.broadband) || 0;
          latestInDoc.petrol = Number(employee.petrol) || 0;
          latestInDoc.lta = Number(employee.lta) || 0;
          latestInDoc.employerNPS = Number(employee.employerNPS) || 0;
          latestInDoc.insuranceAmount = Number(employee.insuranceAmount) || 0;
          latestInDoc.deductions = {
            tds: employee.deductions?.tds || 0,
            professionalTax: employee.deductions?.professionalTax || 0,
            otherDeductions: employee.deductions?.otherDeductions || [],
          };
          latestInDoc.salaryStructure = {
            conveyance: Number(employee.salaryStructure?.conveyance) || 0,
            medicalAllowance: Number(employee.salaryStructure?.medicalAllowance) || 0,
            otherAllowances: employee.salaryStructure?.otherAllowances || [],
          };
        }
      }
    }

    employee.salaryRevisions.push({
      effectiveDate,
      previousCTC,
      newCTC,
      reason: req.body.reason || '',
      revisedBy: req.user?.email || req.user?.username || String(req.user?._id || ''),

      monthlyCTC: newCTC,
      pfEnabled: nextPayload.pfEnabled,
      esiEnabled: nextPayload.esiEnabled,
      ptEnabled: nextPayload.ptEnabled,
      lwfEnabled: nextPayload.lwfEnabled,
      gratuityEnabled: nextPayload.gratuityEnabled,
      includePfInCTC: nextPayload.includePfInCTC,
      includeGratuityInCTC: nextPayload.includeGratuityInCTC,
      basicPercent: nextPayload.basicPercent,
      hraPercent: nextPayload.hraPercent,
      joiningBonus: nextPayload.joiningBonus,
      flexiAmount: nextPayload.flexiAmount,
      broadband: nextPayload.broadband,
      petrol: nextPayload.petrol,
      lta: nextPayload.lta,
      employerNPS: nextPayload.employerNPS,
      insuranceAmount: nextPayload.insuranceAmount,
      deductions: nextPayload.deductions,
      salaryStructure: {
        conveyance: nextPayload.salaryStructure?.conveyance || 0,
        medicalAllowance: nextPayload.salaryStructure?.medicalAllowance || 0,
        otherAllowances: nextPayload.salaryStructure?.otherAllowances || [],
      },
    });

    employee.monthlyCTC = newCTC;
    employee.pfEnabled = nextPayload.pfEnabled;
    employee.esiEnabled = nextPayload.esiEnabled;
    employee.ptEnabled = nextPayload.ptEnabled;
    employee.lwfEnabled = nextPayload.lwfEnabled;
    employee.gratuityEnabled = nextPayload.gratuityEnabled;
    employee.includePfInCTC = nextPayload.includePfInCTC;
    employee.includeGratuityInCTC = nextPayload.includeGratuityInCTC;
    employee.basicPercent = nextPayload.basicPercent;
    employee.hraPercent = nextPayload.hraPercent;
    employee.joiningBonus = nextPayload.joiningBonus;
    employee.flexiAmount = nextPayload.flexiAmount;
    employee.broadband = nextPayload.broadband;
    employee.petrol = nextPayload.petrol;
    employee.lta = nextPayload.lta;
    employee.employerNPS = nextPayload.employerNPS;
    employee.insuranceAmount = nextPayload.insuranceAmount;
    employee.deductions = nextPayload.deductions;
    employee.salaryStructure = salaryStructure;

    await employee.save();

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
