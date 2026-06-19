const mongoose = require('mongoose');
const Payroll = require('../../models/Payroll');
const Employee = require('../../models/Employee');
const { XLSX, setHeaderStyle, sendWorkbook } = require('../../utils/excel');

const validateMonth = (month) => Number.isInteger(month) && month >= 1 && month <= 12;
const validateYear = (year) => Number.isInteger(year) && year >= 1970 && year <= 3000;
const formatMonthName = (month) => new Date(0, month - 1).toLocaleString('en-US', { month: 'short' });
const sumNamedAmounts = (items = []) => items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

const sendReport = (res, rows, sheetName, filename, format = 'json') => {
  if (format === 'excel') {
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    const headerCells = rows[0].map((_, index) => `${XLSX.utils.encode_col(index)}1`);
    setHeaderStyle(worksheet, headerCells);
    worksheet['!cols'] = rows[0].map(() => ({ wch: 18 }));
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
    return sendWorkbook(res, workbook, filename);
  }

  const [headers, ...dataRows] = rows;
  const data = dataRows.map((row) => headers.reduce((acc, header, index) => {
    acc[header] = row[index];
    return acc;
  }, {}));
  return res.json({ data });
};

exports.getPayrollSummary = async (req, res) => {
  try {
    const match = { user: req.user._id };
    if (req.query.month !== undefined) {
      const month = Number.parseInt(req.query.month, 10);
      if (!validateMonth(month)) {
        return res.status(400).json({ message: 'Invalid month' });
      }
      match.month = month;
    }
    if (req.query.year !== undefined) {
      const year = Number.parseInt(req.query.year, 10);
      if (!validateYear(year)) {
        return res.status(400).json({ message: 'Invalid year' });
      }
      match.year = year;
    }

    const byDepartment = await Payroll.aggregate([
      { $match: match },
      {
        $lookup: {
          from: 'employees',
          localField: 'employee',
          foreignField: '_id',
          as: 'employee',
        },
      },
      { $unwind: { path: '$employee', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'departments',
          localField: 'employee.department',
          foreignField: '_id',
          as: 'department',
        },
      },
      { $unwind: { path: '$department', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: '$department._id',
          department: { $first: { $ifNull: ['$department.name', 'Unassigned'] } },
          totalPayroll: { $sum: '$netSalary' },
          employeeCount: { $sum: 1 },
        },
      },
      { $sort: { totalPayroll: -1 } },
    ]);

    const totalPayroll = byDepartment.reduce((sum, item) => sum + item.totalPayroll, 0);
    res.json({ byDepartment, totalPayroll });
  } catch (error) {
    console.error('Error building payroll summary:', error);
    res.status(500).json({ message: 'Server error building payroll summary' });
  }
};

exports.getBankTransferSheet = async (req, res) => {
  try {
    const month = Number(req.query.month);
    const year = Number(req.query.year);
    const format = String(req.query.format || 'json').toLowerCase();

    if (!validateMonth(month) || !validateYear(year)) {
      return res.status(400).json({ message: 'Valid month and year are required' });
    }

    const payrolls = await Payroll.find({ user: req.user._id, month, year })
      .populate({ path: 'employee', select: '+bankDetails.accountNumber firstName lastName employeeId bankDetails.ifscCode' })
      .sort({ createdAt: 1 })
      .lean();

    const rows = [
      ['Employee Name', 'Employee ID', 'Account Number', 'IFSC', 'Net Salary'],
      ...payrolls.map((payroll) => [
        `${payroll.employee?.firstName || payroll.employeeSnapshot?.firstName || ''} ${payroll.employee?.lastName || payroll.employeeSnapshot?.lastName || ''}`.trim() || 'Unknown Employee',
        payroll.employee?.employeeId || payroll.employeeSnapshot?.employeeId || '',
        payroll.employee?.bankDetails?.accountNumber || '',
        payroll.employee?.bankDetails?.ifscCode || '',
        Number(payroll.netSalary) || 0,
      ]),
    ];

    return sendReport(res, rows, 'Bank Transfer', `bank-transfer-${year}-${String(month).padStart(2, '0')}.xlsx`, format);
  } catch (error) {
    console.error('Error generating bank transfer sheet:', error);
    res.status(500).json({ message: 'Server error generating bank transfer sheet' });
  }
};

exports.getPFChallan = async (req, res) => {
  try {
    const month = Number(req.query.month);
    const year = Number(req.query.year);
    const format = String(req.query.format || 'json').toLowerCase();

    if (!validateMonth(month) || !validateYear(year)) {
      return res.status(400).json({ message: 'Valid month and year are required' });
    }

    const payrolls = await Payroll.find({ user: req.user._id, month, year })
      .populate({ path: 'employee', select: 'firstName lastName employeeId uanNumber' })
      .sort({ createdAt: 1 })
      .lean();

    const rows = [
      ['Employee Name', 'Employee ID', 'PF Employee', 'PF Employer', 'Total PF'],
      ...payrolls.map((payroll) => [
        `${payroll.employee?.firstName || payroll.employeeSnapshot?.firstName || ''} ${payroll.employee?.lastName || payroll.employeeSnapshot?.lastName || ''}`.trim() || 'Unknown Employee',
        payroll.employee?.employeeId || payroll.employeeSnapshot?.employeeId || '',
        Number(payroll.deductions?.pfEmployee) || 0,
        Number(payroll.employerContributions?.pfEmployer) || 0,
        (Number(payroll.deductions?.pfEmployee) || 0) + (Number(payroll.employerContributions?.pfEmployer) || 0),
      ]),
    ];

    return sendReport(res, rows, 'PF Challan', `pf-challan-${year}-${String(month).padStart(2, '0')}.xlsx`, format);
  } catch (error) {
    console.error('Error generating PF challan:', error);
    res.status(500).json({ message: 'Server error generating PF challan' });
  }
};

