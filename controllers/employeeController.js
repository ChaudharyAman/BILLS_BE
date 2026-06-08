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

const findCustomComponent = (headerKey, config) => {
  const normHeader = String(headerKey).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!config?.salaryComponents) return null;
  for (const c of config.salaryComponents) {
    if (['basic', 'hra', 'special', 'conveyance', 'medical', 'flexi', 'broadband', 'petrol', 'lta'].includes(c.id)) {
      continue;
    }
    const normId = String(c.id).toLowerCase().replace(/[^a-z0-9]/g, '');
    const normName = String(c.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let normLabel = normName;
    if (c.frequency === 'quarterly') normLabel = normName + 'quarterly';
    else if (c.frequency === 'semi_annually') normLabel = normName + 'semiannually';
    else if (c.frequency === 'annually') normLabel = normName + 'annually';

    if (normHeader === normId || normHeader === normName || normHeader === normLabel) {
      return c;
    }
  }
  return null;
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
      .select('employeeId firstName lastName email designation department salaryStructure deductions monthlyCTC flexiAmount broadband petrol lta employerNPS insuranceAmount joiningBonus joiningDate location dateOfLeaving pfEnabled esiEnabled ptEnabled lwfEnabled gratuityEnabled includePfInCTC includeGratuityInCTC basicPercent hraPercent')
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
    const baseSequence = Date.now();

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
      const monthlyCTC = Number(getCellValue(rawRow, ['MONTHLY CTC', 'CTC', 'MONTHLY SALARY'])) || 0;
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
      const flexiAmount = Number(getCellValue(rawRow, ['FLEXI AMOUNT', 'FLEXI', 'MEAL ALLOWANCE'])) || 0;
      const broadband = Number(getCellValue(rawRow, ['BROADBAND'])) || 0;
      const petrol = Number(getCellValue(rawRow, ['PETROL'])) || 0;
      const lta = Number(getCellValue(rawRow, ['LTA'])) || 0;
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

      // Gather any custom fields from the raw row (non-standard columns)
      Object.keys(rawRow).forEach((key) => {
        if (!standardAliases.has(key)) {
          const matchedComp = findCustomComponent(key, config);
          if (matchedComp) {
            payload.salaryStructure[matchedComp.id] = Number(rawRow[key]) || 0;
          } else {
            const camelKey = toCamelCase(key);
            if (camelKey) {
              let val = rawRow[key];
              if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
                try {
                  val = JSON.parse(val);
                } catch (e) {
                  // Keep as string if parsing fails
                }
              }
              payload[camelKey] = val;
            }
          }
        }
      });

      const salaryStructure = buildSalaryStructureFromCTC(payload, config);
      payload.salaryStructure = salaryStructure;

      try {
        await Employee.create(payload);
        imported += 1;
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

    res.json({ imported, skipped, errors });
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

    // Map custom salary components from payroll config
    const customCompHeadersMap = {};
    if (config?.salaryComponents) {
      config.salaryComponents.forEach((c) => {
        if (!['basic', 'hra', 'special', 'conveyance', 'medical', 'flexi', 'broadband', 'petrol', 'lta'].includes(c.id)) {
          let suffix = '';
          if (c.frequency === 'quarterly') suffix = ' (Quarterly)';
          else if (c.frequency === 'semi_annually') suffix = ' (Semi-Annually)';
          else if (c.frequency === 'annually') suffix = ' (Annually)';
          customCompHeadersMap[c.id] = `${c.name || c.id}${suffix}`;
        }
      });
    }

    const standardKeys = new Set([
      '_id', 'user', 'employeeId', 'firstName', 'lastName', 'email', 'phone', 'dateOfBirth', 'gender',
      'address', 'designation', 'department', 'joiningDate', 'location', 'dateOfLeaving', 'employmentType',
      'status', 'monthlyCTC', 'flexiAmount', 'broadband', 'petrol', 'lta', 'employerNPS', 'insuranceAmount',
      'joiningBonus', 'basicPercent', 'hraPercent', 'pfEnabled', 'esiEnabled', 'ptEnabled', 'lwfEnabled',
      'gratuityEnabled', 'includePfInCTC', 'includeGratuityInCTC', 'salaryStructure', 'deductions',
      'bankDetails', 'panNumber', 'uanNumber', 'aadharNumber', 'taxRegime', 'declarations', 'documents',
      'salaryRevisions', 'createdAt', 'updatedAt', '__v'
    ]);

    const rootCustomKeys = new Set();
    employees.forEach((employee) => {
      Object.keys(employee).forEach((key) => {
        if (!standardKeys.has(key) && !key.startsWith('_') && !key.startsWith('$')) {
          if (!customCompHeadersMap[key]) {
            rootCustomKeys.add(key);
          }
        }
      });
    });
    const sortedRootCustomKeys = Array.from(rootCustomKeys).sort();

    const headers = [
      'Employee ID', 'First Name', 'Last Name', 'Email', 'Phone', 'Date of Birth', 'Gender',
      'Joining Date', 'Date of Leaving', 'Location', 'Designation', 'Department', 'Employment Type', 'Status',
      'Tax Regime', 'PF Enabled', 'ESI Enabled', 'PT Enabled', 'LWF Enabled', 'Gratuity Enabled', 'Include PF in CTC', 'Include Gratuity in CTC',
      'Monthly CTC', 'Basic %', 'HRA %',
      'Basic Salary', 'HRA', 'Special Allowance', 'Gross Salary', 'Employer PF', 'Employer Gratuity', 'Total Deductions', 'Net Take Home',
      'Flexi Amount', 'Broadband', 'Petrol', 'LTA', 'Employer NPS', 'Insurance Amount', 'Joining Bonus',
      'Professional Tax', 'TDS',
      'Account Name', 'Account Number', 'IFSC Code', 'Bank Name', 'Branch',
      'PAN Number', 'UAN Number', 'Aadhar Number',
      'Address Line 1', 'Address Line 2', 'City', 'State', 'Zip', 'Country',
      'Section 80C', 'Section 80D', 'Section 24b', 'Section 80CCD(1B)', 'Rent Paid Monthly', 'Is Metro City', 'Other Exemptions',
      ...Object.values(customCompHeadersMap),
      ...sortedRootCustomKeys
    ];

    const headerGroups = [
      'Personal Details', '', '', '', '', '', '',
      'Employment Details', '', '', '', '', '', '',
      'Statutory Toggles', '', '', '', '', '', '', '',
      'Salary Details', '', '', '', '', '', '', '', '', '', '',
      'Flexi & Other Allowance', '', '', '', '', '', '',
      'Deductions', '',
      'Bank Details', '', '', '', '',
      'Identity Details', '', '',
      'Address Details', '', '', '', '', '',
      'Tax Declarations & Exemptions', '', '', '', '', '', ''
    ];

    const merges = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },     // Personal Details
      { s: { r: 0, c: 7 }, e: { r: 0, c: 13 } },    // Employment Details
      { s: { r: 0, c: 14 }, e: { r: 0, c: 21 } },   // Statutory Toggles
      { s: { r: 0, c: 22 }, e: { r: 0, c: 32 } },   // Salary Details
      { s: { r: 0, c: 33 }, e: { r: 0, c: 39 } },   // Flexi & Other Allowance
      { s: { r: 0, c: 40 }, e: { r: 0, c: 41 } },   // Deductions
      { s: { r: 0, c: 42 }, e: { r: 0, c: 46 } },   // Bank Details
      { s: { r: 0, c: 47 }, e: { r: 0, c: 49 } },   // Identity Details
      { s: { r: 0, c: 50 }, e: { r: 0, c: 55 } },   // Address Details
      { s: { r: 0, c: 56 }, e: { r: 0, c: 62 } },   // Tax Declarations
    ];

    const customCompCount = Object.keys(customCompHeadersMap).length;
    if (customCompCount > 0) {
      headerGroups.push('Custom Components');
      for (let i = 1; i < customCompCount; i++) {
        headerGroups.push('');
      }
      merges.push({
        s: { r: 0, c: 63 },
        e: { r: 0, c: 63 + customCompCount - 1 }
      });
    }

    const rootCustomCount = sortedRootCustomKeys.length;
    if (rootCustomCount > 0) {
      headerGroups.push('Other Details');
      const startCol = 63 + customCompCount;
      for (let i = 1; i < rootCustomCount; i++) {
        headerGroups.push('');
      }
      merges.push({
        s: { r: 0, c: startCol },
        e: { r: 0, c: startCol + rootCustomCount - 1 }
      });
    }

    const startRow = 3;
    const endRow = employees.length + 2;
    const totals = Array(headers.length).fill('');
    totals[0] = 'TOTAL';

    const sumColIndexes = [22, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41];
    for (let c = 63; c < 63 + customCompCount; c++) {
      sumColIndexes.push(c);
    }

    sumColIndexes.forEach((colIndex) => {
      const colLetter = XLSX.utils.encode_col(colIndex);
      totals[colIndex] = { f: `SUM(${colLetter}${startRow}:${colLetter}${endRow})` };
    });

    const rows = [
      headerGroups,
      headers,
      ...employees.map((employee, index) => {
        const addr = employee.address || {};
        const bank = employee.bankDetails || {};
        const ded = employee.deductions || {};
        const dec = employee.declarations || {};
        const rNum = index + 3;

        const pfEnabled = employee.pfEnabled !== false ? 'Yes' : 'No';
        const gratuityEnabled = employee.gratuityEnabled !== false ? 'Yes' : 'No';
        const includePfInCTC = employee.includePfInCTC !== false ? 'Yes' : 'No';
        const includeGratuityInCTC = employee.includeGratuityInCTC !== false ? 'Yes' : 'No';

        const basicDef = config.basicPercent !== undefined && config.basicPercent !== null
          ? (config.basicPercent > 1 ? config.basicPercent / 100 : config.basicPercent)
          : 0.5;
        const hraDef = config.hraPercent !== undefined && config.hraPercent !== null
          ? (config.hraPercent > 1 ? config.hraPercent / 100 : config.hraPercent)
          : 0.5;
        const pfRate = config.pfRate !== undefined && config.pfRate !== null ? config.pfRate : 0.12;
        const pfCap = config.pfCap !== undefined && config.pfCap !== null ? config.pfCap : 15000;
        const pfEmployerRate = config.pfEmployerRate !== undefined && config.pfEmployerRate !== null ? config.pfEmployerRate : 0.12;
        const gratuityRate = config.gratuityRate !== undefined && config.gratuityRate !== null ? config.gratuityRate : 0.0481;

        const standardValues = [
          employee.employeeId || '',
          employee.firstName || '',
          employee.lastName || '',
          employee.email || '',
          employee.phone || '',
          formatDateOnly(employee.dateOfBirth),
          employee.gender || '',
          formatDateOnly(employee.joiningDate),
          formatDateOnly(employee.dateOfLeaving),
          employee.location || '',
          employee.designation || '',
          employee.department?.name || '',
          employee.employmentType || '',
          employee.status || '',
          employee.taxRegime || '',
          pfEnabled,
          employee.esiEnabled !== false ? 'Yes' : 'No',
          employee.ptEnabled !== false ? 'Yes' : 'No',
          employee.lwfEnabled !== false ? 'Yes' : 'No',
          gratuityEnabled,
          includePfInCTC,
          includeGratuityInCTC,
          Number(employee.monthlyCTC) || 0,
          employee.basicPercent !== undefined && employee.basicPercent !== null ? Number(employee.basicPercent) : basicDef * 100,
          employee.hraPercent !== undefined && employee.hraPercent !== null ? Number(employee.hraPercent) : hraDef * 100,
          { f: `ROUND(W${rNum} * IF(X${rNum}<>"", X${rNum}/100, ${basicDef}), 2)`, v: Number(employee.salaryStructure?.basic) || 0 },
          { f: `ROUND(Z${rNum} * IF(Y${rNum}<>"", Y${rNum}/100, ${hraDef}), 2)`, v: Number(employee.salaryStructure?.hra) || 0 },
          { f: `ROUND(MAX(W${rNum} - Z${rNum} - AA${rNum} - AH${rNum} - AI${rNum} - AJ${rNum} - AK${rNum} - AL${rNum} - AM${rNum} - IF(U${rNum}="Yes", AD${rNum}, 0) - IF(V${rNum}="Yes", AE${rNum}, 0), 0), 2)`, v: Number(employee.salaryStructure?.specialAllowance) || 0 },
          { f: `ROUND(Z${rNum} + AA${rNum} + AB${rNum}, 2)`, v: Number(employee.salaryStructure?.grossSalary) || 0 },
          { f: `ROUND(IF(P${rNum}="Yes", MIN(Z${rNum}, ${pfCap}) * ${pfEmployerRate}, 0), 2)`, v: Number(ded.pf) || 0 },
          { f: `ROUND(IF(T${rNum}="Yes", Z${rNum} * ${gratuityRate}, 0), 2)`, v: Number(employee.salaryStructure?.ctc) ? Number(employee.salaryStructure?.ctc) - Number(employee.salaryStructure?.grossSalary) - (Number(ded.pf) || 0) : 0 },
          { f: `ROUND(IF(P${rNum}="Yes", MIN(Z${rNum}, ${pfCap}) * ${pfRate}, 0) + AO${rNum} + AP${rNum}, 2)`, v: (Number(ded.pf) || 0) + (Number(ded.professionalTax) || 0) + (Number(ded.tds) || 0) },
          { f: `ROUND(AC${rNum} - AF${rNum} + AH${rNum} + AI${rNum} + AJ${rNum} + AK${rNum}, 2)`, v: (Number(employee.salaryStructure?.grossSalary) || 0) - ((Number(ded.pf) || 0) + (Number(ded.professionalTax) || 0) + (Number(ded.tds) || 0)) + (Number(employee.flexiAmount) || 0) + (Number(employee.broadband) || 0) + (Number(employee.petrol) || 0) + (Number(employee.lta) || 0) },
          Number(employee.flexiAmount) || 0,
          Number(employee.broadband) || 0,
          Number(employee.petrol) || 0,
          Number(employee.lta) || 0,
          Number(employee.employerNPS) || 0,
          Number(employee.insuranceAmount) || 0,
          Number(employee.joiningBonus) || 0,
          Number(ded.professionalTax) || 0,
          Number(ded.tds) || 0,
          bank.accountName || '',
          bank.accountNumber || '',
          bank.ifscCode || '',
          bank.bankName || '',
          bank.branch || '',
          employee.panNumber || '',
          employee.uanNumber || '',
          employee.aadharNumber || '',
          addr.line1 || '',
          addr.line2 || '',
          addr.city || '',
          addr.state || '',
          addr.zip || '',
          addr.country || '',
          Number(dec.section80C) || 0,
          Number(dec.section80D) || 0,
          Number(dec.section24b) || 0,
          Number(dec.section80CCD1B) || 0,
          Number(dec.rentPaidMonthly) || 0,
          dec.isMetroCity ? 'Yes' : 'No',
          Number(dec.otherExemptions) || 0,
        ];

        const customCompValues = Object.keys(customCompHeadersMap).map((cId) => {
          const val = employee.salaryStructure?.[cId] !== undefined
            ? employee.salaryStructure[cId]
            : employee[cId];
          return val !== undefined && val !== null ? val : '';
        });

        const rootCustomValues = sortedRootCustomKeys.map((key) => {
          const val = employee[key];
          if (val && typeof val === 'object') {
            return JSON.stringify(val);
          }
          return val !== undefined && val !== null ? val : '';
        });

        return [...standardValues, ...customCompValues, ...rootCustomValues];
      }),
      totals
    ];

    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    worksheet['!merges'] = merges;
    const workbook = XLSX.utils.book_new();

    const categoryStyles = [
      { start: 0, end: 6, bg: 'DDEBF7', fg: '1F4E78' },
      { start: 7, end: 13, bg: 'E2F0D9', fg: '385723' },
      { start: 14, end: 24, bg: 'FFF2CC', fg: '7F6000' },
      { start: 25, end: 31, bg: 'F2F2F2', fg: '595959' },
      { start: 32, end: 33, bg: 'FCE4D6', fg: 'C65911' },
      { start: 34, end: 38, bg: 'E8E8FF', fg: '2F2F80' },
      { start: 39, end: 41, bg: 'E1D5E7', fg: '603080' },
      { start: 42, end: 49, bg: 'FFF0F5', fg: '8B0086' },
      { start: 50, end: 55, bg: 'E6F2FF', fg: '0055A5' },
      { start: 56, end: 62, bg: 'EAFBF0', fg: '0E7035' },
    ];

    if (customCompCount > 0) {
      categoryStyles.push({
        start: 63,
        end: 63 + customCompCount - 1,
        bg: 'F0F8FF',
        fg: '004080'
      });
    }

    if (rootCustomCount > 0) {
      categoryStyles.push({
        start: 63 + customCompCount,
        end: 63 + customCompCount + rootCustomCount - 1,
        bg: 'FFF5EE',
        fg: '8B4513'
      });
    }

    categoryStyles.forEach(({ start, end, bg, fg }) => {
      for (let c = start; c <= end; c++) {
        const cell1 = `${XLSX.utils.encode_col(c)}1`;
        const cell2 = `${XLSX.utils.encode_col(c)}2`;
        [cell1, cell2].forEach((addr) => {
          if (!worksheet[addr]) return;
          worksheet[addr].s = {
            font: { bold: true, color: { rgb: fg } },
            fill: { fgColor: { rgb: bg } },
            alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
            border: {
              top: { style: 'thin', color: { rgb: 'D9D9D9' } },
              bottom: { style: 'thin', color: { rgb: 'D9D9D9' } },
              left: { style: 'thin', color: { rgb: 'D9D9D9' } },
              right: { style: 'thin', color: { rgb: 'D9D9D9' } }
            }
          };
        });
      }
    });

    const totalRowIndex = employees.length + 3;
    for (let c = 0; c < headers.length; c++) {
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

    worksheet['!cols'] = headers.map(() => ({ wch: 18 }));

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

    const headers = [
      'Employee ID', 'First Name', 'Last Name', 'Email', 'Phone', 'Date of Birth', 'Gender',
      'Joining Date', 'Date of Leaving', 'Location', 'Designation', 'Department', 'Employment Type', 'Status',
      'Tax Regime', 'PF Enabled', 'ESI Enabled', 'PT Enabled', 'LWF Enabled', 'Gratuity Enabled', 'Include PF in CTC', 'Include Gratuity in CTC',
      'Monthly CTC', 'Basic %', 'HRA %',
      'Basic Salary', 'HRA', 'Special Allowance', 'Gross Salary', 'Employer PF', 'Employer Gratuity', 'Total Deductions', 'Net Take Home',
      'Flexi Amount', 'Broadband', 'Petrol', 'LTA', 'Employer NPS', 'Insurance Amount', 'Joining Bonus',
      'Professional Tax', 'TDS',
      'Account Name', 'Account Number', 'IFSC Code', 'Bank Name', 'Branch',
      'PAN Number', 'UAN Number', 'Aadhar Number',
      'Address Line 1', 'Address Line 2', 'City', 'State', 'Zip', 'Country',
      'Section 80C', 'Section 80D', 'Section 24b', 'Section 80CCD(1B)', 'Rent Paid Monthly', 'Is Metro City', 'Other Exemptions'
    ];

    const customCompHeaders = [];
    if (config?.salaryComponents) {
      config.salaryComponents.forEach((c) => {
        if (!['basic', 'hra', 'special', 'conveyance', 'medical', 'flexi', 'broadband', 'petrol', 'lta'].includes(c.id)) {
          let suffix = '';
          if (c.frequency === 'quarterly') suffix = ' (Quarterly)';
          else if (c.frequency === 'semi_annually') suffix = ' (Semi-Annually)';
          else if (c.frequency === 'annually') suffix = ' (Annually)';
          customCompHeaders.push(`${c.name || c.id}${suffix}`);
        }
      });
    }

    const allHeaders = [...headers, ...customCompHeaders];

    const headerGroups = [
      'Personal Details', '', '', '', '', '', '',
      'Employment Details', '', '', '', '', '', '',
      'Statutory Toggles', '', '', '', '', '', '', '',
      'Salary Details', '', '', '', '', '', '', '', '', '', '',
      'Flexi & Other Allowance', '', '', '', '', '', '',
      'Deductions', '',
      'Bank Details', '', '', '', '',
      'Identity Details', '', '',
      'Address Details', '', '', '', '', '',
      'Tax Declarations & Exemptions', '', '', '', '', '', ''
    ];

    if (customCompHeaders.length > 0) {
      headerGroups.push('Custom Components');
      for (let i = 1; i < customCompHeaders.length; i++) {
        headerGroups.push('');
      }
    }

    const merges = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },     // Personal Details
      { s: { r: 0, c: 7 }, e: { r: 0, c: 13 } },    // Employment Details
      { s: { r: 0, c: 14 }, e: { r: 0, c: 21 } },   // Statutory Toggles
      { s: { r: 0, c: 22 }, e: { r: 0, c: 32 } },   // Salary Details
      { s: { r: 0, c: 33 }, e: { r: 0, c: 39 } },   // Flexi & Other Allowance
      { s: { r: 0, c: 40 }, e: { r: 0, c: 41 } },   // Deductions
      { s: { r: 0, c: 42 }, e: { r: 0, c: 46 } },   // Bank Details
      { s: { r: 0, c: 47 }, e: { r: 0, c: 49 } },   // Identity Details
      { s: { r: 0, c: 50 }, e: { r: 0, c: 55 } },   // Address Details
      { s: { r: 0, c: 56 }, e: { r: 0, c: 62 } },   // Tax Declarations
    ];

    if (customCompHeaders.length > 0) {
      merges.push({
        s: { r: 0, c: 63 },
        e: { r: 0, c: 63 + customCompHeaders.length - 1 }
      });
    }

    const sampleRow = [
      'EMP-001', 'John', 'Doe', 'john.doe@example.com', '9876543210', '1990-01-01', 'Male',
      '2026-06-01', '', 'Delhi', 'Software Engineer', 'Engineering', 'full-time', 'active',
      'new',
      'No', 'No', 'No', 'No', 'No',
      'No', 'No',
      50000, basicDef * 100, hraDef * 100,
      { f: `ROUND(W3 * IF(X3<>"", X3/100, ${basicDef}), 2)` },
      { f: `ROUND(Z3 * IF(Y3<>"", Y3/100, ${hraDef}), 2)` },
      { f: `ROUND(MAX(W3 - Z3 - AA3 - AH3 - AI3 - AJ3 - AK3 - AL3 - AM3 - IF(U3="Yes", AD3, 0) - IF(V3="Yes", AE3, 0), 0), 2)` },
      { f: `ROUND(Z3 + AA3 + AB3, 2)` },
      { f: `ROUND(IF(P3="Yes", MIN(Z3, ${pfCap}) * ${pfEmployerRate}, 0), 2)` },
      { f: `ROUND(IF(T3="Yes", Z3 * ${gratuityRate}, 0), 2)` },
      { f: `ROUND(IF(P3="Yes", MIN(Z3, ${pfCap}) * ${pfRate}, 0) + AO3 + AP3, 2)` },
      { f: `ROUND(AC3 - AF3 + AH3 + AI3 + AJ3 + AK3, 2)` },
      0, 0, 0, 0, 0, 0, 0,
      200, 0,
      'John Doe', '1234567890', 'UTIB0000123', 'Axis Bank', 'Delhi',
      'ABCDE1234F', '', '123456789012',
      '123 Street Name', '', 'Delhi', 'Delhi', '110001', 'India',
      0, 0, 0, 0, 0, 'No', 0
    ];

    customCompHeaders.forEach(() => sampleRow.push(0));

    const rows = [headerGroups, allHeaders, sampleRow];

    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    worksheet['!merges'] = merges;
    const workbook = XLSX.utils.book_new();

    const categoryStyles = [
      { start: 0, end: 6, bg: 'DDEBF7', fg: '1F4E78' },
      { start: 7, end: 13, bg: 'E2F0D9', fg: '385723' },
      { start: 14, end: 21, bg: 'FFF0F5', fg: '8B0086' },
      { start: 22, end: 32, bg: 'FFF2CC', fg: '7F6000' },
      { start: 33, end: 39, bg: 'F2F2F2', fg: '595959' },
      { start: 40, end: 41, bg: 'FCE4D6', fg: 'C65911' },
      { start: 42, end: 46, bg: 'E8E8FF', fg: '2F2F80' },
      { start: 47, end: 49, bg: 'E1D5E7', fg: '603080' },
      { start: 50, end: 55, bg: 'E6F2FF', fg: '0055A5' },
      { start: 56, end: 62, bg: 'EAFBF0', fg: '0E7035' },
    ];

    const customCompCount = customCompHeaders.length;
    if (customCompCount > 0) {
      categoryStyles.push({
        start: 63,
        end: 63 + customCompCount - 1,
        bg: 'F0F8FF',
        fg: '004080'
      });
    }

    categoryStyles.forEach(({ start, end, bg, fg }) => {
      for (let c = start; c <= end; c++) {
        const cell1 = `${XLSX.utils.encode_col(c)}1`;
        const cell2 = `${XLSX.utils.encode_col(c)}2`;
        [cell1, cell2].forEach((addr) => {
          if (!worksheet[addr]) return;
          worksheet[addr].s = {
            font: { bold: true, color: { rgb: fg } },
            fill: { fgColor: { rgb: bg } },
            alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
            border: {
              top: { style: 'thin', color: { rgb: 'D9D9D9' } },
              bottom: { style: 'thin', color: { rgb: 'D9D9D9' } },
              left: { style: 'thin', color: { rgb: 'D9D9D9' } },
              right: { style: 'thin', color: { rgb: 'D9D9D9' } }
            }
          };
        });
      }
    });

    worksheet['!cols'] = allHeaders.map(() => ({ wch: 18 }));

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
    const nextPayload = {
      ...employee.toObject(),
      monthlyCTC: newCTC,
      flexiAmount: Number(employee.flexiAmount) || 0,
      broadband: Number(employee.broadband) || 0,
      petrol: Number(employee.petrol) || 0,
      lta: Number(employee.lta) || 0,
      employerNPS: Number(employee.employerNPS) || 0,
      insuranceAmount: Number(employee.insuranceAmount) || 0,
      salaryStructure: {
        conveyance: Number(employee.salaryStructure?.conveyance) || 0,
        medicalAllowance: Number(employee.salaryStructure?.medicalAllowance) || 0,
        otherAllowances: Array.isArray(employee.salaryStructure?.otherAllowances) ? employee.salaryStructure.otherAllowances : [],
      },
    };
    const salaryStructure = buildSalaryStructureFromCTC(nextPayload, config);

    employee.salaryRevisions.push({
      effectiveDate,
      previousCTC,
      newCTC,
      reason: req.body.reason || '',
      revisedBy: req.user?.email || req.user?.username || String(req.user?._id || ''),
    });
    employee.monthlyCTC = newCTC;
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
