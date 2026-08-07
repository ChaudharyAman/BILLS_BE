/**
 * controllers/payroll/reporting.js
 *
 * Payroll reporting, Excel sheet exports, audit log inspection, and trend analysis.
 */

const mongoose = require('mongoose');
const Payroll = require('../../models/Payroll');
const { roundAmount, buildPayslipEarningsLineItems, buildMasterSalaryStructure } = require('../../utils/payrollMath');
const { getStrategyStatutoryDefaults } = require('../../utils/payrollStrategies/index');
const { XLSX, setHeaderStyle, applyNumberFormat, sendWorkbook } = require('../../utils/excel');
const { buildEmployeeName, isValidMonth, isValidYear, sumNamedAmounts, getOrCreateConfig } = require('./common');

const buildPayrollWorkbook = (payrolls, config) => {
  const headerGroups = [
    'MASTER DATA', '', '', '', '', '', '', '', '', '', '', '', '',
    'COMPENSATION MODEL', '',
    'MONTHLY MASTER CTC COMPONENTS', '', '', '', '', '', '',
    'EARNINGS & STATUTORY CONTRIBUTIONS (PAID)', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
    'VARIABLE PAY & REIMBURSEMENTS', '', '', '', '', '', '',
    'DEDUCTIONS (EMPLOYEE DUES)', '', '', '', '', '', '', '', '', '',
    'NET PAYOUT', '',
  ];

  const getComponentName = (id, defaultName) => {
    if (!config || !Array.isArray(config.salaryComponents)) return defaultName;
    const comp = config.salaryComponents.find(c => c.id === id);
    return comp?.name || defaultName;
  };

  const basicName = getComponentName('basic', 'BASIC');
  const hraName = getComponentName('hra', 'HRA');
  const flexiName = getComponentName('flexi', 'Flexi');
  const specialName = getComponentName('special', 'Special Allowance');
  const broadbandName = getComponentName('broadband', 'Broadband');
  const petrolName = getComponentName('petrol', 'Petrol');
  const ltaName = getComponentName('lta', 'LTA');

  const columns = [
    'Sr No', 'Name', 'DOJ', 'DOL', 'Gender', 'Emp No', 'Email', 'Bank A/C', 'IFSC', 'PAN', 'Aadhar', 'Location', 'Designation',
    'Compensation Type', 'Period Input Summary',
    'Monthly CTC', `${basicName}(master)`, `${hraName}(master)`, `${flexiName}(master)`, 'PF Employer', `${specialName}`, 'DIFF',
    'Working Days', 'Paid Days', 'Hours Worked', 'Hourly Rate', `${basicName}(paid)`, `${hraName}(paid)`, `${flexiName}`, `${broadbandName}`, `${petrolName}`, `${ltaName}`, 'Conveyance', 'Medical Allowance', 'Overtime', 'Employer NPS', 'Insurance', 'PF(Emp Contrib)', 'ESI Employer', 'Gratuity', 'LWF', 'GROSS TOTAL',
    'Joining Bonus', 'Loyalty Bonus', 'Incentive', 'Other Allowance', 'Special Bonus', 'Reimbursements', 'Total Payable',
    'PF Deduction', 'ESI Deduction', 'Professional Tax (PT)', 'Insurance(ded)', 'Gratuity(ded)', 'LWF(ded)', 'Loan EMI Deduction', 'Other Deduction', 'Income Tax', 'TOTAL DEDUCTION', 'NET TAKE HOME', 'Remarks',
  ];

  const rows = payrolls.map((payroll, index) => {
    const employee = payroll.employee || {};
    const compType = payroll.employeeSnapshot?.compensationType || employee.compensationType || (payroll.payType === 'hourly' ? 'hourly' : 'monthly_salary');

    const lineItems = buildPayslipEarningsLineItems(payroll);
    const periodInputSummary = lineItems.map(item => `${item.name}: ${item.details || `₹${item.amount}`}`).join('; ') || 'Standard Monthly';

    const payrollPaidRatio = Number(payroll.workingDays) > 0 ? Number(payroll.paidDays) / Number(payroll.workingDays) : 1;
    const safeRatio = payrollPaidRatio > 0 ? payrollPaidRatio : 1;
    const basicMaster = roundAmount((Number(payroll.earnings?.basic) || 0) / safeRatio);
    const hraMaster = roundAmount((Number(payroll.earnings?.hra) || 0) / safeRatio);
    const flexiMaster = roundAmount((Number(payroll.earnings?.flexiAmount) || 0) / safeRatio);
    const broadbandMaster = roundAmount((Number(payroll.earnings?.broadband) || 0) / safeRatio);
    const specialMaster = roundAmount((Number(payroll.earnings?.specialAllowance) || 0) / safeRatio);
    const employeeMonthlyCTC = payroll.employeeSnapshot?.monthlyCTC || employee.monthlyCTC || 0;
    const usesSalaryComponents = payroll.employeeSnapshot?.useSalaryComponents !== false &&
      ['monthly_salary', 'attendance_based', 'salary_plus_commission', 'weekly_salary'].includes(compType);

    const diff = usesSalaryComponents ? roundAmount(
      employeeMonthlyCTC -
      basicMaster -
      hraMaster -
      flexiMaster -
      broadbandMaster -
      (Number(payroll.employerContributions?.pfEmployer) || 0) -
      specialMaster -
      (Number(payroll.earnings?.petrol) || 0) -
      (Number(payroll.earnings?.lta) || 0)
    ) : 'N/A — non-CTC compensation type';

    return [
      index + 1,
      buildEmployeeName(employee),
      employee.joiningDate ? new Date(employee.joiningDate) : '',
      employee.dateOfLeaving ? new Date(employee.dateOfLeaving) : '',
      employee.gender || '',
      employee.employeeId || '',
      employee.email || '',
      employee.bankDetails?.accountNumber || '',
      employee.bankDetails?.ifscCode || '',
      employee.panNumber || '',
      employee.aadharNumber || '',
      employee.location || '',
      employee.designation || '',
      compType,
      periodInputSummary,
      employeeMonthlyCTC,
      basicMaster,
      hraMaster,
      flexiMaster,
      Number(payroll.employerContributions?.pfEmployer) || 0,
      specialMaster,
      diff,
      Number(payroll.workingDays) || 0,
      Number(payroll.paidDays) || 0,
      payroll.payType === 'hourly' || compType === 'hourly' || compType === 'timesheet_based' ? (Number(payroll.hoursWorked) || Number(payroll.periodInput?.hoursWorked) || Number(payroll.periodInput?.hoursLogged) || 0) : 0,
      payroll.payType === 'hourly' || compType === 'hourly' || compType === 'timesheet_based' ? (Number(payroll.hourlyRate) || Number(payroll.employeeSnapshot?.hourlyRate) || Number(employee.hourlyRate) || 0) : 0,
      Number(payroll.earnings?.basic) || 0,
      Number(payroll.earnings?.hra) || 0,
      Number(payroll.earnings?.flexiAmount) || 0,
      Number(payroll.earnings?.broadband) || 0,
      Number(payroll.earnings?.petrol) || 0,
      Number(payroll.earnings?.lta) || 0,
      Number(payroll.earnings?.conveyance) || 0,
      Number(payroll.earnings?.medicalAllowance) || 0,
      Number(payroll.earnings?.overtime) || 0,
      Number(payroll.employerContributions?.nps) || 0,
      Number(payroll.employerContributions?.insuranceEmployer) || 0,
      Number(payroll.employerContributions?.pfEmployer) || 0,
      Number(payroll.employerContributions?.esiEmployer) || 0,
      Number(payroll.employerContributions?.gratuity) || 0,
      Number(payroll.employerContributions?.lwfEmployer) || 0,
      Number(payroll.employerContributions?.grossTotalSalary) || Number(payroll.earnings?.totalEarnings) || 0,
      Number(payroll.variablePay?.joiningBonus) || 0,
      Number(payroll.variablePay?.loyaltyBonus) || 0,
      Number(payroll.variablePay?.incentive) || 0,
      sumNamedAmounts(payroll.earnings?.otherEarnings) + (Number(payroll.variablePay?.otherAllowanceArrear) || 0),
      Number(payroll.variablePay?.specialBonus) || 0,
      Number(payroll.totalReimbursementApproved) || 0,
      Number(payroll.totalPayable) || 0,
      Number(payroll.deductions?.pfEmployee) || 0,
      Number(payroll.deductions?.esiEmployee) || 0,
      Number(payroll.deductions?.professionalTax) || 0,
      Number(payroll.deductions?.insuranceEmployee) || 0,
      Number(payroll.deductions?.gratuityDeduction) || 0,
      Number(payroll.deductions?.lwfEmployee) || 0,
      Number(payroll.deductions?.loanDeduction) || 0,
      sumNamedAmounts(payroll.deductions?.otherDeductions),
      Number(payroll.deductions?.tds) || 0,
      Number(payroll.deductions?.totalDeductions) || 0,
      Number(payroll.netSalary) || 0,
      payroll.remarks || payroll.notes || '',
    ];
  });

  const totals = new Array(columns.length).fill('');
  totals[0] = 'TOTAL';
  for (let columnIndex = 15; columnIndex < columns.length - 1; columnIndex += 1) {
    const total = rows.reduce((sum, row) => sum + (typeof row[columnIndex] === 'number' ? row[columnIndex] : 0), 0);
    totals[columnIndex] = roundAmount(total);
  }
  totals[totals.length - 1] = '';

  const sheet = XLSX.utils.aoa_to_sheet([
    headerGroups,
    columns,
    ...rows,
    totals,
  ]);

  sheet['!merges'] = [
    XLSX.utils.decode_range('A1:M1'),
    XLSX.utils.decode_range('N1:O1'),
    XLSX.utils.decode_range('P1:V1'),
    XLSX.utils.decode_range('W1:AQ1'),
    XLSX.utils.decode_range('AR1:AX1'),
    XLSX.utils.decode_range('AY1:BH1'),
    XLSX.utils.decode_range('BI1:BJ1'),
  ];

  const headerCells = [];
  for (let i = 0; i < columns.length; i += 1) {
    headerCells.push(`${XLSX.utils.encode_col(i)}2`);
  }
  ['A1', 'N1', 'P1', 'W1', 'AR1', 'AY1', 'BI1'].forEach((cell) => {
    if (sheet[cell]) {
      sheet[cell].s = {
        font: { bold: true, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: '1A2E44' } },
        alignment: { horizontal: 'center', vertical: 'center' },
      };
    }
  });
  setHeaderStyle(sheet, headerCells);

  const numericCells = [];
  for (let rowIndex = 3; rowIndex <= rows.length + 3; rowIndex += 1) {
    for (let colIndex = 15; colIndex < columns.length - 1; colIndex += 1) {
      numericCells.push(`${XLSX.utils.encode_col(colIndex)}${rowIndex}`);
    }
  }
  applyNumberFormat(sheet, numericCells);
  sheet['!cols'] = columns.map((column, index) => ({
    wch: index === 1 ? 22 : index >= 13 ? 14 : 16,
  }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Payroll Sheet');
  return workbook;
};

const buildPayrollInputsWorkbook = (payrolls, employees, config, month, year) => {
  const actualDaysInMonth = (isValidMonth(month) && isValidYear(year))
    ? new Date(year, month, 0).getDate()
    : 30;

  const defaultWorkingDays = (config?.defaultWorkingDays && config.defaultWorkingDays !== 30)
    ? config.defaultWorkingDays
    : actualDaysInMonth;

  const headerGroups = [
    'EMPLOYEE MASTER INFORMATION', '', '', '', '', '', '', '',
    'EMPLOYEE CONFIGURATION & APPLIED STATUTORY RULES', '', '', '', '', '', '',
    'BASE COMPENSATION AMOUNTS', '', '', '', '', '', '',
    'ATTENDANCE & WORKING DAYS INPUTS', '', '', '', '',
    'TIME & PRODUCTION INPUTS', '', '',
    'VARIABLE PAY & BONUS INPUTS', '', '', '', '', '',
    'MANUAL DEDUCTION & REIMBURSEMENT OVERRIDES', '', '', '',
    'SUMMARY PAYOUT', '',
    'PERIOD REMARKS'
  ];

  const columns = [
    'Sr No', 'Emp No', 'Employee Name', 'Email', 'Department', 'Designation', 'Compensation Type', 'Attendance Mode',
    'Salary Structure Mode', 'PF Status', 'ESI Status', 'PT Status', 'LWF Status', 'Gratuity Status', 'TDS Tax Status',
    'Monthly CTC', 'Basic Salary', 'HRA', 'Special Allowance', 'Gross Salary', 'Total Deductions', 'Net Salary',
    'Working Days', 'Paid Days', 'Paid Leaves', 'Unpaid Leaves (LOP)', 'LOP Strategy',
    'Hours Worked', 'Hourly Rate', 'Units Produced',
    'Overtime Pay', 'Joining Bonus', 'Loyalty Bonus', 'Incentive', 'Special Bonus/Arrears', 'Variable/Commission Pay',
    'Loan EMI Deduction', 'Manual TDS Override', 'Other Deductions', 'Approved Reimbursements',
    'Total Payable', 'Net Take Home',
    'Notes / Remarks'
  ];

  let rows = [];

  if (Array.isArray(payrolls) && payrolls.length > 0) {
    rows = payrolls.map((payroll, index) => {
      const employee = payroll.employee || {};
      const compType = payroll.employeeSnapshot?.compensationType || employee.compensationType || (payroll.payType === 'hourly' ? 'hourly' : 'monthly_salary');
      const attMode = payroll.employeeSnapshot?.attendanceMode || employee.attendanceMode || 'attendance';

      const stratFlags = getStrategyStatutoryDefaults(compType, config?.compensationTypeDefaults || {});

      const pfEnabled = (payroll.employeeSnapshot?.pfEnabled ?? employee.pfEnabled) !== false;
      const esiEnabled = (payroll.employeeSnapshot?.esiEnabled ?? employee.esiEnabled) !== false;
      const ptEnabled = (payroll.employeeSnapshot?.ptEnabled ?? employee.ptEnabled) !== false;
      const lwfEnabled = (payroll.employeeSnapshot?.lwfEnabled ?? employee.lwfEnabled) !== false;
      const gratuityEnabled = (payroll.employeeSnapshot?.gratuityEnabled ?? employee.gratuityEnabled) !== false;
      const tdsEnabled = (payroll.employeeSnapshot?.tdsEnabled ?? employee.tdsEnabled) !== false;
      const useComponents = (payroll.employeeSnapshot?.useSalaryComponents ?? employee.useSalaryComponents) !== false;

      const includePfInCTC = (payroll.employeeSnapshot?.includePfInCTC ?? employee.includePfInCTC) === true;
      const includeGratuityInCTC = (payroll.employeeSnapshot?.includeGratuityInCTC ?? employee.includeGratuityInCTC) !== false;

      const ptState = payroll.employeeSnapshot?.ptState || employee.ptState || '';
      const taxRegime = payroll.employeeSnapshot?.taxRegime || employee.taxRegime || 'new';

      const pfStatus = (stratFlags.pfEligible && pfEnabled)
        ? (includePfInCTC ? 'APPLIED (In CTC)' : 'APPLIED (Extra)')
        : 'NOT APPLIED';

      const esiStatus = (stratFlags.esiEligible && esiEnabled)
        ? 'APPLIED'
        : 'NOT APPLIED';

      const ptStatus = (stratFlags.ptApplicable && ptEnabled)
        ? (ptState ? `APPLIED (${ptState})` : 'APPLIED')
        : 'NOT APPLIED';

      const lwfStatus = (stratFlags.lwfApplicable && lwfEnabled)
        ? 'APPLIED'
        : 'NOT APPLIED';

      const gratuityStatus = (stratFlags.gratuityEligible && gratuityEnabled)
        ? (includeGratuityInCTC ? 'APPLIED (In CTC)' : 'APPLIED (Extra)')
        : 'NOT APPLIED';

      const tdsStatus = tdsEnabled
        ? (['retainer', 'project_based', 'milestone_based', 'commission_only'].includes(compType) ? 'APPLIED (194J - 10%)' : `APPLIED (${taxRegime.toUpperCase()} Regime)`)
        : 'NOT APPLIED';

      const salaryModeStr = useComponents ? 'Component Breakup' : 'Flat Salary';

      const master = buildMasterSalaryStructure(payroll.employeeSnapshot || employee, config || {});

      const monthlyCTC = payroll.employeeSnapshot?.monthlyCTC || employee.monthlyCTC || (employee.annualCTC ? employee.annualCTC / 12 : 0) || master.monthlyCTC || 0;
      const basic = payroll.earnings?.basic !== undefined && payroll.earnings?.basic !== null ? Number(payroll.earnings.basic) : master.basicMaster;
      const hra = payroll.earnings?.hra !== undefined && payroll.earnings?.hra !== null ? Number(payroll.earnings.hra) : master.hraMaster;
      const special = payroll.earnings?.specialAllowance !== undefined && payroll.earnings?.specialAllowance !== null ? Number(payroll.earnings.specialAllowance) : master.specialAllowance;
      const gross = Number(payroll.earnings?.totalEarnings) || Number(payroll.employerContributions?.grossTotalSalary) || master.grossSalary || monthlyCTC;
      const deductions = Number(payroll.deductions?.totalDeductions) || master.totalDeductions || 0;
      const netSalary = Number(payroll.netSalary) || master.netSalary || monthlyCTC;

      const hoursWorked = Number(payroll.hoursWorked) || Number(payroll.periodInput?.hoursWorked) || Number(payroll.periodInput?.hoursLogged) || 0;
      const hourlyRate = Number(payroll.hourlyRate) || Number(payroll.employeeSnapshot?.hourlyRate) || Number(employee.hourlyRate) || 0;
      const unitsProduced = Number(payroll.periodInput?.unitsProduced) || 0;

      const variableCompTotal = Array.isArray(payroll.earnings?.variableCompensation)
        ? payroll.earnings.variableCompensation.reduce((sum, item) => sum + (Number(item.amount) || 0), 0)
        : 0;

      const workingDaysVal = Number(payroll.workingDays) > 0 ? Number(payroll.workingDays) : actualDaysInMonth;
      const paidDaysVal = Number(payroll.paidDays) > 0 ? Number(payroll.paidDays) : workingDaysVal;

      return [
        index + 1,
        employee.employeeId || payroll.employeeSnapshot?.employeeId || '',
        buildEmployeeName(employee.firstName ? employee : payroll.employeeSnapshot || {}),
        employee.email || payroll.employeeSnapshot?.email || '',
        employee.department?.name || employee.department?.code || '',
        employee.designation || payroll.employeeSnapshot?.designation || '',
        compType,
        attMode,
        salaryModeStr,
        pfStatus,
        esiStatus,
        ptStatus,
        lwfStatus,
        gratuityStatus,
        tdsStatus,
        monthlyCTC,
        basic,
        hra,
        special,
        gross,
        deductions,
        netSalary,
        workingDaysVal,
        paidDaysVal,
        Number(payroll.paidLeaves) || 0,
        Number(payroll.unpaidLeaves) || Number(payroll.lop) || 0,
        payroll.lopStrategy || 'proportional',
        hoursWorked,
        hourlyRate,
        unitsProduced,
        Number(payroll.earnings?.overtime) || 0,
        Number(payroll.variablePay?.joiningBonus) || 0,
        Number(payroll.variablePay?.loyaltyBonus) || 0,
        Number(payroll.variablePay?.incentive) || 0,
        Number(payroll.variablePay?.specialBonus || 0) + Number(payroll.variablePay?.otherAllowanceArrear || 0),
        variableCompTotal,
        Number(payroll.deductions?.loanDeduction) || 0,
        Number(payroll.deductions?.tds) || 0,
        sumNamedAmounts(payroll.deductions?.otherDeductions),
        Number(payroll.totalReimbursementApproved) || 0,
        Number(payroll.totalPayable) || gross,
        netSalary,
        payroll.remarks || payroll.notes || '',
      ];
    });
  } else if (Array.isArray(employees) && employees.length > 0) {
    rows = employees.map((employee, index) => {
      const compType = employee.compensationType || (employee.payType === 'hourly' ? 'hourly' : 'monthly_salary');
      const attMode = employee.attendanceMode || 'attendance';

      const stratFlags = getStrategyStatutoryDefaults(compType, config?.compensationTypeDefaults || {});

      const pfEnabled = employee.pfEnabled !== false;
      const esiEnabled = employee.esiEnabled !== false;
      const ptEnabled = employee.ptEnabled !== false;
      const lwfEnabled = employee.lwfEnabled !== false;
      const gratuityEnabled = employee.gratuityEnabled !== false;
      const tdsEnabled = employee.tdsEnabled !== false;
      const useComponents = employee.useSalaryComponents !== false;

      const includePfInCTC = employee.includePfInCTC === true;
      const includeGratuityInCTC = employee.includeGratuityInCTC !== false;

      const ptState = employee.ptState || '';
      const taxRegime = employee.taxRegime || 'new';

      const pfStatus = (stratFlags.pfEligible && pfEnabled)
        ? (includePfInCTC ? 'APPLIED (In CTC)' : 'APPLIED (Extra)')
        : 'NOT APPLIED';

      const esiStatus = (stratFlags.esiEligible && esiEnabled)
        ? 'APPLIED'
        : 'NOT APPLIED';

      const ptStatus = (stratFlags.ptApplicable && ptEnabled)
        ? (ptState ? `APPLIED (${ptState})` : 'APPLIED')
        : 'NOT APPLIED';

      const lwfStatus = (stratFlags.lwfApplicable && lwfEnabled)
        ? 'APPLIED'
        : 'NOT APPLIED';

      const gratuityStatus = (stratFlags.gratuityEligible && gratuityEnabled)
        ? (includeGratuityInCTC ? 'APPLIED (In CTC)' : 'APPLIED (Extra)')
        : 'NOT APPLIED';

      const tdsStatus = tdsEnabled
        ? (['retainer', 'project_based', 'milestone_based', 'commission_only'].includes(compType) ? 'APPLIED (194J - 10%)' : `APPLIED (${taxRegime.toUpperCase()} Regime)`)
        : 'NOT APPLIED';

      const salaryModeStr = useComponents ? 'Component Breakup' : 'Flat Salary';

      const master = buildMasterSalaryStructure(employee, config || {});

      const monthlyCTC = master.monthlyCTC || employee.monthlyCTC || (employee.annualCTC ? employee.annualCTC / 12 : 0);
      const basic = master.basicMaster || 0;
      const hra = master.hraMaster || 0;
      const special = master.specialAllowance || 0;
      const gross = master.grossSalary || monthlyCTC;
      const deductions = master.totalDeductions || 0;
      const netSalary = master.netSalary || monthlyCTC;

      return [
        index + 1,
        employee.employeeId || '',
        buildEmployeeName(employee),
        employee.email || '',
        employee.department?.name || employee.department?.code || '',
        employee.designation || '',
        compType,
        attMode,
        salaryModeStr,
        pfStatus,
        esiStatus,
        ptStatus,
        lwfStatus,
        gratuityStatus,
        tdsStatus,
        monthlyCTC,
        basic,
        hra,
        special,
        monthlyCTC,
        0,
        monthlyCTC,
        defaultWorkingDays,
        defaultWorkingDays,
        0,
        0,
        'proportional',
        compType === 'hourly' ? 160 : 0,
        Number(employee.hourlyRate) || 0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        monthlyCTC,
        monthlyCTC,
        '',
      ];
    });
  }

  const totals = new Array(columns.length).fill('');
  totals[0] = 'TOTAL';
  for (let columnIndex = 15; columnIndex < columns.length - 1; columnIndex += 1) {
    if (columnIndex === 26) continue;
    const total = rows.reduce((sum, row) => sum + (typeof row[columnIndex] === 'number' ? row[columnIndex] : 0), 0);
    totals[columnIndex] = roundAmount(total);
  }

  const sheet = XLSX.utils.aoa_to_sheet([
    headerGroups,
    columns,
    ...rows,
    totals,
  ]);

  sheet['!merges'] = [
    XLSX.utils.decode_range('A1:H1'),
    XLSX.utils.decode_range('I1:O1'),
    XLSX.utils.decode_range('P1:V1'),
    XLSX.utils.decode_range('W1:AA1'),
    XLSX.utils.decode_range('AB1:AD1'),
    XLSX.utils.decode_range('AE1:AJ1'),
    XLSX.utils.decode_range('AK1:AN1'),
    XLSX.utils.decode_range('AO1:AP1'),
    XLSX.utils.decode_range('AQ1:AQ1'),
  ];

  const headerCells = [];
  for (let i = 0; i < columns.length; i += 1) {
    headerCells.push(`${XLSX.utils.encode_col(i)}2`);
  }
  ['A1', 'I1', 'P1', 'W1', 'AB1', 'AE1', 'AK1', 'AO1', 'AQ1'].forEach((cell) => {
    if (sheet[cell]) {
      sheet[cell].s = {
        font: { bold: true, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: '0F172A' } },
        alignment: { horizontal: 'center', vertical: 'center' },
      };
    }
  });
  setHeaderStyle(sheet, headerCells);

  const numericCells = [];
  for (let rowIndex = 3; rowIndex <= rows.length + 3; rowIndex += 1) {
    for (let colIndex = 15; colIndex < columns.length - 1; colIndex += 1) {
      if (colIndex === 26) continue;
      numericCells.push(`${XLSX.utils.encode_col(colIndex)}${rowIndex}`);
    }
  }
  applyNumberFormat(sheet, numericCells);
  sheet['!cols'] = columns.map((column, index) => ({
    wch: index === 2 ? 22 : index === 3 ? 24 : index >= 8 && index <= 14 ? 20 : 16,
  }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Payroll Inputs');
  return workbook;
};

const exportPayrollInputsExcel = async (req, res) => {
  try {
    const month = Number(req.query.month);
    const year = Number(req.query.year);

    if (!isValidMonth(month) || !isValidYear(year)) {
      return res.status(400).json({ message: 'Valid month and year are required' });
    }

    const query = { user: req.user._id, month, year };
    if (req.query.statusFilter && req.query.statusFilter !== 'all') {
      query.status = req.query.statusFilter;
    }

    const payrolls = await Payroll.find(query)
      .populate({
        path: 'employee',
        select: 'firstName lastName employeeId email gender joiningDate dateOfLeaving location designation monthlyCTC bankDetails.ifscCode payType hourlyRate compensationType payFrequency attendanceMode useSalaryComponents department',
        populate: { path: 'department', select: 'name code' },
      })
      .sort({ createdAt: 1 })
      .lean();

    let employees = [];
    if (!payrolls.length) {
      const Employee = require('../../models/Employee');
      employees = await Employee.find({ user: req.user._id, isDeleted: false })
        .populate('department', 'name code')
        .sort({ firstName: 1 })
        .lean();
    }

    const config = await getOrCreateConfig(req.user._id);
    const workbook = buildPayrollInputsWorkbook(payrolls, employees, config, month, year);
    sendWorkbook(res, workbook, `payroll-inputs-${year}-${String(month).padStart(2, '0')}.xlsx`);
  } catch (error) {
    console.error('Error exporting payroll inputs workbook:', error);
    res.status(500).json({ message: 'Server error exporting payroll inputs' });
  }
};

const exportPayrollExcel = async (req, res) => {
  try {
    if (req.query.type === 'inputs' || req.query.inputsOnly === 'true') {
      return await exportPayrollInputsExcel(req, res);
    }

    const month = Number(req.query.month);
    const year = Number(req.query.year);

    if (!isValidMonth(month) || !isValidYear(year)) {
      return res.status(400).json({ message: 'Valid month and year are required' });
    }

    const payrolls = await Payroll.find({ user: req.user._id, month, year })
      .populate({
        path: 'employee',
        select: 'firstName lastName employeeId email gender joiningDate dateOfLeaving location designation monthlyCTC bankDetails.ifscCode payType hourlyRate compensationType payFrequency attendanceMode useSalaryComponents',
      })
      .sort({ createdAt: 1 })
      .lean();

    const config = await getOrCreateConfig(req.user._id);
    const workbook = buildPayrollWorkbook(payrolls, config);
    sendWorkbook(res, workbook, `payroll-sheet-${year}-${String(month).padStart(2, '0')}.xlsx`);
  } catch (error) {
    console.error('Error exporting payroll workbook:', error);
    res.status(500).json({ message: 'Server error exporting payroll workbook' });
  }
};

const getPayrollTrend = async (req, res) => {
  try {
    const { endMonth, endYear, count = 6 } = req.query;
    const userId = req.user._id;

    const periods = [];
    let m = parseInt(endMonth), y = parseInt(endYear);
    for (let i = 0; i < parseInt(count); i++) {
      periods.push({ month: m, year: y });
      m--;
      if (m === 0) { m = 12; y--; }
    }
    periods.reverse();

    const results = await Payroll.aggregate([
      {
        $match: {
          user: new mongoose.Types.ObjectId(String(userId)),
          $or: periods.map(p => ({ month: p.month, year: p.year })),
          status: { $ne: 'cancelled' },
        }
      },
      {
        $group: {
          _id: { month: '$month', year: '$year' },
          total: { $sum: '$netSalary' },
        }
      }
    ]);

    const trend = periods.map(p => {
      const found = results.find(r => r._id.month === p.month && r._id.year === p.year);
      const label = `${new Date(0, p.month - 1).toLocaleString('en-US', { month: 'short' })} ${String(p.year).slice(-2)}`;
      return { label, total: found?.total || 0 };
    });

    res.json({ trend });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch trend data' });
  }
};

const getPayrollAuditLog = async (req, res) => {
  try {
    const payroll = await Payroll.findOne({ _id: req.params.id, user: req.user._id }).select('auditLog').lean();
    if (!payroll) return res.status(404).json({ message: 'Not found' });
    res.json({ auditLog: payroll.auditLog || [] });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch audit log' });
  }
};

module.exports = {
  buildPayrollWorkbook,
  buildPayrollInputsWorkbook,
  exportPayrollExcel,
  exportPayrollInputsExcel,
  getPayrollTrend,
  getPayrollAuditLog,
};

