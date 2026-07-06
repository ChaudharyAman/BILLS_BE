const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const Payroll = require('../models/Payroll');
const Employee = require('../models/Employee');
const Expense = require('../models/Expense');
const Category = require('../models/Category');
const Settings = require('../models/Settings');
const PayrollConfig = require('../models/PayrollConfig');
const Loan = require('../models/Loan');
const ReimbursementClaim = require('../models/ReimbursementClaim');
const AuditLog = require('../models/AuditLog');
const hrmsSyncService = require('../services/hrmsSyncService');
const { resolvePayrollRoleTemplate } = hrmsSyncService;
const {
  roundAmount,
  buildMasterSalaryStructure,
  buildPayrollSnapshot,
  getSalarySplits,
} = require('../utils/payrollMath');
const { XLSX, setHeaderStyle, applyNumberFormat, sendWorkbook } = require('../utils/excel');

const monthName = (month) => new Date(0, Number(month) - 1).toLocaleString('en-US', { month: 'long' });
const buildEmployeeName = (employee, snapshot) => {
  const first = employee?.firstName || snapshot?.firstName || '';
  const last = employee?.lastName || snapshot?.lastName || '';
  return `${first} ${last}`.trim() || 'Unknown Employee';
};
const isValidMonth = (month) => Number.isInteger(month) && month >= 1 && month <= 12;
const isValidYear = (year) => Number.isInteger(year) && year >= 1970 && year <= 3000;
const sumNamedAmounts = (items = []) => items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

const getOrCreateConfig = async (userId) => {
  let config = await PayrollConfig.findOne({ user: userId });
  if (!config) config = await PayrollConfig.create({ user: userId });
  return config;
};

