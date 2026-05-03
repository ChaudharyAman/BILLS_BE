const Payroll = require('../../models/Payroll');

exports.getPayrollSummary = async (req, res) => {
  try {
    const match = { user: req.user._id };
    if (req.query.month !== undefined) {
      const month = Number.parseInt(req.query.month, 10);
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        return res.status(400).json({ error: 'Invalid month' });
      }
      match.month = month;
    }
    if (req.query.year !== undefined) {
      const year = Number.parseInt(req.query.year, 10);
      const currentYear = new Date().getFullYear();
      if (!Number.isInteger(year) || year < 1970 || year > currentYear + 1) {
        return res.status(400).json({ error: 'Invalid year' });
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
