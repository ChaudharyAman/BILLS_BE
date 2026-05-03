const Payroll = require('../../models/Payroll');

exports.getPayrollSummary = async (req, res) => {
  try {
    const match = { user: req.user._id };
    if (req.query.month) match.month = Number(req.query.month);
    if (req.query.year) match.year = Number(req.query.year);

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
      { $unwind: '$employee' },
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