const getPayrollCategory = async (userId) => Category.findOneAndUpdate(
  { user: userId, name: 'Payroll', type: 'expense' },
  {
    $setOnInsert: {
      user: userId,
      name: 'Payroll',
      type: 'expense',
      isSystem: true,
      color: '#2563eb',
      icon: 'FaUsers',
    },
  },
  { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
);

const shouldExcludeEmployeeFromRun = (employee) => employee.status !== 'active' || Boolean(employee.dateOfLeaving);

const shouldApplyJoiningBonus = (employee, month, year) => {
  if (!employee?.joiningDate || !Number(employee.joiningBonus)) return false;
  const joiningDate = new Date(employee.joiningDate);
  return joiningDate.getMonth() + 1 === month && joiningDate.getFullYear() === year;
};

const buildAttendancePayload = (payload = {}, defaultWorkingDays = 26) => {
  const workingDays = Math.max(Number(payload.workingDays) || defaultWorkingDays, 1);
  const paidLeaves = Math.max(Number(payload.paidLeaves) || 0, 0);
  const unpaidLeaves = Math.max(Number(payload.unpaidLeaves) || 0, 0);
  const paidDaysInput = payload.paidDays ?? payload.presentDays ?? workingDays - unpaidLeaves;
  const paidDays = Math.max(Math.min(Number(paidDaysInput) || 0, workingDays), 0);
  const hoursWorked = Number(payload.hoursWorked) || 0;

  return {
    workingDays,
    paidDays,
    paidLeaves,
    unpaidLeaves,
    hoursWorked,
  };
};

const buildAdjustmentsPayload = (employee, payload = {}, month, year) => {
  const adjustments = payload.adjustments && typeof payload.adjustments === 'object'
    ? { ...payload.adjustments }
    : {};

  if ((adjustments.joiningBonus === undefined || adjustments.joiningBonus === null) && shouldApplyJoiningBonus(employee, month, year)) {
    adjustments.joiningBonus = Number(employee.joiningBonus) || 0;
  }

  adjustments.otherEarnings = Array.isArray(adjustments.otherEarnings) ? adjustments.otherEarnings : [];
  adjustments.otherDeductions = Array.isArray(adjustments.otherDeductions) ? adjustments.otherDeductions : [];
  // Propagate PT state so buildPayrollSnapshot can compute the correct slab amount
  if (adjustments.ptState === undefined) {
    adjustments.ptState = employee.ptState || '';
  }
  return adjustments;
};

const buildPayrollWorkbook = (payrolls, config) => {
  const headerGroups = ['MASTER DATA', 'Monthly Salary', 'Other Payables', 'Deductions'];

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
    'Monthly CTC', `${basicName}(master)`, `${hraName}(master)`, `${flexiName}(master)`, 'PF Employer', `${specialName}`, 'DIFF',
    'Working Days', 'Paid Days', 'Hours Worked', 'Hourly Rate', `${basicName}(paid)`, `${hraName}(paid)`, `${flexiName}`, `${broadbandName}`, `${petrolName}`, `${ltaName}`, 'Employer NPS', 'Insurance',
    'PF(Emp Contrib)', 'Gratuity', 'LWF', 'GROSS TOTAL', 'Joining Bonus', 'Loyalty Bonus', 'Incentive', 'Other Allowance', 'Special Bonus', 'Total Payable',
    'PF Deduction', 'Insurance(ded)', 'Gratuity(ded)', 'LWF(ded)', 'Other Deduction', 'Income Tax', 'TOTAL DEDUCTION', 'NET TAKE HOME', 'Remarks',
  ];

  const rows = payrolls.map((payroll, index) => {
    const employee = payroll.employee || {};
    const payrollPaidRatio = Number(payroll.workingDays) > 0 ? Number(payroll.paidDays) / Number(payroll.workingDays) : 1;
    const safeRatio = payrollPaidRatio > 0 ? payrollPaidRatio : 1;
    const basicMaster = roundAmount((Number(payroll.earnings?.basic) || 0) / safeRatio);
    const hraMaster = roundAmount((Number(payroll.earnings?.hra) || 0) / safeRatio);
    const flexiMaster = roundAmount((Number(payroll.earnings?.flexiAmount) || 0) / safeRatio);
    const broadbandMaster = roundAmount((Number(payroll.earnings?.broadband) || 0) / safeRatio);
    const specialMaster = roundAmount((Number(payroll.earnings?.specialAllowance) || 0) / safeRatio);
    const employeeMonthlyCTC = Number(employee.monthlyCTC) || 0;
    const diff = roundAmount(
      employeeMonthlyCTC -
      basicMaster -
      hraMaster -
      flexiMaster -
      broadbandMaster -
      (Number(payroll.employerContributions?.pfEmployer) || 0) -
      specialMaster -
      (Number(payroll.earnings?.petrol) || 0) -
      (Number(payroll.earnings?.lta) || 0)
    );

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
      employeeMonthlyCTC,
      basicMaster,
      hraMaster,
      flexiMaster,
      Number(payroll.employerContributions?.pfEmployer) || 0,
      specialMaster,
      diff,
      Number(payroll.workingDays) || 0,
      Number(payroll.paidDays) || 0,
      payroll.payType === 'hourly' ? (Number(payroll.hoursWorked) || 0) : 0,
      payroll.payType === 'hourly' ? (Number(payroll.hourlyRate) || 0) : 0,
      Number(payroll.earnings?.basic) || 0,
      Number(payroll.earnings?.hra) || 0,
      Number(payroll.earnings?.flexiAmount) || 0,
      Number(payroll.earnings?.broadband) || 0,
      Number(payroll.earnings?.petrol) || 0,
      Number(payroll.earnings?.lta) || 0,
      Number(payroll.employerContributions?.nps) || 0,
      Number(payroll.employerContributions?.insuranceEmployer) || 0,
      Number(payroll.employerContributions?.pfEmployer) || 0,
      Number(payroll.employerContributions?.gratuity) || 0,
      Number(payroll.employerContributions?.lwfEmployer) || 0,
      Number(payroll.employerContributions?.grossTotalSalary) || 0,
      Number(payroll.variablePay?.joiningBonus) || 0,
      Number(payroll.variablePay?.loyaltyBonus) || 0,
      Number(payroll.variablePay?.incentive) || 0,
      sumNamedAmounts(payroll.earnings?.otherEarnings) + (Number(payroll.variablePay?.otherAllowanceArrear) || 0),
      Number(payroll.variablePay?.specialBonus) || 0,
      Number(payroll.totalPayable) || 0,
      Number(payroll.deductions?.pfEmployee) || 0,
      Number(payroll.deductions?.insuranceEmployee) || 0,
      Number(payroll.deductions?.gratuityDeduction) || 0,
      Number(payroll.deductions?.lwfEmployee) || 0,
      sumNamedAmounts(payroll.deductions?.otherDeductions),
      Number(payroll.deductions?.tds) || 0,
      Number(payroll.deductions?.totalDeductions) || 0,
      Number(payroll.netSalary) || 0,
      payroll.remarks || payroll.notes || '',
    ];
  });

  const totals = ['TOTAL', '', '', '', '', '', '', '', '', '', '', '', ''];
  for (let columnIndex = 13; columnIndex < columns.length; columnIndex += 1) {
    const total = rows.reduce((sum, row) => sum + (Number(row[columnIndex]) || 0), 0);
    totals[columnIndex] = total;
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
    XLSX.utils.decode_range('N1:AJ1'),
    XLSX.utils.decode_range('AK1:AP1'),
    XLSX.utils.decode_range('AQ1:AY1'),
  ];

  const headerCells = [];
  for (let i = 0; i < columns.length; i += 1) {
    headerCells.push(`${XLSX.utils.encode_col(i)}2`);
  }
  ['A1', 'N1', 'AK1', 'AQ1'].forEach((cell) => {
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
    for (let colIndex = 13; colIndex < columns.length - 1; colIndex += 1) {
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
const LeaveRequest = require('../models/LeaveRequest');
const LeaveType = require('../models/LeaveType');
const LeaveBalance = require('../models/LeaveBalance');

const getOverlapInfo = (startDate, endDate, month, year) => {
  const start = new Date(startDate);
  const end = new Date(endDate);

  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  const startOfMonth = new Date(year, month - 1, 1);
  const endOfMonth = new Date(year, month, 0);
  startOfMonth.setHours(0, 0, 0, 0);
  endOfMonth.setHours(0, 0, 0, 0);

  const totalCalendarMs = end.getTime() - start.getTime();
  const totalCalendarDays = Math.round(totalCalendarMs / (1000 * 60 * 60 * 24)) + 1;

  const overlapStart = new Date(Math.max(start.getTime(), startOfMonth.getTime()));
  const overlapEnd = new Date(Math.min(end.getTime(), endOfMonth.getTime()));
  overlapStart.setHours(0, 0, 0, 0);
  overlapEnd.setHours(0, 0, 0, 0);

  if (overlapStart > overlapEnd) {
    return { totalCalendarDays, calendarDaysInTargetMonth: 0 };
  }

  const overlapMs = overlapEnd.getTime() - overlapStart.getTime();
  const calendarDaysInTargetMonth = Math.round(overlapMs / (1000 * 60 * 60 * 24)) + 1;

  return { totalCalendarDays, calendarDaysInTargetMonth };
};

const autoDeriveLeavesForMonth = async (employeeId, month, year, userId) => {
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999);

  // Find all approved leave requests of the employee in the calendar year
  const allRequestsInYear = await LeaveRequest.find({
    employee: employeeId,
    user: userId,
    status: 'approved',
    startDate: { $lte: yearEnd },
    endDate: { $gte: yearStart }
  }).populate('leaveType').sort({ startDate: 1 });

  // Group requests by leaveType id
  const typeRequests = {};
  for (const req of allRequestsInYear) {
    if (!req.leaveType) continue;
    const typeId = String(req.leaveType._id);
    if (!typeRequests[typeId]) typeRequests[typeId] = [];
    typeRequests[typeId].push(req);
  }

  let calculatedUnpaidLeaves = 0;
  let calculatedPaidLeaves = 0;

  const leaveTypes = await LeaveType.find({ user: userId });
  for (const leaveType of leaveTypes) {
    const typeId = String(leaveType._id);
    const requests = typeRequests[typeId] || [];
    if (requests.length === 0) continue;

    if (!leaveType.isPaid) {
      // Unpaid leave - all days are LOP
      for (const req of requests) {
        const { totalCalendarDays, calendarDaysInTargetMonth } = getOverlapInfo(req.startDate, req.endDate, month, year);
        if (calendarDaysInTargetMonth > 0) {
          const ratio = calendarDaysInTargetMonth / totalCalendarDays;
          calculatedUnpaidLeaves += req.numberOfDays * ratio;
        }
      }
    } else {
      // Paid leave - chronological debiting
      const balance = await LeaveBalance.findOne({
        user: userId,
        employee: employeeId,
        leaveType: leaveType._id,
        year: year
      });

      const entitlement = balance
        ? (balance.opening + balance.accrued + balance.carriedForward)
        : leaveType.annualEntitlement;

      let cumulativeUsed = 0;
      for (const req of requests) {
        const requestDays = req.numberOfDays;
        let paidDaysForRequest = 0;
        let unpaidDaysForRequest = 0;

        if (cumulativeUsed + requestDays <= entitlement) {
          paidDaysForRequest = requestDays;
        } else if (cumulativeUsed < entitlement) {
          paidDaysForRequest = entitlement - cumulativeUsed;
          unpaidDaysForRequest = requestDays - paidDaysForRequest;
        } else {
          unpaidDaysForRequest = requestDays;
        }

        cumulativeUsed += requestDays;

        // Poration for current month
        const { totalCalendarDays, calendarDaysInTargetMonth } = getOverlapInfo(req.startDate, req.endDate, month, year);
        if (calendarDaysInTargetMonth > 0) {
          const ratio = calendarDaysInTargetMonth / totalCalendarDays;
          calculatedPaidLeaves += paidDaysForRequest * ratio;
          calculatedUnpaidLeaves += unpaidDaysForRequest * ratio;
        }
      }
    }
  }

  return {
    unpaidLeaves: Math.round(calculatedUnpaidLeaves * 100) / 100,
    paidLeaves: Math.round(calculatedPaidLeaves * 100) / 100
  };
};

exports.processPayroll = async (req, res) => {
  try {
    const month = Number(req.body.month);
    const year = Number(req.body.year);
    const employeePayloads = Array.isArray(req.body.employees) ? req.body.employees : [];
    const saveAsDraft = Boolean(req.body.saveAsDraft);

    if (!isValidMonth(month) || !isValidYear(year)) {
      return res.status(400).json({ message: 'Valid month and year are required' });
    }
    if (employeePayloads.length === 0) {
      return res.status(400).json({ message: 'Select at least one employee to process payroll' });
    }

    const config = await getOrCreateConfig(req.user._id);
    const settings = await Settings.findOne({ user: req.user._id });
    
    let hrmsAttendanceRecords = null;
    let hrmsSyncError = null;

    if (settings?.integration?.enabled) {
      try {
        hrmsAttendanceRecords = await hrmsSyncService.syncAttendanceFromExternal(req.user._id, month, year);
      } catch (err) {
        hrmsSyncError = err.message;
      }
    }

    const success = [];
    const errors = [];

    for (const payload of employeePayloads) {
      const employeeId = payload.employeeId || payload.employee;
      let employeeName = 'Unknown Employee';

      try {
        if (!mongoose.Types.ObjectId.isValid(String(employeeId))) {
          errors.push({ employeeId, error: 'Invalid employee ID format' });
          continue;
        }

        const employee = await Employee.findOne({ _id: employeeId, user: req.user._id });
        if (!employee) {
          errors.push({ employeeId, error: 'Employee not found' });
          continue;
        }

        employeeName = buildEmployeeName(employee);
        if (shouldExcludeEmployeeFromRun(employee)) {
          errors.push({ employeeId, employeeName, error: 'Employee is inactive or has a date of leaving set' });
          continue;
        }

        const existing = await Payroll.findOne({ user: req.user._id, employee: employeeId, month, year });
        if (existing) {
          if (existing.status !== 'draft') {
            errors.push({ employeeId, employeeName, error: 'Payroll already exists for this period' });
            continue;
          }
          // If it's a draft, delete it first so we can re-create/update it successfully
          await Payroll.deleteOne({ _id: existing._id });
        }

        let attendanceSource = payload.attendanceSource;
        let attendanceWarning = null;

        if (attendanceSource) {
          // Use the source explicitly set/sent by the frontend (e.g., 'hrms', 'manual', 'default')
        } else {
          // Precedence: manual overrides in request body take precedence
          const hasManualAttendance = 
            payload.workingDays !== undefined && payload.workingDays !== null ||
            payload.paidDays !== undefined && payload.paidDays !== null ||
            payload.unpaidLeaves !== undefined && payload.unpaidLeaves !== null ||
            payload.paidLeaves !== undefined && payload.paidLeaves !== null;

          if (hasManualAttendance) {
            attendanceSource = 'manual';
          } else if (settings?.integration?.enabled) {
            if (hrmsSyncError) {
              attendanceWarning = `HRMS attendance sync failed: ${hrmsSyncError}`;
              attendanceSource = 'default';
            } else if (hrmsAttendanceRecords) {
              const record = hrmsAttendanceRecords.find(r => 
                String(r.employeeId) === String(employee._id) || 
                String(r.employeeNumber).trim() === String(employee.employeeId).trim()
              );
              if (record) {
                payload.workingDays = record.workingDays;
                payload.paidDays = record.paidDays;
                payload.unpaidLeaves = record.unpaidLeaves;
                payload.paidLeaves = record.paidLeaves;
                attendanceSource = 'hrms';
              } else {
                attendanceWarning = `Employee attendance record not found in HRMS response.`;
                attendanceSource = 'default';
              }
            } else {
              attendanceWarning = `HRMS integration enabled but no records returned.`;
              attendanceSource = 'default';
            }
          } else {
            attendanceSource = 'default';
          }
        }

        // Fallbacks for default/failed sync (no leaves, default config working days)
        if (payload.unpaidLeaves === undefined) payload.unpaidLeaves = 0;
        if (payload.paidLeaves === undefined) payload.paidLeaves = 0;

        const attendance = buildAttendancePayload(payload, config.defaultWorkingDays);
        const adjustments = buildAdjustmentsPayload(employee, payload, month, year);

        // Fetch approved claims for this employee in the month & year
        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 1);
        const claims = await ReimbursementClaim.find({
          employee: employee._id,
          user: req.user._id,
          status: 'approved',
          createdAt: { $gte: startDate, $lt: endDate }
        }).lean();

        // If the request contains explicit adjustments.reimbursements (filtered on frontend)
        const reqReimbursements = payload.adjustments?.reimbursements;
        let finalClaims = claims;
        if (reqReimbursements !== undefined) {
          const includedIds = new Set(reqReimbursements.map(r => String(r._id || r.claimId)));
          finalClaims = claims.filter(c => includedIds.has(String(c._id)));
        }

        adjustments.reimbursements = finalClaims.map(c => ({
          _id: c._id,
          name: c.category,
          claimed: c.amount,
          approved: c.amount,
          billUrl: c.billUrl || ''
        }));

        // Calculate active loans' EMIs if not manually overridden
        if (adjustments.loanDeduction === undefined || adjustments.loanDeduction === null) {
          const activeLoans = await Loan.find({
            employee: employee._id,
            user: req.user._id,
            status: 'active',
            remainingBalance: { $gt: 0 }
          });
          adjustments.loanDeduction = activeLoans.reduce((sum, loan) => sum + Math.min(loan.emiAmount, loan.remainingBalance), 0);
        }

        const snapshot = buildPayrollSnapshot(employee, config, attendance, adjustments, month, year);
        const statusVal = saveAsDraft ? 'draft' : 'processed';

        const notesList = [];
        if (saveAsDraft) {
          notesList.push('Payroll initialized as draft');
        } else {
          notesList.push('Payroll calculated and processed');
        }
        if (attendanceWarning) {
          notesList.push(`[Warning] ${attendanceWarning}`);
        }

        const payroll = await Payroll.create({
          user: req.user._id,
          employee: employee._id,
          month,
          year,
          paymentDate: payload.paymentDate || null,
          workingDays: snapshot.workingDays,
          paidDays: snapshot.paidDays,
          paidLeaves: snapshot.paidLeaves,
          unpaidLeaves: snapshot.unpaidLeaves,
          attendanceSource,
          lop: snapshot.lop,
          hoursWorked: employee.payType === 'hourly' ? attendance.hoursWorked : 0,
          payType: employee.payType,
          hourlyRate: employee.payType === 'hourly' ? employee.hourlyRate : 0,
          earnings: snapshot.earnings,
          employerContributions: snapshot.employerContributions,
          variablePay: snapshot.variablePay,
          totalPayable: snapshot.totalPayable,
          deductions: snapshot.deductions,
          netSalary: snapshot.netSalary,
          status: statusVal,
          lopStrategy: adjustments.lopStrategy || 'proportional',
          overrides: {
            pfEnabled: payload.adjustments?.pfEnabled,
            esiEnabled: payload.adjustments?.esiEnabled,
            ptEnabled: payload.adjustments?.ptEnabled,
            lwfEnabled: payload.adjustments?.lwfEnabled,
            gratuityEnabled: payload.adjustments?.gratuityEnabled,
            includePfInCTC: payload.adjustments?.includePfInCTC,
            includeGratuityInCTC: payload.adjustments?.includeGratuityInCTC,
            basicPercent: payload.adjustments?.basicPercent,
            hraPercent: payload.adjustments?.hraPercent,
          },
          segmentLops: snapshot.segmentLops || adjustments.segmentLops || [],
          approvalWorkflow: [{
            status: statusVal,
            actor: req.user._id,
            remarks: notesList.join('. ')
          }],
          employeeSnapshot: {
            employeeId: employee.employeeId,
            firstName: employee.firstName,
            lastName: employee.lastName,
            email: employee.email,
            designation: employee.designation,
            joiningDate: employee.joiningDate,
            monthlyCTC: snapshot.master.monthlyCTC,
            pfEnabled: snapshot.master.pfEnabled !== false,
            esiEnabled: snapshot.master.esiEnabled !== false,
            ptEnabled: snapshot.master.ptEnabled !== false,
            ptState: employee.ptState || '',
            lwfEnabled: snapshot.master.lwfEnabled !== false,
            gratuityEnabled: snapshot.master.gratuityEnabled !== false,
            includePfInCTC: snapshot.master.includePfInCTC !== false,
            includeGratuityInCTC: snapshot.master.includeGratuityInCTC !== false,
            useSalaryComponents: snapshot.master.useSalaryComponents !== false,
            basicPercent: snapshot.master.basicPercent,
            hraPercent: snapshot.master.hraPercent,
            taxRegime: employee.taxRegime,
            declarations: employee.declarations,
          },
          paymentMethod: payload.paymentMethod || '',
          transactionId: payload.transactionId || '',
          notes: payload.notes || '',
          remarks: payload.remarks || '',
          reimbursements: snapshot.reimbursements,
          totalReimbursementApproved: snapshot.totalReimbursementApproved,
          auditLog: [{
            status: statusVal,
            changedBy: req.user.name,
            changedById: req.user._id,
            changedAt: new Date(),
            netSalary: snapshot.netSalary,
            notes: notesList.join('. ')
          }]
        });

        await AuditLog.create({
          user: req.user._id,
          actor: req.user._id,
          action: saveAsDraft ? 'PAYROLL_DRAFT_CREATED' : 'PAYROLL_PROCESSED',
          targetEmployee: employee._id,
          targetPayroll: payroll._id,
          changes: { toStatus: statusVal }
        });

        success.push({
          payrollId: payroll._id,
          employeeId: employee._id,
          employeeName,
          status: payroll.status,
          payroll: {
            earnings: payroll.earnings,
            employerContributions: payroll.employerContributions,
            variablePay: payroll.variablePay,
            deductions: payroll.deductions,
            totalPayable: payroll.totalPayable,
            netSalary: payroll.netSalary,
            paidDays: payroll.paidDays,
            workingDays: payroll.workingDays,
            lop: payroll.lop,
          },
        });
      } catch (error) {
        console.error(`Error processing payroll for employee ${employeeId}:`, error);
        errors.push({ employeeId, employeeName, error: error.message });
      }
    }

    res.status(201).json({ success, errors });
  } catch (error) {
    console.error('Error processing payroll:', error);
    res.status(500).json({ message: 'Server error processing payroll' });
  }
};

exports.bulkApprovePayroll = async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((id) => mongoose.Types.ObjectId.isValid(String(id))) : [];
    const month = req.body.month !== undefined ? Number(req.body.month) : undefined;
    const year = req.body.year !== undefined ? Number(req.body.year) : undefined;
    const filter = { user: req.user._id, status: 'processed' };

    if (ids.length) filter._id = { $in: ids };
    if (month !== undefined) {
      if (!isValidMonth(month)) return res.status(400).json({ message: 'Valid month is required' });
      filter.month = month;
    }
    if (year !== undefined) {
      if (!isValidYear(year)) return res.status(400).json({ message: 'Valid year is required' });
      filter.year = year;
    }
    if (!ids.length && (month === undefined || year === undefined)) {
      return res.status(400).json({ message: 'Provide payroll IDs or month and year to approve payroll' });
    }

    const payrolls = await Payroll.find(filter);
    let approvedCount = 0;

    for (const payroll of payrolls) {
      const oldStatus = payroll.status;
      payroll.status = 'approved';
      payroll.approvalWorkflow.push({
        status: 'approved',
        actor: req.user._id,
        remarks: req.body.remarks || 'Bulk approved',
      });
      await payroll.save();

      await Payroll.updateOne(
        { _id: payroll._id },
        { $push: { auditLog: {
          status: 'approved',
          changedBy: req.user.name,
          changedById: req.user._id,
          changedAt: new Date(),
          netSalary: payroll.netSalary,
          notes: req.body.remarks || 'Bulk approved'
        }}}
      );

      await AuditLog.create({
        user: req.user._id,
        actor: req.user._id,
        action: 'PAYROLL_APPROVED',
        targetEmployee: payroll.employee,
        targetPayroll: payroll._id,
        changes: { from: oldStatus, to: 'approved' },
      });

      approvedCount += 1;
    }

    res.json({
      matched: payrolls.length,
      modified: approvedCount,
      message: 'Payroll approved successfully',
    });
  } catch (error) {
    console.error('Error approving payroll in bulk:', error);
    res.status(500).json({ message: 'Server error approving payroll' });
  }
};

