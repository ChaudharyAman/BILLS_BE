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
      .populate({ path: 'employee', select: 'firstName lastName employeeId +uanNumber' })
      .sort({ createdAt: 1 })
      .lean();

    const rows = [
      [
        'Employee Name',
        'Employee ID',
        'UAN',
        'Gross Wages',
        'EPF Wages',
        'EPS Wages',
        'EDLI Wages',
        'EPF Employee Share (12%)',
        'EPS Employer Share (8.33%)',
        'EPF Employer Share Diff (3.67%)',
        'NCP Days (LOP)',
        'Total PF Contribution',
      ],
      ...payrolls.map((payroll) => {
        const grossWages = Number(payroll.earnings?.totalEarnings) || 0;
        const pfEmployee = Number(payroll.deductions?.pfEmployee) || 0;
        const pfEmployer = Number(payroll.employerContributions?.pfEmployer) || 0;
        
        // Calculate EPF Wages: pfEmployee / pfRate (0.12)
        const epfWages = pfEmployee > 0 ? Math.round((pfEmployee / 0.12) * 100) / 100 : 0;
        // EPS & EDLI Wages are capped at 15,000
        const epsWages = epfWages > 0 ? Math.min(epfWages, 15000) : 0;
        const edliWages = epsWages;
        
        // EPS Share: 8.33% of EPS Wages, capped at 1250 (max)
        const epsContribution = Math.min(1250, Math.round(epsWages * 0.0833 * 100) / 100);
        // EPF Employer Share Diff (3.67%)
        const epfEmployerDiff = Math.max(0, Math.round((pfEmployer - epsContribution) * 100) / 100);
        
        const lop = Number(payroll.lop) || 0;
        
        return [
          `${payroll.employee?.firstName || payroll.employeeSnapshot?.firstName || ''} ${payroll.employee?.lastName || payroll.employeeSnapshot?.lastName || ''}`.trim() || 'Unknown Employee',
          payroll.employee?.employeeId || payroll.employeeSnapshot?.employeeId || '',
          payroll.employee?.uanNumber || '',
          grossWages,
          epfWages,
          epsWages,
          edliWages,
          pfEmployee,
          epsContribution,
          epfEmployerDiff,
          lop,
          pfEmployee + pfEmployer,
        ];
      }),
    ];

    if (payrolls.length > 0) {
      const totalRow = [
        'TOTAL',
        '',
        '',
        payrolls.reduce((sum, p) => sum + (Number(p.earnings?.totalEarnings) || 0), 0),
        payrolls.reduce((sum, p) => {
          const pfEmp = Number(p.deductions?.pfEmployee) || 0;
          return sum + (pfEmp > 0 ? Math.round((pfEmp / 0.12) * 100) / 100 : 0);
        }, 0),
        payrolls.reduce((sum, p) => {
          const pfEmp = Number(p.deductions?.pfEmployee) || 0;
          const epf = pfEmp > 0 ? Math.round((pfEmp / 0.12) * 100) / 100 : 0;
          return sum + (epf > 0 ? Math.min(epf, 15000) : 0);
        }, 0),
        payrolls.reduce((sum, p) => {
          const pfEmp = Number(p.deductions?.pfEmployee) || 0;
          const epf = pfEmp > 0 ? Math.round((pfEmp / 0.12) * 100) / 100 : 0;
          return sum + (epf > 0 ? Math.min(epf, 15000) : 0);
        }, 0),
        payrolls.reduce((sum, p) => sum + (Number(p.deductions?.pfEmployee) || 0), 0),
        payrolls.reduce((sum, p) => {
          const pfEmp = Number(p.deductions?.pfEmployee) || 0;
          const epf = pfEmp > 0 ? Math.round((pfEmp / 0.12) * 100) / 100 : 0;
          const epsWages = epf > 0 ? Math.min(epf, 15000) : 0;
          return sum + Math.min(1250, Math.round(epsWages * 0.0833 * 100) / 100);
        }, 0),
        payrolls.reduce((sum, p) => {
          const pfEmp = Number(p.deductions?.pfEmployee) || 0;
          const pfEmployer = Number(p.employerContributions?.pfEmployer) || 0;
          const epf = pfEmp > 0 ? Math.round((pfEmp / 0.12) * 100) / 100 : 0;
          const epsWages = epf > 0 ? Math.min(epf, 15000) : 0;
          const epsContribution = Math.min(1250, Math.round(epsWages * 0.0833 * 100) / 100);
          return sum + Math.max(0, Math.round((pfEmployer - epsContribution) * 100) / 100);
        }, 0),
        payrolls.reduce((sum, p) => sum + (Number(p.lop) || 0), 0),
        payrolls.reduce((sum, p) => sum + (Number(p.deductions?.pfEmployee) || 0) + (Number(p.employerContributions?.pfEmployer) || 0), 0),
      ];
      // Round total numeric values in the total row
      for (let i = 3; i < totalRow.length; i++) {
        totalRow[i] = Math.round(totalRow[i] * 100) / 100;
      }
      rows.push(totalRow);
    }

    return sendReport(res, rows, 'PF Challan', `pf-challan-${year}-${String(month).padStart(2, '0')}.xlsx`, format);
  } catch (error) {
    console.error('Error generating PF challan:', error);
    res.status(500).json({ message: 'Server error generating PF challan' });
  }
};