exports.getTDSSummary = async (req, res) => {
  try {
    const year = Number(req.query.year);
    const format = String(req.query.format || 'json').toLowerCase();
    if (!validateYear(year)) {
      return res.status(400).json({ message: 'Valid financial year is required' });
    }

    const financialYearStart = year;
    const financialYearEnd = year + 1;
    const payrolls = await Payroll.find({
      user: req.user._id,
      $or: [
        { year: financialYearStart, month: { $gte: 4 } },
        { year: financialYearEnd, month: { $lte: 3 } },
      ],
    })
      .populate({ path: 'employee', select: 'firstName lastName employeeId panNumber' })
      .sort({ year: 1, month: 1 })
      .lean();

    const grouped = new Map();
    payrolls.forEach((payroll) => {
      const employeeId = payroll.employee?._id ? String(payroll.employee._id) : (payroll.employeeSnapshot?.employeeId || '');
      if (!grouped.has(employeeId)) {
        grouped.set(employeeId, {
          name: `${payroll.employee?.firstName || payroll.employeeSnapshot?.firstName || ''} ${payroll.employee?.lastName || payroll.employeeSnapshot?.lastName || ''}`.trim() || 'Unknown Employee',
          employeeId: payroll.employee?.employeeId || payroll.employeeSnapshot?.employeeId || '',
          values: Object.fromEntries(['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'].map((m) => [m, 0])),
        });
      }
      const monthKey = formatMonthName(payroll.month);
      grouped.get(employeeId).values[monthKey] = Number(payroll.deductions?.tds) || 0;
    });

    const rows = [
      ['Employee Name', 'Employee ID', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Total TDS'],
      ...Array.from(grouped.values()).map((entry) => {
        const monthValues = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'].map((key) => entry.values[key] || 0);
        return [
          entry.name,
          entry.employeeId,
          ...monthValues,
          monthValues.reduce((sum, value) => sum + value, 0),
        ];
      }),
    ];

    return sendReport(res, rows, 'TDS Summary', `tds-summary-fy-${financialYearStart}-${financialYearEnd}.xlsx`, format);
  } catch (error) {
    console.error('Error generating TDS summary:', error);
    res.status(500).json({ message: 'Server error generating TDS summary' });
  }
};

exports.getAnnualEmployeeSummary = async (req, res) => {
  try {
    const year = Number(req.query.year);
    const format = String(req.query.format || 'json').toLowerCase();
    const employeeId = req.query.employeeId;

    if (!validateYear(year)) {
      return res.status(400).json({ message: 'Valid year is required' });
    }
    if (!mongoose.Types.ObjectId.isValid(String(employeeId))) {
      return res.status(400).json({ message: 'Valid employeeId is required' });
    }

    let employee = await Employee.findOne({ _id: employeeId, user: req.user._id }).select('firstName lastName employeeId monthlyCTC');
    if (!employee) {
      const pastPayroll = await Payroll.findOne({ employee: employeeId, user: req.user._id }).select('employeeSnapshot');
      if (pastPayroll && pastPayroll.employeeSnapshot) {
        employee = {
          _id: employeeId,
          firstName: pastPayroll.employeeSnapshot.firstName,
          lastName: pastPayroll.employeeSnapshot.lastName,
          employeeId: pastPayroll.employeeSnapshot.employeeId,
          monthlyCTC: pastPayroll.employeeSnapshot.monthlyCTC,
        };
      }
    }
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    const payrolls = await Payroll.find({ user: req.user._id, employee: employeeId, year })
      .sort({ month: 1 })
      .lean();

    const rows = [
      ['Month', 'Monthly CTC', 'Gross Salary', 'Employer Contribution', 'Variable Pay', 'Total Payable', 'Total Deductions', 'Net Salary'],
      ...payrolls.map((payroll) => [
        formatMonthName(payroll.month),
        Number(employee.monthlyCTC) || 0,
        Number(payroll.earnings?.totalEarnings) || 0,
        (Number(payroll.employerContributions?.grossTotalSalary) || 0) - (Number(payroll.earnings?.totalEarnings) || 0),
        Number(payroll.variablePay?.totalVariablePay) || 0,
        Number(payroll.totalPayable) || 0,
        Number(payroll.deductions?.totalDeductions) || 0,
        Number(payroll.netSalary) || 0,
      ]),
    ];

    const totalRow = [
      'TOTAL',
      Number(employee.monthlyCTC) || 0,
      payrolls.reduce((sum, payroll) => sum + (Number(payroll.earnings?.totalEarnings) || 0), 0),
      payrolls.reduce((sum, payroll) => sum + ((Number(payroll.employerContributions?.grossTotalSalary) || 0) - (Number(payroll.earnings?.totalEarnings) || 0)), 0),
      payrolls.reduce((sum, payroll) => sum + (Number(payroll.variablePay?.totalVariablePay) || 0), 0),
      payrolls.reduce((sum, payroll) => sum + (Number(payroll.totalPayable) || 0), 0),
      payrolls.reduce((sum, payroll) => sum + (Number(payroll.deductions?.totalDeductions) || 0), 0),
      payrolls.reduce((sum, payroll) => sum + (Number(payroll.netSalary) || 0), 0),
    ];
    rows.push(totalRow);

    return sendReport(
      res,
      rows,
      'Employee Summary',
      `employee-summary-${employee.employeeId || employeeId}-${year}.xlsx`,
      format
    );
  } catch (error) {
    console.error('Error generating annual employee summary:', error);
    res.status(500).json({ message: 'Server error generating annual employee summary' });
  }
};