exports.getPayrollConfig = async (req, res) => {
  try {
    const config = await getOrCreateConfig(req.user._id);
    res.json(config);
  } catch (error) {
    console.error('Error fetching payroll config:', error);
    res.status(500).json({ message: 'Server error fetching payroll config' });
  }
};

exports.updatePayrollConfig = async (req, res) => {
  try {
    if (req.body.salaryComponents !== undefined) {
      const components = Array.isArray(req.body.salaryComponents) ? req.body.salaryComponents : [];
      
      const remainderComps = components.filter(c => c.linkedTo === 'remainder');
      if (remainderComps.length > 1) {
        return res.status(400).json({
          message: `Only one salary component can be linked to 'Remainder'. Found: ${remainderComps.map(c => c.name || 'Unnamed').join(', ')}`
        });
      }

      const names = new Set();
      for (const c of components) {
        const trimmedName = (c.name || '').trim();
        if (!trimmedName) {
          return res.status(400).json({ message: 'Component name cannot be empty' });
        }
        const lowerName = trimmedName.toLowerCase();
        if (names.has(lowerName)) {
          return res.status(400).json({ message: `Component name "${trimmedName}" is duplicated. All component names must be unique.` });
        }
        names.add(lowerName);
      }

      const hasBasic = components.some(c => c.id === 'basic');
      const hasHra = components.some(c => c.id === 'hra');
      if (!hasBasic || !hasHra) {
        return res.status(400).json({ message: 'Basic Salary and HRA are core components and must be present.' });
      }
    }

    const allowed = [
      'basicPercent', 'hraPercent', 'pfRate', 'pfCap', 'pfEmployerRate',
      'esiEmployeeRate', 'esiEmployerRate', 'esiBasicThreshold', 'lwfEmployer', 'lwfEmployee',
      'gratuityRate', 'defaultWorkingDays', 'defaultInsurance', 'ltaMaxPercent', 'salaryComponents',
      'pfCalculationType', 'pfAmountEmployee', 'pfAmountEmployer',
    ];
    const update = {};
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    });

    const config = await PayrollConfig.findOneAndUpdate(
      { user: req.user._id },
      { $set: update },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    res.json(config);
  } catch (error) {
    console.error('Error updating payroll config:', error);
    res.status(500).json({ message: 'Server error updating payroll config' });
  }
};

