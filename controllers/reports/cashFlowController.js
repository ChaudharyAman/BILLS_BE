const mongoose = require('mongoose');
const Income = require('../../models/Income');
const Expense = require('../../models/Expense');
const Asset = require('../../models/Asset');
const Liability = require('../../models/Liability');
const CashLedgerEntry = require('../../models/CashLedgerEntry');
const { parseMonthlyDateRange } = require('../../utils/dateRange');

const roundTwo = (num) => Math.round((Number(num) || 0) * 100) / 100;

const sumField = async (Model, match, field) => {
  const result = await Model.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: field } } },
  ]);
  return result[0]?.total || 0;
};

exports.getCashFlow = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const userId = new mongoose.Types.ObjectId(String(companyId));
    const { startDate, endDate } = parseMonthlyDateRange(req.query);

    // Check if CashLedgerEntry records exist for this user
    const hasLedger = await CashLedgerEntry.exists({ user: userId, isDeleted: { $ne: true } });

    let operating = 0;
    let investing = 0;
    let financing = 0;

    if (hasLedger) {
      // Primary source: single source of truth cash ledger entries
      const entries = await CashLedgerEntry.aggregate([
        {
          $match: {
            user: userId,
            date: { $gte: startDate, $lte: endDate },
            isDeleted: { $ne: true },
          },
        },
        {
          $group: {
            _id: '$type',
            total: { $sum: '$amount' },
          },
        },
      ]);

      const typeMap = new Map(entries.map(e => [e._id, e.total]));

      const opTypes = ['invoice_payment', 'expense_payment', 'income_receipt', 'manual_adjustment'];
      const invTypes = ['asset_purchase', 'asset_disposal'];
      const finTypes = ['liability_draw', 'liability_repayment', 'capital_contribution', 'capital_withdrawal'];

      operating = roundTwo(opTypes.reduce((sum, t) => sum + (typeMap.get(t) || 0), 0));
      investing = roundTwo(invTypes.reduce((sum, t) => sum + (typeMap.get(t) || 0), 0));
      financing = roundTwo(finTypes.reduce((sum, t) => sum + (typeMap.get(t) || 0), 0));
    } else {
      // Fallback: document-level aggregates
      const [totalIncome, totalExpense, assetPurchases, assetDisposals, liabilityPrincipal] = await Promise.all([
        sumField(Income, { user: companyId, date: { $gte: startDate, $lte: endDate }, status: { $nin: ['DRAFT', 'CANCELLED'] }, isDeleted: { $ne: true } }, '$grandTotal'),
        sumField(Expense, { user: companyId, date: { $gte: startDate, $lte: endDate }, status: { $nin: ['DRAFT', 'CANCELLED'] }, isDeleted: { $ne: true } }, '$grandTotal'),
        sumField(Asset, { user: companyId, purchaseDate: { $gte: startDate, $lte: endDate }, isDeleted: { $ne: true } }, '$purchaseValue'),
        sumField(Asset, { user: companyId, disposalDate: { $gte: startDate, $lte: endDate }, status: { $in: ['disposed', 'sold'] }, isDeleted: { $ne: true } }, '$disposalValue'),
        sumField(Liability, { user: companyId, startDate: { $gte: startDate, $lte: endDate }, isDeleted: { $ne: true } }, '$principalAmount'),
      ]);

      operating = roundTwo(totalIncome - totalExpense);
      investing = roundTwo(assetDisposals - assetPurchases);
      financing = roundTwo(liabilityPrincipal);
    }

    const netCashFlow = roundTwo(operating + investing + financing);

    res.json({
      operating,
      investing,
      financing,
      netCashFlow,
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
