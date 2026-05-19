const Income = require('../../models/Income');
const Expense = require('../../models/Expense');
const Invoice = require('../../models/Invoice');
const Payroll = require('../../models/Payroll');

const parseDateRange = (query) => {
  const now = new Date();
  const startDate = query.startDate ? new Date(query.startDate) : new Date(now.getFullYear(), now.getMonth(), 1);
  const endDate = query.endDate ? new Date(query.endDate) : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  if (query.startDate && Number.isNaN(startDate.getTime())) {
    throw new Error('Invalid startDate');
  }
  if (query.endDate && Number.isNaN(endDate.getTime())) {
    throw new Error('Invalid endDate');
  }

  endDate.setHours(23, 59, 59, 999);
  return { startDate, endDate };
};

const sum = (items, field) => items.reduce((total, item) => total + (Number(item[field]) || 0), 0);

const aggregateTotals = async (Model, userId, startDate, endDate, fields) => {
  const project = fields.reduce((acc, field) => {
    acc[field] = { $sum: `$${field}` };
    return acc;
  }, {});

  const [result] = await Model.aggregate([
    {
      $match: {
        user: userId,
        date: { $gte: startDate, $lte: endDate },
        status: { $nin: ['DRAFT', 'CANCELLED'] },
      },
    },
    { $group: { _id: null, ...project } },
  ]);

  return result || fields.reduce((acc, field) => ({ ...acc, [field]: 0 }), {});
};

const getExpenseCategories = async (userId, startDate, endDate) => Expense.aggregate([
  {
    $match: {
      user: userId,
      date: { $gte: startDate, $lte: endDate },
      status: { $nin: ['DRAFT', 'CANCELLED'] },
    },
  },
  { $group: { _id: '$category', total: { $sum: '$grandTotal' } } },
  {
    $lookup: {
      from: 'categories',
      localField: '_id',
      foreignField: '_id',
      as: 'category',
    },
  },
  { $unwind: { path: '$category', preserveNullAndEmptyArrays: true } },
  {
    $project: {
      _id: 0,
      name: { $ifNull: ['$category.name', 'Uncategorized'] },
      total: 1,
    },
  },
  { $sort: { total: -1 } },
  { $limit: 6 },
]);

const getRecentIncome = async (userId, startDate, endDate) => Income.find({
  user: userId,
  date: { $gte: startDate, $lte: endDate },
  status: { $nin: ['DRAFT', 'CANCELLED'] },
})
  .sort({ date: -1, createdAt: -1 })
  .limit(4)
  .select('incomeNumber client vendor grandTotal taxTotal date status')
  .populate('client.clientRef', 'name')
  .populate('vendor.vendorRef', 'name')
  .lean();

const getRecentExpenses = async (userId, startDate, endDate) => Expense.find({
  user: userId,
  date: { $gte: startDate, $lte: endDate },
  status: { $nin: ['DRAFT', 'CANCELLED'] },
})
  .sort({ date: -1, createdAt: -1 })
  .limit(4)
  .select('expenseNumber vendor client grandTotal taxTotal date status')
  .populate('vendor.vendorRef', 'name')
  .populate('client.clientRef', 'name')
  .lean();

const getTrend = async (userId, endDate) => {
  const end = new Date(endDate);
  const start = new Date(end.getFullYear(), end.getMonth() - 5, 1);
  const endOfRange = new Date(end.getFullYear(), end.getMonth() + 1, 0, 23, 59, 59, 999);

  const makePipeline = () => [
    {
      $match: {
        user: userId,
        date: { $gte: start, $lte: endOfRange },
        status: { $nin: ['DRAFT', 'CANCELLED'] },
      },
    },
    {
      $group: {
        _id: { year: { $year: '$date' }, month: { $month: '$date' } },
        total: { $sum: '$grandTotal' },
      },
    },
  ];

  const [incomeRows, expenseRows] = await Promise.all([
    Income.aggregate(makePipeline()),
    Expense.aggregate(makePipeline()),
  ]);

  const incomeMap = new Map(incomeRows.map((item) => [`${item._id.year}-${item._id.month}`, item.total]));
  const expenseMap = new Map(expenseRows.map((item) => [`${item._id.year}-${item._id.month}`, item.total]));

  return Array.from({ length: 6 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth() + index, 1);
    const key = `${date.getFullYear()}-${date.getMonth() + 1}`;
    return {
      month: date.toLocaleString('en-IN', { month: 'short' }),
      revenue: incomeMap.get(key) || 0,
      expenses: expenseMap.get(key) || 0,
    };
  });
};