exports.getESIChallan = async (req, res) => {
  try {
    const month = Number(req.query.month);
    const year = Number(req.query.year);
    const format = String(req.query.format || 'json').toLowerCase();

    if (!validateMonth(month) || !validateYear(year)) {
      return res.status(400).json({ message: 'Valid month and year are required' });
    }

    const payrolls = await Payroll.find({ user: req.user._id, month, year })
      .populate({ path: 'employee', select: 'firstName lastName employeeId' })
      .sort({ createdAt: 1 })
      .lean();

    const rows = [
      ['Employee Name', 'Employee ID', 'Gross Wages', 'Paid Days', 'ESI Employee (0.75%)', 'ESI Employer (3.25%)', 'Total ESI Contribution'],
      ...payrolls.map((payroll) => {
        const grossWages = Number(payroll.earnings?.totalEarnings) || 0;
        const paidDays = Number(payroll.paidDays) || 0;
        const esiEmployee = Number(payroll.deductions?.esiEmployee) || 0;
        const esiEmployer = Number(payroll.employerContributions?.esiEmployer) || 0;
        
        return [
          `${payroll.employee?.firstName || payroll.employeeSnapshot?.firstName || ''} ${payroll.employee?.lastName || payroll.employeeSnapshot?.lastName || ''}`.trim() || 'Unknown Employee',
          payroll.employee?.employeeId || payroll.employeeSnapshot?.employeeId || '',
          grossWages,
          paidDays,
          esiEmployee,
          esiEmployer,
          esiEmployee + esiEmployer,
        ];
      }),
    ];

    if (payrolls.length > 0) {
      const totalRow = [
        'TOTAL',
        '',
        payrolls.reduce((sum, p) => sum + (Number(p.earnings?.totalEarnings) || 0), 0),
        payrolls.reduce((sum, p) => sum + (Number(p.paidDays) || 0), 0),
        payrolls.reduce((sum, p) => sum + (Number(p.deductions?.esiEmployee) || 0), 0),
        payrolls.reduce((sum, p) => sum + (Number(p.employerContributions?.esiEmployer) || 0), 0),
        payrolls.reduce((sum, p) => sum + (Number(p.deductions?.esiEmployee) || 0) + (Number(p.employerContributions?.esiEmployer) || 0), 0),
      ];
      // Round total numeric values in the total row
      for (let i = 2; i < totalRow.length; i++) {
        totalRow[i] = Math.round(totalRow[i] * 100) / 100;
      }
      rows.push(totalRow);
    }

    return sendReport(res, rows, 'ESI Challan', `esi-challan-${year}-${String(month).padStart(2, '0')}.xlsx`, format);
  } catch (error) {
    console.error('Error generating ESI challan:', error);
    res.status(500).json({ message: 'Server error generating ESI challan' });
  }
};

