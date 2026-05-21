const Income = require('../../models/Income');
const Expense = require('../../models/Expense');
const Asset = require('../../models/Asset');
const Liability = require('../../models/Liability');
const { parseMonthlyDateRange } = require('../../utils/dateRange');

const sumField = async (Model, match, field) => {
  const result = await Model.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: field } } },
  ]);
  return result[0]?.total || 0;
};

exports.getCashFlow = async (req, res) => {
  try {
    const { startDate, endDate } = parseMonthlyDateRange(req.query);

    const [totalIncome, totalExpense, assetPurchases, assetDisposals, liabilityPrincipal] = await Promise.all([
      sumField(Income, { user: req.user._id, date: { $gte: startDate, $lte: endDate }, status: { $nin: ['DRAFT', 'CANCELLED'] } }, '$grandTotal'),
      sumField(Expense, { user: req.user._id, date: { $gte: startDate, $lte: endDate }, status: { $nin: ['DRAFT', 'CANCELLED'] } }, '$grandTotal'),
      sumField(Asset, { user: req.user._id, purchaseDate: { $gte: startDate, $lte: endDate } }, '$purchaseValue'),
      sumField(Asset, { user: req.user._id, disposalDate: { $gte: startDate, $lte: endDate }, status: { $in: ['disposed', 'sold'] } }, '$disposalValue'),
      sumField(Liability, { user: req.user._id, startDate: { $gte: startDate, $lte: endDate } }, '$principalAmount'),
    ]);

    const operating = totalIncome - totalExpense;
    const investing = assetDisposals - assetPurchases;
    const financing = liabilityPrincipal;
    res.json({
      operating,
      investing,
      financing,
      netCashFlow: operating + investing + financing,
      period: { startDate, endDate },
    });
  } catch (error) {
    console.error('Error building cash flow report:', error);
    if (error.message === 'Invalid startDate' || error.message === 'Invalid endDate') {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Server error building cash flow report' });
  }
};
