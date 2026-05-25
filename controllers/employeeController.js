const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const Department = require('../models/Department');
const Payroll = require('../models/Payroll');
const PayrollConfig = require('../models/PayrollConfig');
const escapeRegex = require('../utils/escapeRegex');
const { XLSX, setHeaderStyle, sendWorkbook } = require('../utils/excel');
const { buildMasterSalaryStructure, roundAmount } = require('../utils/payrollMath');

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

const buildSalaryStructureFromCTC = (payload, config) => {
  const master = buildMasterSalaryStructure(payload, config);
  return {
    basic: master.basicMaster,
    hra: master.hraMaster,
    conveyance: Number(payload.salaryStructure?.conveyance) || 0,
    medicalAllowance: Number(payload.salaryStructure?.medicalAllowance) || 0,
    specialAllowance: master.specialAllowance,
    grossSalary: master.grossSalary,
    ctc: master.monthlyCTC,
    otherAllowances: Array.isArray(payload.salaryStructure?.otherAllowances) ? payload.salaryStructure.otherAllowances : [],
  };
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
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const hasPayroll = await Payroll.exists({ user: req.user._id, employee: req.params.id });
    if (hasPayroll) {
      return res.status(400).json({ message: 'Cannot delete employee with payroll records. Mark them inactive instead.' });
    }

    const employee = await Employee.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!employee) return res.status(404).json({ message: 'Employee not found' });
    res.json({ message: 'Employee deleted successfully' });
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
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const config = await getOrCreateConfig(req.user._id);

    let imported = 0;
    let skipped = 0;
    const errors = [];
    const baseSequence = Date.now();

    for (let index = 0; index < rows.length; index += 1) {
      const rawRow = normalizeRow(rows[index]);
      const fullName = getCellValue(rawRow, ['NAME OF EMPLOYEE', 'EMPLOYEE NAME', 'NAME']);
      const { firstName, lastName } = splitEmployeeName(fullName);

      if (!firstName) {
        skipped += 1;
        errors.push({ row: index + 2, message: 'Employee name is missing' });
        continue;
      }

      const employeeId = String(getCellValue(rawRow, ['EMP NO', 'EMPLOYEE ID', 'EMP ID', 'EMP NO.']) || `EMP-${baseSequence}-${index + 1}`).trim();
      const emailRaw = String(getCellValue(rawRow, ['EMAIL', 'EMAIL ID']) || `${employeeId.toLowerCase()}@import.local`).trim().toLowerCase();
      const monthlyCTC = Number(getCellValue(rawRow, ['MONTHLY CTC', 'CTC', 'MONTHLY SALARY'])) || 0;
      const location = String(getCellValue(rawRow, ['LOCATION', 'CITY', 'WORK LOCATION']) || '').trim();
      const joiningDate = parsePossibleDate(getCellValue(rawRow, ['DOJ', 'JOINING DATE', 'DATE OF JOINING'])) || new Date();
      const dateOfLeaving = parsePossibleDate(getCellValue(rawRow, ['DOL', 'DATE OF LEAVING']));
      const designation = String(getCellValue(rawRow, ['DESIGNATION', 'ROLE']) || '').trim();
      const gender = String(getCellValue(rawRow, ['GENDER']) || '').trim();
      const accountNumber = String(getCellValue(rawRow, ['BANK A/C', 'ACCOUNT NUMBER', 'BANK ACCOUNT']) || '').trim();
      const ifscCode = String(getCellValue(rawRow, ['IFSC', 'IFSC CODE']) || '').trim();
      const panNumber = String(getCellValue(rawRow, ['PAN', 'PAN NO', 'PAN NUMBER']) || '').trim();
      const aadharNumber = String(getCellValue(rawRow, ['AADHAR', 'AADHAR NO', 'AADHAR NUMBER']) || '').trim();
      const phone = String(getCellValue(rawRow, ['PHONE', 'MOBILE', 'CONTACT']) || '').trim();
      const flexiAmount = Number(getCellValue(rawRow, ['FLEXI AMOUNT', 'FLEXI', 'MEAL ALLOWANCE'])) || 0;
      const broadband = Number(getCellValue(rawRow, ['BROADBAND'])) || 0;
      const petrol = Number(getCellValue(rawRow, ['PETROL'])) || 0;
      const lta = Number(getCellValue(rawRow, ['LTA'])) || 0;
      const employerNPS = Number(getCellValue(rawRow, ['EMPLOYER NPS', 'NPS'])) || 0;
      const insuranceAmount = Number(getCellValue(rawRow, ['INSURANCE', 'INSURANCE AMOUNT'])) || 1000;
      const joiningBonus = Number(getCellValue(rawRow, ['JOINING BONUS'])) || 0;
      const professionalTax = Number(getCellValue(rawRow, ['PROFESSIONAL TAX', 'PT'])) || 0;
      const tds = Number(getCellValue(rawRow, ['TDS', 'INCOME TAX'])) || 0;

      const payload = {
        user: req.user._id,
        employeeId,
        firstName,
        lastName,
        email: emailRaw,
        phone,
        gender: ['Male', 'Female', 'Other'].includes(gender) ? gender : '',
        joiningDate,
        location,
        dateOfLeaving,
        designation,
        status: dateOfLeaving ? 'inactive' : 'active',
        monthlyCTC,
        flexiAmount,
        broadband,
        petrol,
        lta,
        employerNPS,
        insuranceAmount,
        joiningBonus,
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
          accountName: `${firstName} ${lastName}`.trim(),
          accountNumber,
          ifscCode,
        },
        panNumber,
        aadharNumber,
      };

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
      .select('+panNumber +aadharNumber +bankDetails.accountNumber')
      .sort({ createdAt: -1 })
      .lean();

    const rows = [
      ['Employee ID', 'First Name', 'Last Name', 'Email', 'Phone', 'Department', 'Designation', 'Status', 'Location', 'DOJ', 'DOL', 'Monthly CTC', 'Gross Salary', 'Basic', 'HRA', 'PAN', 'Aadhar'],
      ...employees.map((employee) => [
        employee.employeeId || '',
        employee.firstName || '',
        employee.lastName || '',
        employee.email || '',
        employee.phone || '',
        employee.department?.name || '',
        employee.designation || '',
        employee.status || '',
        employee.location || '',
        employee.joiningDate ? new Date(employee.joiningDate) : '',
        employee.dateOfLeaving ? new Date(employee.dateOfLeaving) : '',
        Number(employee.monthlyCTC) || 0,
        Number(employee.salaryStructure?.grossSalary) || 0,
        Number(employee.salaryStructure?.basic) || 0,
        Number(employee.salaryStructure?.hra) || 0,
        employee.panNumber || '',
        employee.aadharNumber || '',
      ]),
    ];

    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    setHeaderStyle(worksheet, ['A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1', 'H1', 'I1', 'J1', 'K1', 'L1', 'M1', 'N1', 'O1', 'P1', 'Q1']);
    worksheet['!cols'] = rows[0].map((_, index) => ({ wch: index >= 11 && index <= 14 ? 14 : 18 }));
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Employees');
    sendWorkbook(res, workbook, 'employees.xlsx');
  } catch (error) {
    console.error('Error exporting employees:', error);
    res.status(500).json({ message: 'Server error exporting employees' });
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