exports.calculateSalary = async (req, res) => {
  try {
    const config = await getOrCreateConfig(req.user._id);
    let monthlyCTC = Number(req.body.monthlyCTC) || (Number(req.body.annualCTC) ? Number(req.body.annualCTC) / 12 : 0);
    const payType = req.body.payType || 'salaried';
    const hourlyRate = Number(req.body.hourlyRate) || 0;
    const hoursWorked = req.body.hoursWorked !== undefined ? Number(req.body.hoursWorked) : 160;

    if (payType === 'hourly') {
      monthlyCTC = hourlyRate * hoursWorked;
    }

    if (payType !== 'hourly' && (!monthlyCTC || monthlyCTC < 0)) {
      return res.status(400).json({ message: 'Monthly CTC or Annual CTC is required' });
    }

    const previewSource = {
      monthlyCTC,
      payType,
      hourlyRate,
      hoursWorked,
      employmentType: req.body.employmentType,
      useSalaryComponents: req.body.useSalaryComponents !== false && payType !== 'hourly',
      basicPercent: req.body.basicPercent !== undefined && req.body.basicPercent !== null ? Number(req.body.basicPercent) : null,
      hraPercent: req.body.hraPercent !== undefined && req.body.hraPercent !== null ? Number(req.body.hraPercent) : null,
      basic: req.body.basic !== undefined ? Number(req.body.basic) : undefined,
      hra: req.body.hra !== undefined ? Number(req.body.hra) : undefined,
      specialAllowance: req.body.specialAllowance !== undefined ? Number(req.body.specialAllowance) : undefined,
      flexiAmount: Number(req.body.flexiAmount) || 0,
      broadband: Number(req.body.broadband) || 0,
      petrol: Number(req.body.petrol) || 0,
      lta: Number(req.body.lta) || 0,
      employerNPS: Number(req.body.employerNPS) || 0,
      insuranceAmount: req.body.insuranceAmount !== undefined ? Number(req.body.insuranceAmount) : config.defaultInsurance,
      taxRegime: req.body.taxRegime || 'new',
      pfEnabled: payType === 'hourly' ? false : req.body.pfEnabled !== false,
      esiEnabled: payType === 'hourly' ? false : req.body.esiEnabled !== false,
      ptEnabled: payType === 'hourly' ? false : req.body.ptEnabled !== false,
      lwfEnabled: payType === 'hourly' ? false : req.body.lwfEnabled !== false,
      gratuityEnabled: payType === 'hourly' ? false : req.body.gratuityEnabled !== false,
      includePfInCTC: payType === 'hourly' ? false : req.body.includePfInCTC === true,
      includeGratuityInCTC: payType === 'hourly' ? false : req.body.includeGratuityInCTC !== false,
      declarations: req.body.declarations || {},
      deductions: {
        professionalTax: payType === 'hourly' ? 0 : (Number(req.body.professionalTax) || 0),
        tds: Number(req.body.tds) || 0,
        otherDeductions: Array.isArray(req.body.otherDeductions) ? req.body.otherDeductions : (Array.isArray(req.body.deductions?.otherDeductions) ? req.body.deductions.otherDeductions : []),
      },
      salaryStructure: {
        conveyance: Number(req.body.conveyance) || 0,
        medicalAllowance: Number(req.body.medicalAllowance) || 0,
        otherAllowances: Array.isArray(req.body.otherAllowances) ? req.body.otherAllowances : (Array.isArray(req.body.salaryStructure?.otherAllowances) ? req.body.salaryStructure.otherAllowances : []),
      },
    };

    const master = buildMasterSalaryStructure(previewSource, config);
    const month = Number(req.body.month) || (new Date().getMonth() + 1);
    const year = Number(req.body.year) || new Date().getFullYear();
    const snapshot = buildPayrollSnapshot(
      previewSource,
      config,
      { workingDays: config.defaultWorkingDays, paidDays: config.defaultWorkingDays, paidLeaves: 0, unpaidLeaves: 0 },
      {
        joiningBonus: Number(req.body.joiningBonus) || 0,
        loyaltyBonus: Number(req.body.loyaltyBonus) || 0,
        incentive: Number(req.body.incentive) || 0,
        specialBonus: Number(req.body.specialBonus) || 0,
        otherAllowanceArrear: Number(req.body.otherAllowanceArrear) || 0,
        tds: Number(req.body.tds) || 0,
        performanceBonus: Number(req.body.performanceBonus) || 0,
        retentionBonus: Number(req.body.retentionBonus) || 0,
        arrear: Number(req.body.arrear) || 0,
        referralBonus: Number(req.body.referralBonus) || 0,
      },
      month,
      year
    );

    res.json({
      monthlyCTC: master.monthlyCTC,
      annualCTC: roundAmount(master.monthlyCTC * 12),
      master,
      payroll: snapshot,
      annualized: {
        earnings: Object.fromEntries(Object.entries(snapshot.earnings).map(([key, value]) => [key, typeof value === 'number' ? roundAmount(value * 12) : value])),
        employerContributions: Object.fromEntries(Object.entries(snapshot.employerContributions).map(([key, value]) => [key, roundAmount((Number(value) || 0) * 12)])),
        deductions: Object.fromEntries(Object.entries(snapshot.deductions).map(([key, value]) => [key, typeof value === 'number' ? roundAmount(value * 12) : value])),
        netSalary: roundAmount(snapshot.netSalary * 12),
      },
    });
  } catch (error) {
    console.error('Error calculating salary:', error);
    res.status(500).json({ message: 'Server error calculating salary' });
  }
};

