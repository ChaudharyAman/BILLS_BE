const mongoose = require('mongoose');
const Income = require('../../models/Income');
const Expense = require('../../models/Expense');

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

  return { startDate, endDate };
};

const aggregateByCategory = async (Model, userId, startDate, endDate) => {
  const matchUser = mongoose.Types.ObjectId.isValid(String(userId)) ? new mongoose.Types.ObjectId(String(userId)) : userId;
  return Model.aggregate([
    {
      $match: {
        user: matchUser,
        date: { $gte: startDate, $lte: endDate },
        status: { $ne: 'CANCELLED' },
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
      categoryId: '$_id',
      name: { $ifNull: ['$category.name', 'Uncategorized'] },
      total: 1,
    },
  },
  { $sort: { total: -1 } },
]);
};

exports.getProfitLoss = async (req, res) => {
  try {
    const { startDate, endDate } = parseDateRange(req.query);
    const [revenue, expenses] = await Promise.all([
      aggregateByCategory(Income, req.user._id, startDate, endDate),
      aggregateByCategory(Expense, req.user._id, startDate, endDate),
    ]);
    const totalRevenue = revenue.reduce((sum, item) => sum + item.total, 0);
    const totalExpenses = expenses.reduce((sum, item) => sum + item.total, 0);
    res.json({
      revenue,
      totalRevenue,
      expenses,
      totalExpenses,
      netIncome: totalRevenue - totalExpenses,
      period: { startDate, endDate },
    });
  } catch (error) {
    console.error('Error building profit and loss report:', error);
    if (error.message === 'Invalid startDate' || error.message === 'Invalid endDate') {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Server error building profit and loss report' });
  }
};