const getPayrollTdsPayable = async (userId, startDate, endDate) => {
  const startYear = startDate.getFullYear();
  const startMonth = startDate.getMonth() + 1;
  const endYear = endDate.getFullYear();
  const endMonth = endDate.getMonth() + 1;

  const [result] = await Payroll.aggregate([
    {
      $match: {
        user: userId,
        status: { $ne: 'CANCELLED' },
        $or: [
          { paymentDate: { $gte: startDate, $lte: endDate } },
          {
            paymentDate: { $exists: false },
            $or: [
              {
                $and: [
                  { year: { $gt: startYear } },
                  { year: { $lt: endYear } },
                ],
              },
              {
                $and: [
                  { year: startYear },
                  { month: { $gte: startMonth } },
                ],
              },
              {
                $and: [
                  { year: endYear },
                  { month: { $lte: endMonth } },
                ],
              },
            ],
          },
        ],
      },
    },
    { $group: { _id: null, total: { $sum: '$deductions.tds' } } },
  ]);

  return result?.total || 0;
};

const getReceivables = async (userId) => {
  const [result] = await Invoice.aggregate([
    {
      $match: {
        user: userId,
        status: { $nin: ['DRAFT', 'PAID', 'CANCELLED'] },
      },
    },
    { $group: { _id: null, total: { $sum: '$balanceDue' } } },
  ]);

  return result?.total || 0;
};

const getPayables = async (userId) => {
  const [result] = await Expense.aggregate([
    {
      $match: {
        user: userId,
        status: { $nin: ['DRAFT', 'PAID', 'CANCELLED'] },
      },
    },
    { $group: { _id: null, total: { $sum: '$balanceDue' } } },
  ]);

  return result?.total || 0;
};

exports.getTaxDashboard = async (req, res) => {
  try {
    const { startDate, endDate } = parseDateRange(req.query);
    const userId = req.user._id;

    const [
      incomeTotals,
      expenseTotals,
      invoiceTotals,
      expenseCategories,
      recentIncome,
      recentExpenses,
      trend,
      tdsPayable,
      receivables,
      payables,
    ] = await Promise.all([
      aggregateTotals(Income, userId, startDate, endDate, ['subTotal', 'taxTotal', 'grandTotal']),
      aggregateTotals(Expense, userId, startDate, endDate, ['subTotal', 'taxTotal', 'grandTotal']),
      aggregateTotals(Invoice, userId, startDate, endDate, ['subTotal', 'taxTotal', 'grandTotal', 'totalCGST', 'totalSGST', 'totalIGST', 'tds', 'tcs']),
      getExpenseCategories(userId, startDate, endDate),
      getRecentIncome(userId, startDate, endDate),
      getRecentExpenses(userId, startDate, endDate),
      getTrend(userId, endDate),
      getPayrollTdsPayable(userId, startDate, endDate),
      getReceivables(userId),
      getPayables(userId),
    ]);

    const gstLiability = Number(invoiceTotals.taxTotal) || 0;
    const gstCredit = Number(expenseTotals.taxTotal) || 0;
    const netGstPayable = Math.max(gstLiability - gstCredit, 0);
    const tdsDeducted = Number(invoiceTotals.tds) || 0;
    const netTaxPayable = Math.max(netGstPayable + tdsPayable - tdsDeducted, 0);

    res.json({
      period: { startDate, endDate },
      summary: {
        totalRevenue: Number(incomeTotals.grandTotal) || 0,
        totalExpenses: Number(expenseTotals.grandTotal) || 0,
        netProfit: (Number(incomeTotals.grandTotal) || 0) - (Number(expenseTotals.grandTotal) || 0),
        taxableRevenue: Number(incomeTotals.subTotal) || 0,
        gstLiability,
        gstCredit,
        netGstPayable,
        tdsDeducted,
        tdsPayable,
        receivables,
        payables,
        netTaxPayable,
        tcsCollected: Number(invoiceTotals.tcs) || 0,
      },
      gst: {
        cgst: Number(invoiceTotals.totalCGST) || 0,
        sgst: Number(invoiceTotals.totalSGST) || 0,
        igst: Number(invoiceTotals.totalIGST) || 0,
        liability: gstLiability,
        credit: gstCredit,
        netPayable: netGstPayable,
      },
      categories: expenseCategories,
      recentIncome: recentIncome.map((item) => ({
        id: item._id,
        number: item.incomeNumber,
        party: item.client?.name || item.vendor?.name || 'Income',
        amount: item.grandTotal,
        tax: item.taxTotal,
        date: item.date,
        status: item.status,
      })),
      recentExpenses: recentExpenses.map((item) => ({
        id: item._id,
        number: item.expenseNumber,
        party: item.vendor?.name || item.client?.name || 'Expense',
        amount: item.grandTotal,
        tax: item.taxTotal,
        date: item.date,
        status: item.status,
      })),
      trend,
      totals: {
        incomeTax: Number(incomeTotals.taxTotal) || 0,
        expenseTax: Number(expenseTotals.taxTotal) || 0,
        categoryExpenses: sum(expenseCategories, 'total'),
      },
    });
  } catch (error) {
    console.error('Error building tax dashboard:', error);
    if (error.message === 'Invalid startDate' || error.message === 'Invalid endDate') {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Server error building tax dashboard' });
  }
};