exports.exportPayrollExcel = async (req, res) => {
  try {
    const month = Number(req.query.month);
    const year = Number(req.query.year);

    if (!isValidMonth(month) || !isValidYear(year)) {
      return res.status(400).json({ message: 'Valid month and year are required' });
    }

    const payrolls = await Payroll.find({ user: req.user._id, month, year })
      .populate({
        path: 'employee',
        select: '+bankDetails.accountNumber +panNumber +aadharNumber firstName lastName employeeId email gender joiningDate dateOfLeaving location designation monthlyCTC bankDetails.ifscCode payType hourlyRate',
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

exports.getPayrolls = async (req, res) => {
  try {
    const { month, year, status, employeeId } = req.query;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const skip = (page - 1) * limit;
    const query = { user: req.user._id };

    if (month !== undefined) {
      const parsedMonth = Number(month);
      if (!isValidMonth(parsedMonth)) return res.status(400).json({ message: 'Invalid month' });
      query.month = parsedMonth;
    }
    if (year !== undefined) {
      const parsedYear = Number(year);
      if (!isValidYear(parsedYear)) return res.status(400).json({ message: 'Invalid year' });
      query.year = parsedYear;
    }
    if (status) query.status = status;
    if (employeeId) {
      if (!mongoose.Types.ObjectId.isValid(String(employeeId))) {
        return res.status(400).json({ message: 'Invalid employee ID' });
      }
      query.employee = employeeId;
    }
    if (req.query.search) {
      const escapeRegex = require('../utils/escapeRegex');
      const safeSearch = escapeRegex(req.query.search);
      const matchedEmployees = await Employee.find({
        user: req.user._id,
        $or: [
          { firstName: { $regex: safeSearch, $options: 'i' } },
          { lastName: { $regex: safeSearch, $options: 'i' } },
          { employeeId: { $regex: safeSearch, $options: 'i' } }
        ]
      }).select('_id').lean();
      
      const matchedIds = matchedEmployees.map(e => e._id);
      if (query.employee) {
        if (!matchedIds.map(id => String(id)).includes(String(query.employee))) {
          query.employee = null;
        }
      } else {
        query.employee = { $in: matchedIds };
      }
    }

    const total = await Payroll.countDocuments(query);
    const payrolls = await Payroll.find(query)
      .populate({
        path: 'employee',
        select: 'employeeId firstName lastName designation department monthlyCTC location dateOfLeaving pfEnabled esiEnabled ptEnabled lwfEnabled gratuityEnabled basicPercent hraPercent payType hourlyRate',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('expenseRef', 'expenseNumber date grandTotal')
      .sort({ year: -1, month: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({ data: payrolls, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    console.error('Error fetching payrolls:', error);
    res.status(500).json({ message: 'Server error fetching payrolls' });
  }
};

exports.getPayrollById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    const payroll = await Payroll.findOne({ _id: req.params.id, user: req.user._id })
      .populate({
        path: 'employee',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('expenseRef', 'expenseNumber date grandTotal');

    if (!payroll) return res.status(404).json({ message: 'Payroll not found' });

    const config = await getOrCreateConfig(req.user._id);
    const adjustments = {
      pfEnabled: payroll.employeeSnapshot?.pfEnabled,
      esiEnabled: payroll.employeeSnapshot?.esiEnabled,
      ptEnabled: payroll.employeeSnapshot?.ptEnabled,
      lwfEnabled: payroll.employeeSnapshot?.lwfEnabled,
      gratuityEnabled: payroll.employeeSnapshot?.gratuityEnabled,
      includePfInCTC: payroll.employeeSnapshot?.includePfInCTC,
      includeGratuityInCTC: payroll.employeeSnapshot?.includeGratuityInCTC,
      lopStrategy: payroll.lopStrategy || 'proportional',
      segmentLops: payroll.segmentLops || [],
    };
    const employeeData = payroll.employee || {
      ...payroll.employeeSnapshot,
      payType: payroll.payType,
      hourlyRate: payroll.hourlyRate,
      _id: payroll.populated('employee') || payroll.employee
    };
    const splits = getSalarySplits(
      employeeData,
      config,
      payroll.month,
      payroll.year,
      payroll.paidDays,
      payroll.workingDays,
      adjustments
    );

    const payrollObj = payroll.toObject();
    payrollObj.salarySplits = splits;
    if (!payrollObj.employee) {
      payrollObj.employee = employeeData;
    }

    res.json(payrollObj);
  } catch (error) {
    console.error('Error fetching payroll:', error);
    res.status(500).json({ message: 'Server error fetching payroll' });
  }
};

exports.updatePayroll = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    const payroll = await Payroll.findOne({ _id: req.params.id, user: req.user._id });
    if (!payroll) return res.status(404).json({ message: 'Payroll not found' });

    if (payroll.status === 'paid') {
      return res.status(400).json({ message: 'Paid payroll is locked and cannot be updated' });
    }
    if (payroll.status === 'approved') {
      const allowedFieldsForApproved = ['paymentMethod', 'transactionId', 'notes', 'remarks', 'status', 'paymentDate'];
      const fieldsToUpdate = Object.keys(req.body);
      const isTryingToEditRestrictedFields = fieldsToUpdate.some(f => !allowedFieldsForApproved.includes(f));
      if (isTryingToEditRestrictedFields) {
        return res.status(400).json({ message: 'Approved payroll is locked. Please re-open to edit calculations' });
      }
    }

    const allowed = ['paymentDate', 'paymentMethod', 'transactionId', 'notes', 'remarks', 'status'];
    const updateData = {};
    const oldStatus = payroll.status;

    allowed.forEach((field) => {
      if (req.body[field] !== undefined) {
        payroll[field] = req.body[field];
        updateData[field] = req.body[field];
      }
    });

    if (req.body.status && req.body.status !== oldStatus) {
      payroll.approvalWorkflow.push({
        status: req.body.status,
        actor: req.user._id,
        remarks: req.body.remarks || `Status transitioned to ${req.body.status}`
      });
    }

    await payroll.save();

    if (req.body.status && req.body.status !== oldStatus) {
      await Payroll.updateOne(
        { _id: payroll._id },
        { $push: { auditLog: {
          status: req.body.status,
          changedBy: req.user.name,
          changedById: req.user._id,
          changedAt: new Date(),
          netSalary: payroll.netSalary,
          notes: req.body.remarks || `Status transitioned to ${req.body.status}`
        }}}
      );
    }
    await payroll.populate('employee', 'employeeId firstName lastName designation');

    await AuditLog.create({
      user: req.user._id,
      actor: req.user._id,
      action: 'PAYROLL_UPDATED',
      targetEmployee: payroll.employee?._id || payroll.employee,
      targetPayroll: payroll._id,
      changes: updateData
    });

    res.json(payroll);
  } catch (error) {
    console.error('Error updating payroll:', error);
    res.status(500).json({ message: 'Server error updating payroll' });
  }
};

exports.markPayrollAsPaid = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    const payroll = await Payroll.findOne({ _id: req.params.id, user: req.user._id }).populate('employee');
    if (!payroll) return res.status(404).json({ message: 'Payroll not found' });
    if (payroll.status === 'paid') return res.status(400).json({ message: 'Payroll is already paid' });

    const payrollCategory = await getPayrollCategory(req.user._id);
    const paymentDate = req.body.paymentDate || new Date();
    const employeeIdentifier = payroll.employee?.employeeId || payroll.employeeSnapshot?.employeeId || (payroll.populated('employee') || payroll._id).toString();
    const expenseNumber = `PAY-${payroll.year}-${String(payroll.month).padStart(2, '0')}-${employeeIdentifier}`;
    let expense = null;
    if (payroll.expenseRef) {
      expense = await Expense.findOne({ _id: payroll.expenseRef, user: req.user._id });
    }

    // Fallback: if expenseRef was not saved (e.g. a previous attempt failed mid-way),
    // look up by the deterministic expenseNumber to avoid a duplicate key error.
    if (!expense) {
      expense = await Expense.findOne({ user: req.user._id, expenseNumber });
    }

    if (!expense) {
      expense = await Expense.create({
        user: req.user._id,
        expenseNumber,
        category: payrollCategory._id,
        date: paymentDate,
        vendor: { name: buildEmployeeName(payroll.employee, payroll.employeeSnapshot) || 'Payroll Vendor' },
        paymentMethod: req.body.paymentMethod || 'Bank Transfer',
        items: [{
          name: `Salary - ${buildEmployeeName(payroll.employee, payroll.employeeSnapshot)}`.trim(),
          description: `${monthName(payroll.month)} ${payroll.year}`,
          qty: 1,
          rate: payroll.netSalary,
          taxRate: 0,
          taxAmount: 0,
          amount: payroll.netSalary,
        }],
        subTotal: payroll.netSalary,
        taxTotal: 0,
        grandTotal: payroll.netSalary,
        amountPaid: payroll.netSalary,
        balanceDue: 0,
        status: 'PAID',
        privateNotes: `Payroll ID: ${payroll._id}`,
      });
    }

    payroll.status = 'paid';
    payroll.paymentDate = paymentDate;
    payroll.paymentMethod = req.body.paymentMethod || payroll.paymentMethod || 'Bank Transfer';
    payroll.transactionId = req.body.transactionId || payroll.transactionId;
    payroll.expenseRef = expense._id;

    payroll.approvalWorkflow.push({
      status: 'paid',
      actor: req.user._id,
      remarks: req.body.remarks || 'Payroll marked as paid and expense generated'
    });

    // Repay active loans if loanDeduction > 0
    if (payroll.deductions?.loanDeduction > 0) {
      const activeLoans = await Loan.find({
        employee: payroll.employee?._id || payroll.populated('employee') || payroll.employee,
        user: req.user._id,
        status: 'active',
        remainingBalance: { $gt: 0 }
      });

      let remainingDeduction = payroll.deductions.loanDeduction;
      for (const loan of activeLoans) {
        if (remainingDeduction <= 0) break;
        const repaymentAmount = Math.min(loan.remainingBalance, loan.emiAmount, remainingDeduction);
        if (repaymentAmount > 0) {
          loan.remainingBalance = Math.max(0, roundAmount(loan.remainingBalance - repaymentAmount));
          if (loan.remainingBalance === 0) {
            loan.status = 'closed';
          }
          loan.repaymentLedger.push({
            month: payroll.month,
            year: payroll.year,
            amountPaid: repaymentAmount,
            payrollRef: payroll._id
          });
          await loan.save();
          remainingDeduction = roundAmount(remainingDeduction - repaymentAmount);
        }
      }
    }

    await payroll.save();

    await Payroll.updateOne(
      { _id: payroll._id },
      { $push: { auditLog: {
        status: 'paid',
        changedBy: req.user.name,
        changedById: req.user._id,
        changedAt: new Date(),
        netSalary: payroll.netSalary,
        notes: req.body.remarks || 'Payroll marked as paid and expense generated'
      }}}
    );

    await AuditLog.create({
      user: req.user._id,
      actor: req.user._id,
      action: 'PAYROLL_PAID',
      targetEmployee: payroll.employee?._id || payroll.populated('employee') || payroll.employee,
      targetPayroll: payroll._id,
      changes: { status: 'paid', paymentDate, expenseId: expense._id }
    });

    res.json({ payroll, expense });
  } catch (error) {
    console.error('Error marking payroll as paid:', error);
    // Handle concurrent double-submit: if the expense was just created by a parallel
    // request (race condition), re-fetch it and link it so the payroll is still saved.
    if (error.code === 11000) {
      try {
        const payroll = await Payroll.findOne({ _id: req.params.id, user: req.user._id });
        if (payroll && payroll.status !== 'paid') {
          const employeeIdentifier =
            payroll.employeeSnapshot?.employeeId ||
            payroll.employee?.toString() ||
            payroll._id.toString();
          const expenseNumber = `PAY-${payroll.year}-${String(payroll.month).padStart(2, '0')}-${employeeIdentifier}`;
          const expense = await Expense.findOne({ user: req.user._id, expenseNumber });
          if (expense) {
            payroll.status = 'paid';
            payroll.paymentDate = req.body.paymentDate || new Date();
            payroll.paymentMethod = req.body.paymentMethod || payroll.paymentMethod || 'Bank Transfer';
            payroll.transactionId = req.body.transactionId || payroll.transactionId;
            payroll.expenseRef = expense._id;

            payroll.approvalWorkflow.push({
              status: 'paid',
              actor: req.user._id,
              remarks: req.body.remarks || 'Payroll marked as paid and expense generated (recovered)'
            });

            // Repay active loans if loanDeduction > 0
            if (payroll.deductions?.loanDeduction > 0) {
              const activeLoans = await Loan.find({
                employee: payroll.employee?._id || payroll.populated('employee') || payroll.employee,
                user: req.user._id,
                status: 'active',
                remainingBalance: { $gt: 0 }
              });

              let remainingDeduction = payroll.deductions.loanDeduction;
              for (const loan of activeLoans) {
                if (remainingDeduction <= 0) break;
                const repaymentAmount = Math.min(loan.remainingBalance, loan.emiAmount, remainingDeduction);
                if (repaymentAmount > 0) {
                  loan.remainingBalance = Math.max(0, roundAmount(loan.remainingBalance - repaymentAmount));
                  if (loan.remainingBalance === 0) {
                    loan.status = 'closed';
                  }
                  loan.repaymentLedger.push({
                    month: payroll.month,
                    year: payroll.year,
                    amountPaid: repaymentAmount,
                    payrollRef: payroll._id
                  });
                  await loan.save();
                  remainingDeduction = roundAmount(remainingDeduction - repaymentAmount);
                }
              }
            }

            await payroll.save();

            await Payroll.updateOne(
              { _id: payroll._id },
              { $push: { auditLog: {
                status: 'paid',
                changedBy: req.user.name,
                changedById: req.user._id,
                changedAt: new Date(),
                netSalary: payroll.netSalary,
                notes: req.body.remarks || 'Payroll marked as paid and expense generated (recovered)'
              }}}
            );

            await AuditLog.create({
              user: req.user._id,
              actor: req.user._id,
              action: 'PAYROLL_PAID',
              targetEmployee: payroll.employee?._id || payroll.populated('employee') || payroll.employee,
              targetPayroll: payroll._id,
              changes: { status: 'paid', paymentDate: payroll.paymentDate, expenseId: expense._id }
            });

            return res.json({ payroll, expense });
          }
        }
      } catch (retryError) {
        console.error('Error in 11000 recovery:', retryError);
      }
      return res.status(409).json({ message: 'Payroll payment is already being processed. Please refresh and check the status.' });
    }
    res.status(500).json({ message: 'Server error marking payroll as paid' });
  }
};

exports.generatePayslip = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    const payroll = await Payroll.findOne({ _id: req.params.id, user: req.user._id })
      .populate({
        path: 'employee',
        select: '+uanNumber +panNumber +aadharNumber +esiNumber +bankDetails.accountNumber +pfNumber +pfNo',
        populate: { path: 'department', select: 'name code' },
      });
    const settings = await Settings.findOne({ user: req.user._id }).lean();

    if (!payroll) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    // Guard: employee may have been deleted after payroll was created
    if (!payroll.employee && !payroll.employeeSnapshot) {
      return res.status(404).json({ message: 'Employee record no longer exists for this payroll' });
    }

    const config = await getOrCreateConfig(req.user._id);
    const adjustments = {
      pfEnabled: payroll.employeeSnapshot?.pfEnabled,
      esiEnabled: payroll.employeeSnapshot?.esiEnabled,
      ptEnabled: payroll.employeeSnapshot?.ptEnabled,
      ptState: payroll.employeeSnapshot?.ptState || '',
      lwfEnabled: payroll.employeeSnapshot?.lwfEnabled,
      gratuityEnabled: payroll.employeeSnapshot?.gratuityEnabled,
      includePfInCTC: payroll.employeeSnapshot?.includePfInCTC,
      includeGratuityInCTC: payroll.employeeSnapshot?.includeGratuityInCTC,
      lopStrategy: payroll.lopStrategy || 'proportional',
      segmentLops: payroll.segmentLops || [],
    };
    const employeeData = payroll.employee || {
      ...payroll.employeeSnapshot,
      payType: payroll.payType,
      hourlyRate: payroll.hourlyRate,
      _id: payroll.populated('employee') || payroll.employee
    };
    const splits = getSalarySplits(
      employeeData,
      config,
      payroll.month,
      payroll.year,
      payroll.paidDays,
      payroll.workingDays,
      adjustments
    );

    // --- Build Tax Worksheet for the Financial Year ---
    const currentMonth = payroll.month;
    const currentYear = payroll.year;
    let startYear, endYear;
    if (currentMonth >= 4) {
      startYear = currentYear;
      endYear = currentYear + 1;
    } else {
      startYear = currentYear - 1;
      endYear = currentYear;
    }

    const fyPayrolls = await Payroll.find({
      user: req.user._id,
      employee: employeeData._id,
      $or: [
        { year: startYear, month: { $gte: 4 } },
        { year: endYear, month: { $lte: 3 } }
      ]
    }).sort({ year: 1, month: 1 });

    let basicGross = 0;
    let hraGross = 0;
    let specialGross = 0;
    let mealGross = 0;
    let broadbandGross = 0;
    let otherGross = 0;
    let bonusGross = 0;
    let arrearGross = 0;

    const tdsMonths = {
      4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0, 1: 0, 2: 0, 3: 0
    };

    for (const pr of fyPayrolls) {
      basicGross += Number(pr.earnings?.basic || 0);
      hraGross += Number(pr.earnings?.hra || 0);
      specialGross += Number(pr.earnings?.specialAllowance || pr.earnings?.special || 0);
      mealGross += Number(pr.earnings?.mealAllowance || pr.earnings?.meal || 0);
      broadbandGross += Number(pr.earnings?.broadband || 0);
      
      let otherVal = Number(pr.earnings?.petrol || 0) + 
                     Number(pr.earnings?.lta || 0) + 
                     Number(pr.earnings?.conveyance || 0) + 
                     Number(pr.earnings?.medicalAllowance || 0);
      if (Array.isArray(pr.earnings?.otherEarnings)) {
        otherVal += pr.earnings.otherEarnings.reduce((s, o) => s + (Number(o.amount) || 0), 0);
      }
      otherGross += otherVal;

      let bonusVal = 0;
      if (pr.variablePay) {
        bonusVal += Number(pr.variablePay.joiningBonus || 0) +
                    Number(pr.variablePay.loyaltyBonus || 0) +
                    Number(pr.variablePay.incentive || 0) +
                    Number(pr.variablePay.specialBonus || 0) +
                    Number(pr.variablePay.otherAllowanceArrear || 0);
      }
      bonusGross += bonusVal;

      if (pr.deductions?.tds) {
        tdsMonths[pr.month] = Number(pr.deductions.tds) || 0;
      }
    }

    const regime = employeeData.taxRegime || 'new';
    const isOld = regime === 'old';
    const standardDeduction = isOld ? 50000 : 75000;

    const rentPaidMonthly = employeeData.declarations?.rentPaidMonthly || 0;
    const monthsCount = fyPayrolls.length || 1;
    const rentPaidTotal = rentPaidMonthly * monthsCount;
    const basic_10 = basicGross * 0.1;
    const rentMinusBasic10 = Math.max(0, rentPaidTotal - basic_10);
    const isMetro = employeeData.declarations?.isMetroCity || false;
    const basicPercent = basicGross * (isMetro ? 0.5 : 0.4);
    const exemptHra = isOld ? Math.round(Math.min(hraGross, rentMinusBasic10, basicPercent)) : 0;

    const componentBreakdown = [
      { name: 'Basic', gross: basicGross, exempt: 0, taxable: basicGross },
      { name: 'HRA', gross: hraGross, exempt: exemptHra, taxable: hraGross - exemptHra },
      { name: 'Special All', gross: specialGross, exempt: 0, taxable: specialGross },
      { name: 'Meal', gross: mealGross, exempt: 0, taxable: mealGross },
      { name: 'Broadband', gross: broadbandGross, exempt: 0, taxable: broadbandGross },
      { name: 'Other', gross: otherGross, exempt: 0, taxable: otherGross },
      { name: 'Bonus', gross: bonusGross, exempt: 0, taxable: bonusGross },
      { name: 'Arrear', gross: arrearGross, exempt: 0, taxable: arrearGross }
    ];

    const grossSalary = basicGross + hraGross + specialGross + mealGross + broadbandGross + otherGross + bonusGross + arrearGross;
    const taxableIncome = Math.max(0, grossSalary - exemptHra - standardDeduction);

    let totalTax = 0;
    if (regime === 'new') {
      let temp = taxableIncome;
      if (temp > 2000000) {
        totalTax += (temp - 2000000) * 0.3;
        temp = 2000000;
      }
      if (temp > 1600000) {
        totalTax += (temp - 1600000) * 0.2;
        temp = 1600000;
      }
      if (temp > 1200000) {
        totalTax += (temp - 1200000) * 0.15;
        temp = 1200000;
      }
      if (temp > 800000) {
        totalTax += (temp - 800000) * 0.1;
        temp = 800000;
      }
      if (temp > 400000) {
        totalTax += (temp - 400000) * 0.05;
      }
      if (taxableIncome <= 700000) {
        totalTax = 0;
      }
    } else {
      let temp = taxableIncome;
      if (temp > 1000000) {
        totalTax += (temp - 1000000) * 0.3;
        temp = 1000000;
      }
      if (temp > 500000) {
        totalTax += (temp - 500000) * 0.2;
        temp = 500000;
      }
      if (temp > 250000) {
        totalTax += (temp - 250000) * 0.05;
      }
      if (taxableIncome <= 500000) {
        totalTax = 0;
      }
    }

    const cess = Math.round(totalTax * 0.04 * 100) / 100;
    const netTax = Math.round((totalTax + cess) * 100) / 100;

    const taxDeductedTillDate = Object.values(tdsMonths).reduce((s, v) => s + v, 0);
    const taxToDeducted = Math.max(0, netTax - taxDeductedTillDate);
    const taxDeductionThisMonth = Number(payroll.deductions?.tds || 0);

    const taxWorksheet = {
      regime,
      componentBreakdown,
      grossSalary,
      standardDeduction,
      taxableIncome,
      totalTax,
      cess,
      netTax,
      taxDeductedTillDate,
      taxToDeducted,
      taxDeductionThisMonth,
      tdsMonths,
      hra: {
        from: 'April',
        to: 'March',
        rentPaid: rentPaidTotal,
        actualHRA: hraGross,
        basicPercent,
        rentMinusBasic10,
        exemptHRA: exemptHra
      }
    };

    res.json({
      payslip: {
        employee: payroll.employee || employeeData,
        period: {
          month: payroll.month,
          year: payroll.year,
          monthName: monthName(payroll.month),
        },
        salarySplits: splits,
        earnings: payroll.earnings,
        employerContributions: payroll.employerContributions,
        variablePay: payroll.variablePay,
        deductions: payroll.deductions,
        totalPayable: payroll.totalPayable,
        netSalary: payroll.netSalary,
        workingDays: payroll.workingDays,
        paidDays: payroll.paidDays,
        paidLeaves: payroll.paidLeaves,
        unpaidLeaves: payroll.unpaidLeaves,
        lop: payroll.lop,
        payType: payroll.payType,
        hoursWorked: payroll.hoursWorked,
        hourlyRate: payroll.hourlyRate,
        paymentMethod: payroll.paymentMethod,
        transactionId: payroll.transactionId,
        paymentDate: payroll.paymentDate,
        status: payroll.status,
        notes: payroll.notes,
        remarks: payroll.remarks,
        auditLog: payroll.auditLog || [],
        generatedAt: new Date(),
        company: settings ? {
          companyName: settings.companyName,
          contactName: settings.contactName,
          email: settings.email,
          phone: settings.phone,
          website: settings.website,
          gstin: settings.gstin,
          pan: settings.pan,
          logoUrl: settings.logoUrl,
          signatureUrl: settings.signatureUrl,
          address: settings.address,
        } : null,
        taxWorksheet,
      },
    });
  } catch (error) {
    console.error('Error generating payslip:', error);
    res.status(500).json({ message: 'Server error generating payslip' });
  }
};

exports.emailPayslip = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    const payroll = await Payroll.findOne({ _id: req.params.id, user: req.user._id }).populate('employee');
    if (!payroll) return res.status(404).json({ message: 'Payroll not found' });

    const employeeEmail = payroll.employeeSnapshot?.email || payroll.employee?.email;
    if (!employeeEmail) {
      return res.status(400).json({ message: 'Employee email address is not configured.' });
    }

    const settings = await Settings.findOne({ user: req.user._id }) || {};
    const companyName = settings.companyName || 'Flance';
    
    // 1. Build SMTP Transport config
    const smtpHost = process.env.SMTP_HOST || 'smtp.mailtrap.io';
    const smtpPort = Number(process.env.SMTP_PORT) || 2525;
    const smtpUser = process.env.SMTP_USER || '';
    const smtpPass = process.env.SMTP_PASS || '';
    const smtpSecure = process.env.SMTP_SECURE === 'true' || smtpPort === 465;

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: smtpUser,
        pass: smtpPass
      },
      tls: {
        rejectUnauthorized: false
      }
    });

    const monthLabel = monthName(payroll.month);
    const payPeriodLabel = `${monthLabel} ${payroll.year}`;
    const employeeName = `${payroll.employeeSnapshot?.firstName || ''} ${payroll.employeeSnapshot?.lastName || ''}`.trim() || 'Employee';

    // 2. Generate HTML body (visually matching PayslipGeneration.jsx)
    const fmt = (val) => `INR ${(Number(val) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    let earningsRows = '';
    const addRow = (label, val) => {
      if (Number(val) > 0) {
        earningsRows += `
          <tr>
            <td style="padding: 10px; border-bottom: 1px solid #f1f5f9; color: #475569;">${label}</td>
            <td style="padding: 10px; border-bottom: 1px solid #f1f5f9; text-align: right; font-weight: 500; color: #1e293b;">${fmt(val)}</td>
          </tr>`;
      }
    };

    addRow('Basic Salary', payroll.earnings?.basic);
    addRow('House Rent Allowance (HRA)', payroll.earnings?.hra);
    addRow('Flexi Allowance', payroll.earnings?.flexiAmount);
    addRow('Broadband', payroll.earnings?.broadband);
    addRow('Petrol', payroll.earnings?.petrol);
    addRow('LTA', payroll.earnings?.lta);
    addRow('Conveyance', payroll.earnings?.conveyance);
    addRow('Medical Allowance', payroll.earnings?.medicalAllowance);
    addRow('Special Allowance', payroll.earnings?.specialAllowance);
    addRow('Overtime', payroll.earnings?.overtime);
    (payroll.earnings?.otherEarnings || []).forEach(item => {
      addRow(item.name, item.amount);
    });

    let deductionsRows = '';
    const addDedRow = (label, val) => {
      if (Number(val) > 0) {
        deductionsRows += `
          <tr>
            <td style="padding: 10px; border-bottom: 1px solid #f1f5f9; color: #475569;">${label}</td>
            <td style="padding: 10px; border-bottom: 1px solid #f1f5f9; text-align: right; font-weight: 500; color: #e11d48;">-${fmt(val)}</td>
          </tr>`;
      }
    };

    addDedRow('PF Employee Share', payroll.deductions?.pfEmployee);
    addDedRow('ESI Employee Share', payroll.deductions?.esiEmployee);
    addDedRow('Professional Tax (PT)', payroll.deductions?.professionalTax);
    addDedRow('Income Tax (TDS)', payroll.deductions?.tds);
    addDedRow('Insurance Employee Share', payroll.deductions?.insuranceEmployee);
    addDedRow('LWF Employee Share', payroll.deductions?.lwfEmployee);
    addDedRow('Gratuity Deduction', payroll.deductions?.gratuityDeduction);
    addDedRow('Loan Deduction', payroll.deductions?.loanDeduction);
    addDedRow('Advance Deduction', payroll.deductions?.advanceDeduction);
    (payroll.deductions?.otherDeductions || []).forEach(item => {
      addDedRow(item.name, item.amount);
    });

    const emailHtmlBody = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Payslip for ${payPeriodLabel}</title>
      </head>
      <body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
        <table align="center" border="0" cellpadding="0" cellspacing="0" width="600" style="margin: 40px auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1); border: 1px solid #e2e8f0;">
          <!-- Header -->
          <tr>
            <td bgcolor="#0f172a" style="padding: 30px 40px; color: #ffffff;">
              <table width="100%" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <h1 style="margin: 0; font-size: 24px; font-weight: 700; tracking-tight: -0.025em;">${companyName}</h1>
                    <p style="margin: 5px 0 0 0; font-size: 14px; color: #94a3b8;">Salary Statement / Pay Slip</p>
                  </td>
                  <td align="right" style="vertical-align: top;">
                    <span style="background-color: rgba(255,255,255,0.1); padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; text-transform: uppercase;">${payroll.status}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Employee and Attendance Summary -->
          <tr>
            <td style="padding: 30px 40px;">
              <table width="100%" border="0" cellpadding="0" cellspacing="0" style="margin-bottom: 25px;">
                <tr>
                  <td width="50%" style="vertical-align: top;">
                    <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #64748b; letter-spacing: 0.1em; margin-bottom: 5px;">Employee Details</div>
                    <div style="font-size: 15px; font-weight: 600; color: #0f172a;">${employeeName}</div>
                    <div style="font-size: 13px; color: #475569; margin-top: 2px;">ID: ${payroll.employeeSnapshot?.employeeId || '-'}</div>
                    <div style="font-size: 13px; color: #475569;">Designation: ${payroll.employeeSnapshot?.designation || '-'}</div>
                  </td>
                  <td width="50%" style="vertical-align: top; padding-left: 20px; border-left: 1px solid #e2e8f0;">
                    <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #64748b; letter-spacing: 0.1em; margin-bottom: 5px;">Payroll Cycle</div>
                    <div style="font-size: 15px; font-weight: 600; color: #0f172a;">${payPeriodLabel}</div>
                    <div style="font-size: 13px; color: #475569; margin-top: 2px;">Working Days: ${payroll.workingDays}</div>
                    <div style="font-size: 13px; color: #475569;">Paid Days: ${payroll.paidDays} (LOP: ${payroll.lop})</div>
                  </td>
                </tr>
              </table>
              
              <!-- Calculations -->
              <table width="100%" border="0" cellpadding="0" cellspacing="0" style="margin-bottom: 25px;">
                <tr>
                  <!-- Earnings -->
                  <td width="50%" style="vertical-align: top; padding-right: 15px;">
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" style="border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; font-size: 13px;">
                      <tr bgcolor="#f8fafc">
                        <td style="padding: 10px 12px; font-weight: 700; color: #475569; border-bottom: 1px solid #e2e8f0;">Earnings</td>
                        <td style="padding: 10px 12px; font-weight: 700; color: #475569; border-bottom: 1px solid #e2e8f0; text-align: right;">Amount</td>
                      </tr>
                      ${earningsRows}
                      <tr bgcolor="#f8fafc" style="font-weight: 700;">
                        <td style="padding: 12px 10px; color: #0f172a;">Total Earnings</td>
                        <td style="padding: 12px 10px; text-align: right; color: #0f172a;">${fmt(payroll.earnings?.totalEarnings)}</td>
                      </tr>
                    </table>
                  </td>
                  
                  <!-- Deductions -->
                  <td width="50%" style="vertical-align: top; padding-left: 15px;">
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" style="border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; font-size: 13px;">
                      <tr bgcolor="#f8fafc">
                        <td style="padding: 10px 12px; font-weight: 700; color: #475569; border-bottom: 1px solid #e2e8f0;">Deductions</td>
                        <td style="padding: 10px 12px; font-weight: 700; color: #475569; border-bottom: 1px solid #e2e8f0; text-align: right;">Amount</td>
                      </tr>
                      ${deductionsRows}
                      <tr bgcolor="#f8fafc" style="font-weight: 700;">
                        <td style="padding: 12px 10px; color: #0f172a;">Total Deductions</td>
                        <td style="padding: 12px 10px; text-align: right; color: #0f172a;">${fmt(payroll.deductions?.totalDeductions)}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              
              <!-- Total Take-home -->
              <table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; margin-bottom: 25px;">
                <tr>
                  <td style="padding: 20px 24px;">
                    <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; color: #166534; letter-spacing: 0.1em;">Net Take Home Salary</div>
                    <div style="font-size: 28px; font-weight: 800; color: #166534; margin-top: 5px;">${fmt(payroll.netSalary)}</div>
                    <div style="font-size: 12px; color: #15803d; margin-top: 4px;">Payment Method: ${payroll.paymentMethod || 'Bank Transfer'} ${payroll.transactionId ? `(Txn: ${payroll.transactionId})` : ''}</div>
                  </td>
                </tr>
              </table>
              
              <!-- Footer Note -->
              <table width="100%" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size: 12px; line-height: 18px; color: #64748b;">
                    <strong>Notes:</strong> ${payroll.remarks || payroll.notes || 'This is a system-generated statement. Please login to the employee portal to download/print your official PDF document.'}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Bottom Accent -->
          <tr>
            <td bgcolor="#f8fafc" style="padding: 20px 40px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 12px; color: #94a3b8;">
              &copy; ${new Date().getFullYear()} ${companyName}. All rights reserved.
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    // 3. Dispatch secure TLS Email
    await transporter.sendMail({
      from: `"${companyName} HR & Payroll" <${process.env.SMTP_SENDER || 'payroll@flance.local'}>`,
      to: employeeEmail,
      subject: `Payslip Statement for ${payPeriodLabel} - ${employeeName}`,
      html: emailHtmlBody
    });

    // 4. Append log to database
    payroll.auditLog.push({
      status: payroll.status,
      changedBy: 'System Auto-Email',
      changedById: req.user._id,
      changedAt: new Date(),
      netSalary: payroll.netSalary,
      notes: `Payslip email successfully sent to ${employeeEmail}`
    });
    await payroll.save();

    res.json({ message: `Payslip email successfully sent to ${employeeEmail}.` });
  } catch (error) {
    console.error('Error sending payslip email:', error.message);
    res.status(500).json({ message: `Failed to dispatch payslip email: ${error.message}` });
  }
};

exports.reopenPayroll = async (req, res) => {
  try {
    const { id } = req.params;
    const { remarks } = req.body;
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    const payroll = await Payroll.findOne({ _id: id, user: req.user._id });
    if (!payroll) return res.status(404).json({ message: 'Payroll not found' });

    if (payroll.status === 'paid') {
      return res.status(400).json({ message: 'Paid payroll cannot be re-opened' });
    }
    if (payroll.status !== 'approved') {
      return res.status(400).json({ message: 'Only approved payroll can be re-opened' });
    }

    const oldStatus = payroll.status;
    payroll.status = 'processed';
    payroll.approvalWorkflow.push({
      status: 'processed',
      actor: req.user._id,
      remarks: remarks || 'Payroll re-opened',
    });

    await payroll.save();

    await Payroll.updateOne(
      { _id: payroll._id },
      { $push: { auditLog: {
        status: 'processed',
        changedBy: req.user.name,
        changedById: req.user._id,
        changedAt: new Date(),
        netSalary: payroll.netSalary,
        notes: remarks || 'Payroll re-opened',
      }}}
    );

    await AuditLog.create({
      user: req.user._id,
      actor: req.user._id,
      action: 'PAYROLL_REOPENED',
      targetEmployee: payroll.employee,
      targetPayroll: payroll._id,
      changes: { from: oldStatus, to: 'processed', remarks },
    });

    res.json({ message: 'Payroll re-opened successfully', payroll });
  } catch (error) {
    console.error('Error re-opening payroll:', error);
    res.status(500).json({ message: 'Server error re-opening payroll' });
  }
};

exports.getPayrollTrend = async (req, res) => {
  try {
    const { endMonth, endYear, count = 6 } = req.query;
    const userId = req.user._id;

    // Build array of { month, year } for last N months
    const periods = [];
    let m = parseInt(endMonth), y = parseInt(endYear);
    for (let i = 0; i < parseInt(count); i++) {
      periods.push({ month: m, year: y });
      m--;
      if (m === 0) { m = 12; y--; }
    }
    periods.reverse();

    // Single aggregation
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

    // Map results back to ordered periods
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

exports.getPayrollAuditLog = async (req, res) => {
  try {
    const payroll = await Payroll.findOne({ _id: req.params.id, user: req.user._id }).select('auditLog').lean();
    if (!payroll) return res.status(404).json({ message: 'Not found' });
    res.json({ auditLog: payroll.auditLog || [] });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch audit log' });
  }
};

exports.syncEmployees = async (req, res) => {
  try {
    const result = await hrmsSyncService.syncEmployeesFromExternal(req.user._id);
    res.json({ message: 'Employee directory sync completed successfully.', ...result });
  } catch (error) {
    console.error('Webhook/Sync Employees error:', error.message);
    res.status(500).json({ message: `Sync failed: ${error.message}` });
  }
};

exports.syncAttendance = async (req, res) => {
  try {
    const month = Number(req.query.month) || (new Date().getMonth() + 1);
    const year = Number(req.query.year) || new Date().getFullYear();
    const result = await hrmsSyncService.syncAttendanceFromExternal(req.user._id, month, year);
    res.json({ attendance: result });
  } catch (error) {
    console.error('Webhook/Sync Attendance error:', error.message);
    res.status(500).json({ message: `Attendance sync failed: ${error.message}` });
  }
};

exports.receiveHrmsWebhook = async (req, res) => {
  try {
    const userId = req.tenantUserId;
    const { encryptionSecret } = req.integrationSettings;
    
    let payload = req.body;
    if (payload && payload.data && payload.iv && payload.salt && payload.authTag) {
      payload = decryptPayload(payload, encryptionSecret);
    }

    const employeeData = payload.employee || payload;
    if (!employeeData) {
      return res.status(400).json({ message: 'Missing employee data in webhook body.' });
    }

    const empId = String(
      employeeData.employeeId ||
      employeeData.employeeCode ||
      employeeData.emp_id ||
      employeeData.emp_code ||
      employeeData.employee_code ||
      employeeData.userId ||
      employeeData._id ||
      ''
    ).trim();

    const email = String(
      employeeData.email ||
      employeeData.corporate_email ||
      employeeData.work_email ||
      employeeData.personal?.workEmail ||
      employeeData.contact?.workEmail ||
      ''
    ).trim().toLowerCase();

    if (!empId || !email) {
      return res.status(400).json({ message: 'Invalid employee payload structure: missing employeeId/email.' });
    }

    const phone = String(
      employeeData.phone ||
      employeeData.phone_number ||
      employeeData.contact_no ||
      employeeData.personal?.mobileNumber ||
      employeeData.contact?.mobileNumber ||
      ''
    ).trim();

    const rawGender = employeeData.gender || employeeData.personal?.gender || '';
    const gender = ['Male', 'Female', 'Other'].includes(rawGender) ? rawGender : '';

    const designation = employeeData.designation || employeeData.job_title || employeeData.employment?.designation || '';
    const location = employeeData.location || employeeData.city || employeeData.workLocation || employeeData.employment?.workLocation || '';

    const joiningDateVal = employeeData.joiningDate || employeeData.date_of_joining || employeeData.employment?.joiningDate;
    const joiningDate = joiningDateVal ? new Date(joiningDateVal) : new Date();

    const status = (
      employeeData.status === 'inactive' ||
      employeeData.is_active === false ||
      employeeData.isActive === false ||
      employeeData.employment?.status === 'inactive'
    ) ? 'inactive' : 'active';

    const monthlyCTC = Number(
      employeeData.monthlyCTC ||
      employeeData.ctc ||
      employeeData.base_salary_monthly ||
      employeeData.compensation?.ctc
    ) || 0;

    const panNumber = employeeData.panNumber || employeeData.pan || employeeData.identity?.panNumber || '';
    const aadharNumber = employeeData.aadharNumber || employeeData.aadhar || employeeData.aadhaar || employeeData.identity?.aadhaarNumber || '';
    const uanNumber = employeeData.uanNumber || employeeData.bankDetails?.uanNumber || '';

    const bankDetails = {
      accountName: (
        employeeData.bankDetails?.accountName ||
        employeeData.bankDetails?.accountHolderName ||
        employeeData.bank_account_name ||
        `${employeeData.firstName || employeeData.personal?.firstName || ''} ${employeeData.lastName || employeeData.personal?.lastName || ''}`.trim()
      ),
      accountNumber: employeeData.bankDetails?.accountNumber || employeeData.bank_account_no || '',
      ifscCode: employeeData.bankDetails?.ifscCode || employeeData.bank_ifsc || '',
      bankName: employeeData.bankDetails?.bankName || employeeData.bank_name || ''
    };

    // Department lookup or create by name
    let departmentName = String(employeeData.department || employeeData.dept || '').trim();
    if ((departmentName.startsWith('"') && departmentName.endsWith('"')) || (departmentName.startsWith("'") && departmentName.endsWith("'"))) {
      departmentName = departmentName.slice(1, -1).trim();
    }
    let departmentId = null;
    if (departmentName) {
      const Department = require('../models/Department');
      const escapeRegex = require('../utils/escapeRegex');
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
          description: 'Auto-created during webhook sync',
        });
      }
      if (dept) departmentId = dept._id;
    }

    const pfEnabled = employeeData.compensation?.pfEnabled !== undefined ? employeeData.compensation.pfEnabled : true;
    const esiEnabled = employeeData.compensation?.esiEnabled !== undefined ? employeeData.compensation.esiEnabled : true;
    const ptEnabled = employeeData.compensation?.ptEnabled !== undefined ? employeeData.compensation.ptEnabled : true;
    const lwfEnabled = employeeData.compensation?.lwfEnabled !== undefined ? employeeData.compensation.lwfEnabled : true;
    const gratuityEnabled = employeeData.compensation?.gratuityEnabled !== undefined ? employeeData.compensation.gratuityEnabled : true;
    const includePfInCTC = employeeData.compensation?.includePfInCTC !== undefined ? employeeData.compensation.includePfInCTC : false;
    const includeGratuityInCTC = employeeData.compensation?.includeGratuityInCTC !== undefined ? employeeData.compensation.includeGratuityInCTC : true;
    const basicPercent = employeeData.compensation?.basicPercent !== undefined && employeeData.compensation.basicPercent !== null ? Number(employeeData.compensation.basicPercent) : null;
    const hraPercent = employeeData.compensation?.hraPercent !== undefined && employeeData.compensation.hraPercent !== null ? Number(employeeData.compensation.hraPercent) : null;
    const useSalaryComponents = employeeData.compensation?.useSalaryComponents !== undefined ? employeeData.compensation.useSalaryComponents : true;
    const ptState = employeeData.compensation?.ptState || '';

    const extBreakup = employeeData.compensation?.salaryBreakup || {};
    const broadband = Number(extBreakup.broadband || employeeData.broadband || 0);
    const petrol = Number(extBreakup.petrol || employeeData.petrol || 0);
    const lta = Number(extBreakup.lta || employeeData.lta || 0);
    const employerNPS = Number(extBreakup.employerNPS || extBreakup.nps || employeeData.employerNPS || employeeData.nps || 0);
    const insuranceAmount = Number(extBreakup.insuranceAmount || extBreakup.insurance || employeeData.insuranceAmount || employeeData.insurance || 0);
    const conveyance = Number(extBreakup.conveyance || employeeData.conveyance || 0);
    // medicalAllowance: HRMS stores as 'medical' (component id) or 'medicalAllowance'
    const medicalAllowance = Number(extBreakup.medical || extBreakup.medicalAllowance || employeeData.medical || employeeData.medicalAllowance || 0);
    // flexiAmount: HRMS stores as 'flexi' (component id) or 'flexiAllowance'
    const flexiAmount = Number(extBreakup.flexi || extBreakup.flexiAllowance || employeeData.flexiAmount || employeeData.flexi || 0);

    const basic = Number(extBreakup.basic || 0);
    const hra = Number(extBreakup.hra || 0);

    // Keys that are handled as named fields — must not appear in otherAllowances
    const standardBreakupKeys = new Set([
      'basic', 'hra', 'conveyance', 'medical', 'medicalallowance',
      'flexi', 'flexiallowance', 'flexiamount',
      'broadband', 'petrol', 'lta', 'nps', 'employernps',
      'insurance', 'insuranceamount', 'specialallowance', 'special',
      'pfenabled', 'esienabled', 'ptenabled', 'lwfenabled', 'gratuityenabled',
      'includepfinctc', 'includegratuityinctc', 'basicpercent', 'hrapercent',
      'usesalarycomponents', 'ptstate',
      // payType is a configuration field, not an allowance
      'paytype',
      // Computed values stored by HRMS — ignore on sync (not allowances)
      'annualctc', 'monthlyctc', 'monthlygross', 'monthlygross',
      'specialallowance', 'pfemployer', 'pfemployee', 'gratuity',
      'lwfemployer', 'lwfemployee', 'esiemployer', 'esiemployee',
      'professionaltax', 'professionaltaxval', 'tds', 'nettakehome',
      'flatsalary'
    ]);

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
      firstName: employeeData.firstName || employeeData.personal?.firstName || 'Unknown',
      lastName: employeeData.lastName || employeeData.personal?.lastName || 'Employee',
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

    const config = await PayrollConfig.findOne({ user: userId }) || {};
    const master = buildMasterSalaryStructure(updateData, config);
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
    } else {
      await Employee.create({ ...updateData, user: userId });
    }

    res.json({ message: 'Webhook employee update processed successfully.' });
  } catch (error) {
    console.error('HRMS Webhook processor error:', error.message);
    res.status(500).json({ message: `Webhook error: ${error.message}` });
  }
};

exports.deletePayroll = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    const payroll = await Payroll.findOne({ _id: id, user: req.user._id });
    if (!payroll) return res.status(404).json({ message: 'Payroll not found' });

    if (payroll.status === 'paid') {
      return res.status(400).json({ message: 'Paid payroll is locked and cannot be deleted' });
    }

    if (payroll.expenseRef) {
      await Expense.deleteOne({ _id: payroll.expenseRef, user: req.user._id });
    }

    await Payroll.deleteOne({ _id: id, user: req.user._id });

    await AuditLog.create({
      user: req.user._id,
      actor: req.user._id,
      action: 'PAYROLL_DELETED',
      targetEmployee: payroll.employee,
      changes: { month: payroll.month, year: payroll.year, netSalary: payroll.netSalary }
    });

    res.json({ message: 'Payroll deleted successfully' });
  } catch (error) {
    console.error('Error deleting payroll:', error);
    res.status(500).json({ message: 'Server error deleting payroll' });
  }
};

exports.__private__ = {
  getOrCreateConfig,
  buildPayrollWorkbook,
};

