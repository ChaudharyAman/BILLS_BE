const Income = require('../../models/Income');
const Expense = require('../../models/Expense');
const Asset = require('../../models/Asset');
const Liability = require('../../models/Liability');

const sumField = async (Model, match, field) => {
  const result = await Model.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: field } } },
  ]);
  return result[0]?.total || 0;
};

exports.getCashFlow = async (req, res) => {
  try {
    const now = new Date();
    const startDate = req.query.startDate ? new Date(req.query.startDate) : new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = req.query.endDate ? new Date(req.query.endDate) : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    if (req.query.startDate && Number.isNaN(startDate.getTime())) {
      return res.status(400).json({ message: 'Invalid startDate' });
    }
    if (req.query.endDate && Number.isNaN(endDate.getTime())) {
      return res.status(400).json({ message: 'Invalid endDate' });
    }

    const [totalIncome, totalExpense, assetPurchases, assetDisposals, liabilityPrincipal] = await Promise.all([
      sumField(Income, { user: req.user._id, date: { $gte: startDate, $lte: endDate }, status: { $ne: 'CANCELLED' } }, '$grandTotal'),
      sumField(Expense, { user: req.user._id, date: { $gte: startDate, $lte: endDate }, status: { $ne: 'CANCELLED' } }, '$grandTotal'),
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
    res.status(500).json({ message: 'Server error building cash flow report' });
  }
};