exports.getStatutorySummary = async (req, res) => {
  try {
    const month = Number(req.query.month);
    const year = Number(req.query.year);
    const format = String(req.query.format || 'json').toLowerCase();

    if (!validateMonth(month) || !validateYear(year)) {
      return res.status(400).json({ message: 'Valid month and year are required' });
    }

    const payrolls = await Payroll.find({ user: req.user._id, month, year })
      .populate({ path: 'employee', select: 'firstName lastName employeeId' })
      .sort({ createdAt: 1 })
      .lean();

    const rows = [
      [
        'Employee Name',
        'Employee ID',
        'PF Employee (12%)',
        'PF Employer (12%)',
        'ESI Employee (0.75%)',
        'ESI Employer (3.25%)',
        'Professional Tax (PT)',
        'LWF Employee',
        'LWF Employer',
        'Total Statutory Dues',
      ],
      ...payrolls.map((p) => {
        const pfEmp = Number(p.deductions?.pfEmployee) || 0;
        const pfEst = Number(p.employerContributions?.pfEmployer) || 0;
        const esiEmp = Number(p.deductions?.esiEmployee) || 0;
        const esiEst = Number(p.employerContributions?.esiEmployer) || 0;
        const pt = Number(p.deductions?.professionalTax) || 0;
        const lwfEmp = Number(p.deductions?.lwfEmployee) || 0;
        const lwfEst = Number(p.employerContributions?.lwfEmployer) || 0;
        
        const total = pfEmp + pfEst + esiEmp + esiEst + pt + lwfEmp + lwfEst;
        
        return [
          `${p.employee?.firstName || p.employeeSnapshot?.firstName || ''} ${p.employee?.lastName || p.employeeSnapshot?.lastName || ''}`.trim() || 'Unknown Employee',
          p.employee?.employeeId || p.employeeSnapshot?.employeeId || '',
          pfEmp,
          pfEst,
          esiEmp,
          esiEst,
          pt,
          lwfEmp,
          lwfEst,
          total,
        ];
      }),
    ];

    if (payrolls.length > 0) {
      const totalRow = [
        'TOTAL',
        '',
        payrolls.reduce((sum, p) => sum + (Number(p.deductions?.pfEmployee) || 0), 0),
        payrolls.reduce((sum, p) => sum + (Number(p.employerContributions?.pfEmployer) || 0), 0),
        payrolls.reduce((sum, p) => sum + (Number(p.deductions?.esiEmployee) || 0), 0),
        payrolls.reduce((sum, p) => sum + (Number(p.employerContributions?.esiEmployer) || 0), 0),
        payrolls.reduce((sum, p) => sum + (Number(p.deductions?.professionalTax) || 0), 0),
        payrolls.reduce((sum, p) => sum + (Number(p.deductions?.lwfEmployee) || 0), 0),
        payrolls.reduce((sum, p) => sum + (Number(p.employerContributions?.lwfEmployer) || 0), 0),
        payrolls.reduce((sum, p) => {
          const pfEmp = Number(p.deductions?.pfEmployee) || 0;
          const pfEst = Number(p.employerContributions?.pfEmployer) || 0;
          const esiEmp = Number(p.deductions?.esiEmployee) || 0;
          const esiEst = Number(p.employerContributions?.esiEmployer) || 0;
          const pt = Number(p.deductions?.professionalTax) || 0;
          const lwfEmp = Number(p.deductions?.lwfEmployee) || 0;
          const lwfEst = Number(p.employerContributions?.lwfEmployer) || 0;
          return sum + pfEmp + pfEst + esiEmp + esiEst + pt + lwfEmp + lwfEst;
        }, 0),
      ];
      // Round total numeric values in the total row
      for (let i = 2; i < totalRow.length; i++) {
        totalRow[i] = Math.round(totalRow[i] * 100) / 100;
      }
      rows.push(totalRow);
    }

    return sendReport(res, rows, 'Statutory Summary', `statutory-summary-${year}-${String(month).padStart(2, '0')}.xlsx`, format);
  } catch (error) {
    console.error('Error generating statutory summary:', error);
    res.status(500).json({ message: 'Server error generating statutory summary' });
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
      ['Employee Name', 'Employee ID', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Total TDS', 'Projected Tax', 'True-Up Variance', 'Form 16 Flag'],
      ...Array.from(grouped.values()).map((entry) => {
        const monthValues = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'].map((key) => entry.values[key] || 0);
        const totalTds = monthValues.reduce((sum, value) => sum + value, 0);
        const projectedTax = entry.annualTax || totalTds;
        const variance = Math.round((projectedTax - totalTds) * 100) / 100;
        const form16Flag = Math.abs(variance) > 500 ? 'Reconciliation Needed' : 'Balanced';

        return [
          entry.name,
          entry.employeeId,
          ...monthValues,
          totalTds,
          projectedTax,
          variance,
          form16Flag,
        ];
      }),
    ];

    return sendReport(res, rows, 'TDS Summary & Form 16 True-Up', `tds-summary-fy-${financialYearStart}-${financialYearEnd}.xlsx`, format);
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

exports.getPFECR = async (req, res) => {
  try {
    const month = Number(req.query.month);
    const year = Number(req.query.year);

    if (!validateMonth(month) || !validateYear(year)) {
      return res.status(400).json({ message: 'Valid month and year are required' });
    }

    const payrolls = await Payroll.find({ user: req.user._id, month, year })
      .populate({ path: 'employee', select: '+uanNumber firstName lastName employeeId' })
      .sort({ createdAt: 1 })
      .lean();

    const pfPayrolls = payrolls.filter(p => p.employeeSnapshot?.pfEnabled !== false && p.deductions?.pfEmployee > 0);

    const lines = pfPayrolls.map((payroll) => {
      const uan = (payroll.employee?.uanNumber || '').trim();
      const rawName = `${payroll.employee?.firstName || payroll.employeeSnapshot?.firstName || ''} ${payroll.employee?.lastName || payroll.employeeSnapshot?.lastName || ''}`.trim();
      const name = rawName.replace(/[^a-zA-Z0-9\s]/g, '').toUpperCase().trim();
      
      const grossWages = Math.round(Number(payroll.earnings?.totalEarnings) || 0);
      const basicWages = Math.round(Number(payroll.earnings?.basic) || 0);
      
      let epfWages = 0;
      const pfEmployee = Number(payroll.deductions?.pfEmployee) || 0;
      const pfEmployer = Number(payroll.employerContributions?.pfEmployer) || 0;
      
      if (pfEmployee > 0) {
        if (pfEmployee === 1800) {
          epfWages = 15000;
        } else {
          epfWages = Math.round(pfEmployee / 0.12);
        }
      }
      
      const epsWages = epfWages > 0 ? Math.min(epfWages, 15000) : 0;
      const edliWages = epsWages;
      
      const epsContribution = Math.min(1250, Math.round(epsWages * 0.0833));
      const epfEpsDiff = Math.max(0, Math.round(pfEmployer - epsContribution));
      
      const ncpDays = Math.round(Number(payroll.unpaidLeaves) || Number(payroll.lop) || 0);
      const refundOfAdvances = 0;

      return [
        uan,
        name,
        grossWages,
        epfWages,
        epsWages,
        edliWages,
        Math.round(pfEmployee),
        epsContribution,
        epfEpsDiff,
        ncpDays,
        refundOfAdvances
      ].join('#~#');
    });

    const fileContent = lines.join('\r\n');
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename=PF_ECR_${year}_${String(month).padStart(2, '0')}.txt`);
    return res.send(fileContent);
  } catch (error) {
    console.error('Error generating PF ECR:', error);
    res.status(500).json({ message: 'Server error generating PF ECR file' });
  }
};

exports.getESIMonthlyUpload = async (req, res) => {
  try {
    const month = Number(req.query.month);
    const year = Number(req.query.year);

    if (!validateMonth(month) || !validateYear(year)) {
      return res.status(400).json({ message: 'Valid month and year are required' });
    }

    const payrolls = await Payroll.find({ user: req.user._id, month, year })
      .populate({ path: 'employee', select: '+esiNumber firstName lastName employeeId dateOfLeaving status' })
      .sort({ createdAt: 1 })
      .lean();

    const esiPayrolls = payrolls.filter(p => p.employeeSnapshot?.esiEnabled !== false && p.deductions?.esiEmployee > 0);

    const rows = [
      ['IP Number', 'IP Name', 'No. of Days', 'Total Monthly Wages', 'Reason for 0 Wages', 'Last Working Day']
    ];

    esiPayrolls.forEach((payroll) => {
      const ipNumber = (payroll.employee?.esiNumber || '').trim();
      const rawName = `${payroll.employee?.firstName || payroll.employeeSnapshot?.firstName || ''} ${payroll.employee?.lastName || payroll.employeeSnapshot?.lastName || ''}`.trim();
      const ipName = rawName.replace(/[^a-zA-Z0-9\s]/g, '').toUpperCase().trim();
      
      const noOfDays = Math.round(Number(payroll.paidDays) || 0);
      const totalWages = Math.round(Number(payroll.earnings?.totalEarnings) || 0);
      const reasonCode = totalWages === 0 ? 2 : 0;
      
      let lastWorkingDay = '';
      if (payroll.employee?.dateOfLeaving) {
        const dol = new Date(payroll.employee.dateOfLeaving);
        if (dol.getMonth() + 1 === month && dol.getFullYear() === year) {
          const dd = String(dol.getDate()).padStart(2, '0');
          const mm = String(dol.getMonth() + 1).padStart(2, '0');
          const yyyy = dol.getFullYear();
          lastWorkingDay = `${dd}/${mm}/${yyyy}`;
        }
      }

      rows.push([
        ipNumber,
        ipName,
        noOfDays,
        totalWages,
        reasonCode,
        lastWorkingDay
      ]);
    });

    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    const workbook = XLSX.utils.book_new();

    const rowCount = rows.length;
    for (let r = 1; r < rowCount; r++) {
      const cellRefA = XLSX.utils.encode_cell({ r, c: 0 });
      if (worksheet[cellRefA]) {
        worksheet[cellRefA].t = 's';
      }
      const cellRefF = XLSX.utils.encode_cell({ r, c: 5 });
      if (worksheet[cellRefF]) {
        worksheet[cellRefF].t = 's';
      }
    }

    worksheet['!cols'] = [
      { wch: 20 },
      { wch: 30 },
      { wch: 12 },
      { wch: 20 },
      { wch: 18 },
      { wch: 18 }
    ];

    XLSX.utils.book_append_sheet(workbook, worksheet, 'ESI Upload');
    return sendWorkbook(res, workbook, `esi-monthly-upload-${year}-${String(month).padStart(2, '0')}.xlsx`);
  } catch (error) {
    console.error('Error generating ESI monthly upload:', error);
    res.status(500).json({ message: 'Server error generating ESI upload sheet' });
  }
};

exports.getBankPaymentBatch = async (req, res) => {
  try {
    const month = Number(req.query.month);
    const year = Number(req.query.year);
    const bank = String(req.query.bank || 'generic').toLowerCase();

    if (!validateMonth(month) || !validateYear(year)) {
      return res.status(400).json({ message: 'Valid month and year are required' });
    }

    const payrolls = await Payroll.find({ user: req.user._id, month, year })
      .populate({ path: 'employee', select: '+bankDetails.accountNumber firstName lastName employeeId bankDetails.ifscCode bankDetails.bankName bankDetails.accountName email' })
      .sort({ createdAt: 1 })
      .lean();

    let csvContent = '';
    const sanitizeCSV = (str) => {
      if (!str) return '';
      return String(str).replace(/[,\"\r\n]/g, ' ').trim();
    };

    if (bank === 'hdfc') {
      const headers = ['Transaction Type', 'Beneficiary Account Number', 'Net Amount', 'Beneficiary Name', 'Payment Detail', 'IFSC Code', 'Beneficiary Email'];
      const lines = [headers.join(',')];
      
      payrolls.forEach(p => {
        const accountNo = p.employee?.bankDetails?.accountNumber || '';
        const name = `${p.employee?.firstName || p.employeeSnapshot?.firstName || ''} ${p.employee?.lastName || p.employeeSnapshot?.lastName || ''}`.trim();
        const amt = Number(p.netSalary) || 0;
        const ifsc = p.employee?.bankDetails?.ifscCode || '';
        const email = p.employee?.email || p.employeeSnapshot?.email || '';
        const isHdfc = (p.employee?.bankDetails?.bankName || '').toLowerCase().includes('hdfc');
        const txType = isHdfc ? 'FT' : 'N';

        lines.push([
          txType,
          sanitizeCSV(accountNo),
          amt.toFixed(2),
          sanitizeCSV(name),
          `SALARY_${formatMonthName(month).toUpperCase()}_${year}`,
          sanitizeCSV(ifsc),
          sanitizeCSV(email)
        ].join(','));
      });
      csvContent = lines.join('\r\n');
    } else if (bank === 'icici') {
      const headers = ['Serial Number', 'Beneficiary Account Number', 'Beneficiary Name', 'Amount', 'Transaction Type', 'IFSC Code', 'Remarks'];
      const lines = [headers.join(',')];

      payrolls.forEach((p, idx) => {
        const accountNo = p.employee?.bankDetails?.accountNumber || '';
        const name = `${p.employee?.firstName || p.employeeSnapshot?.firstName || ''} ${p.employee?.lastName || p.employeeSnapshot?.lastName || ''}`.trim();
        const amt = Number(p.netSalary) || 0;
        const ifsc = p.employee?.bankDetails?.ifscCode || '';
        const isIcici = (p.employee?.bankDetails?.bankName || '').toLowerCase().includes('icici');
        const txType = isIcici ? 'IFT' : 'NEFT';

        lines.push([
          idx + 1,
          sanitizeCSV(accountNo),
          sanitizeCSV(name),
          amt.toFixed(2),
          txType,
          sanitizeCSV(ifsc),
          `SALARY FOR ${formatMonthName(month).toUpperCase()} ${year}`
        ].join(','));
      });
      csvContent = lines.join('\r\n');
    } else {
      const headers = ['Employee ID', 'Employee Name', 'Bank Name', 'Account Number', 'IFSC Code', 'Net Amount', 'Email'];
      const lines = [headers.join(',')];

      payrolls.forEach(p => {
        const empId = p.employee?.employeeId || p.employeeSnapshot?.employeeId || '';
        const name = `${p.employee?.firstName || p.employeeSnapshot?.firstName || ''} ${p.employee?.lastName || p.employeeSnapshot?.lastName || ''}`.trim();
        const bankName = p.employee?.bankDetails?.bankName || '';
        const accountNo = p.employee?.bankDetails?.accountNumber || '';
        const ifsc = p.employee?.bankDetails?.ifscCode || '';
        const amt = Number(p.netSalary) || 0;
        const email = p.employee?.email || p.employeeSnapshot?.email || '';

        lines.push([
          sanitizeCSV(empId),
          sanitizeCSV(name),
          sanitizeCSV(bankName),
          sanitizeCSV(accountNo),
          sanitizeCSV(ifsc),
          amt.toFixed(2),
          sanitizeCSV(email)
        ].join(','));
      });
      csvContent = lines.join('\r\n');
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=bank-payment-${bank}-${year}-${String(month).padStart(2, '0')}.csv`);
    return res.send(csvContent);
  } catch (error) {
    console.error('Error exporting bank payment batch:', error);
    res.status(500).json({ message: 'Server error exporting bank payment batch' });
  }
};
