const mongoose = require('mongoose');
const Invoice = require('../../models/Invoice');
const Expense = require('../../models/Expense');
const Asset = require('../../models/Asset');
const Liability = require('../../models/Liability');
const Category = require('../../models/Category');
const EquityTransaction = require('../../models/EquityTransaction');
const AccrualEntry = require('../../models/AccrualEntry');
const Payroll = require('../../models/Payroll');
const Item = require('../../models/Item');
const { computeAssetDepreciation, computePeriodDepreciation } = require('../depreciation');

const roundTwo = (num) => Math.round((Number(num) || 0) * 100) / 100;

const ACTIVE_INVOICE_STATUSES = ['SENT', 'PAID', 'PARTIAL', 'UNPAID'];
const ACTIVE_EXPENSE_STATUSES = { $nin: ['DRAFT', 'CANCELLED'] };

/**
 * Validates and parses reporting year/date ranges.
 */
function parseYearOrDateRange(query = {}) {
  const now = new Date();
  const currentSystemYear = now.getUTCFullYear();

  let targetYear = currentSystemYear;

  if (query.year !== undefined && query.year !== '') {
    const parsed = Number(query.year);
    if (!Number.isInteger(parsed) || parsed < 1970 || parsed > currentSystemYear + 1) {
      throw new Error(`Invalid year parameter. Year must be between 1970 and ${currentSystemYear + 1}.`);
    }
    targetYear = parsed;
  } else if (query.asOfDate) {
    const asOf = new Date(query.asOfDate);
    if (Number.isNaN(asOf.getTime())) {
      throw new Error('Invalid asOfDate parameter.');
    }
    const asOfYear = asOf.getUTCFullYear();
    if (asOfYear < 1970 || asOfYear > currentSystemYear + 1) {
      throw new Error(`Invalid asOfDate. Year must be between 1970 and ${currentSystemYear + 1}.`);
    }
    targetYear = asOfYear;
  }

  const priorYear = targetYear - 1;

  const curStart = new Date(Date.UTC(targetYear, 0, 1, 0, 0, 0, 0));
  const curEnd = new Date(Date.UTC(targetYear, 11, 31, 23, 59, 59, 999));

  const priorStart = new Date(Date.UTC(priorYear, 0, 1, 0, 0, 0, 0));
  const priorEnd = new Date(Date.UTC(priorYear, 11, 31, 23, 59, 59, 999));

  return {
    targetYear,
    priorYear,
    curStart,
    curEnd,
    priorStart,
    priorEnd,
  };
}

/**
 * Sales within period
 */
async function getPeriodSales(userId, startDate, endDate) {
  const result = await Invoice.aggregate([
    {
      $match: {
        user: userId,
        date: { $gte: startDate, $lte: endDate },
        status: { $in: ACTIVE_INVOICE_STATUSES },
        isDeleted: { $ne: true },
      },
    },
    { $group: { _id: null, total: { $sum: '$grandTotal' } } },
  ]);
  return roundTwo(result[0]?.total || 0);
}

/**
 * Expenses within period
 */
async function getPeriodExpenses(userId, startDate, endDate) {
  const result = await Expense.aggregate([
    {
      $match: {
        user: userId,
        date: { $gte: startDate, $lte: endDate },
        status: ACTIVE_EXPENSE_STATUSES,
        isDeleted: { $ne: true },
      },
    },
    { $group: { _id: null, total: { $sum: '$grandTotal' } } },
  ]);
  return roundTwo(result[0]?.total || 0);
}

/**
 * COGS within period (Expenses under categories marked with isCogs: true)
 */
async function getPeriodCogs(userId, startDate, endDate) {
  const cogsCategories = await Category.find({
    user: userId,
    isCogs: true,
    isDeleted: { $ne: true },
  }).select('_id').lean();

  if (!cogsCategories.length) {
    return { hasCogs: false, total: null, categoryIds: [] };
  }

  const categoryIds = cogsCategories.map(c => c._id);
  const result = await Expense.aggregate([
    {
      $match: {
        user: userId,
        category: { $in: categoryIds },
        date: { $gte: startDate, $lte: endDate },
        status: ACTIVE_EXPENSE_STATUSES,
        isDeleted: { $ne: true },
      },
    },
    { $group: { _id: null, total: { $sum: '$grandTotal' } } },
  ]);

  return {
    hasCogs: true,
    total: roundTwo(result[0]?.total || 0),
    categoryIds,
  };
}

/**
 * Interest Expense within period
 */
async function getPeriodInterestExpense(userId, startDate, endDate) {
  const interestCategories = await Category.find({
    user: userId,
    name: { $regex: /interest\s*expense/i },
    isDeleted: { $ne: true },
  }).select('_id').lean();

  if (!interestCategories.length) {
    return { hasCategory: false, total: null, categoryIds: [] };
  }

  const categoryIds = interestCategories.map(c => c._id);
  const result = await Expense.aggregate([
    {
      $match: {
        user: userId,
        category: { $in: categoryIds },
        date: { $gte: startDate, $lte: endDate },
        status: ACTIVE_EXPENSE_STATUSES,
        isDeleted: { $ne: true },
      },
    },
    { $group: { _id: null, total: { $sum: '$grandTotal' } } },
  ]);

  return {
    hasCategory: true,
    total: roundTwo(result[0]?.total || 0),
    categoryIds,
  };
}

/**
 * Operating Expenses excluding COGS and Interest Expense
 */
async function getPeriodOperatingExpenses(userId, startDate, endDate, excludedCategoryIds = []) {
  const match = {
    user: userId,
    date: { $gte: startDate, $lte: endDate },
    status: ACTIVE_EXPENSE_STATUSES,
    isDeleted: { $ne: true },
  };

  if (excludedCategoryIds.length > 0) {
    match.category = { $nin: excludedCategoryIds };
  }

  const result = await Expense.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$grandTotal' } } },
  ]);

  return roundTwo(result[0]?.total || 0);
}

/**
 * Tax within period
 */
async function getPeriodTax(userId, startDate, endDate) {
  const result = await Invoice.aggregate([
    {
      $match: {
        user: userId,
        date: { $gte: startDate, $lte: endDate },
        status: { $in: ACTIVE_INVOICE_STATUSES },
        isDeleted: { $ne: true },
      },
    },
    { $group: { _id: null, total: { $sum: '$taxTotal' } } },
  ]);
  return roundTwo(result[0]?.total || 0);
}

/**
 * Outstanding receivables as of date
 */
async function getReceivablesAsOf(userId, asOfDate) {
  const result = await Invoice.aggregate([
    {
      $match: {
        user: userId,
        date: { $lte: asOfDate },
        status: { $in: ['SENT', 'PARTIAL', 'UNPAID'] },
        balanceDue: { $gt: 0 },
        isDeleted: { $ne: true },
      },
    },
    { $group: { _id: null, total: { $sum: '$balanceDue' } } },
  ]);
  return roundTwo(result[0]?.total || 0);
}

/**
 * Outstanding payables as of date
 */
async function getPayablesAsOf(userId, asOfDate) {
  const result = await Expense.aggregate([
    {
      $match: {
        user: userId,
        date: { $lte: asOfDate },
        status: { $in: ['UNPAID', 'PARTIAL', 'APPROVED'] },
        balanceDue: { $gt: 0 },
        isDeleted: { $ne: true },
      },
    },
    { $group: { _id: null, total: { $sum: '$balanceDue' } } },
  ]);
  return roundTwo(result[0]?.total || 0);
}

/**
 * Accruals as of date (unpaid pending payroll + unbilled recognized obligations from AccrualEntry)
 */
async function getAccrualsAsOf(userId, asOfDate) {
  const asOfYear = asOfDate.getUTCFullYear();
  const asOfMonth = asOfDate.getUTCMonth() + 1;

  // 1. Unbilled AccrualEntry records
  const accrualResult = await AccrualEntry.aggregate([
    {
      $match: {
        user: userId,
        date: { $lte: asOfDate },
        status: 'accrued',
        isDeleted: { $ne: true },
      },
    },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const manualAccruals = accrualResult[0]?.total || 0;

  // 2. Unpaid / pending payroll runs up to this period
  const payrollResult = await Payroll.aggregate([
    {
      $match: {
        user: userId,
        status: { $in: ['draft', 'processed', 'approved'] },
        $or: [
          { year: { $lt: asOfYear } },
          { year: asOfYear, month: { $lte: asOfMonth } },
        ],
        isDeleted: { $ne: true },
      },
    },
    { $group: { _id: null, total: { $sum: '$netSalary' } } },
  ]);
  const unpaidPayroll = payrollResult[0]?.total || 0;

  const total = roundTwo(manualAccruals + unpaidPayroll);

  return {
    hasAccruals: true,
    total,
    manualAccruals,
    unpaidPayroll,
  };
}

/**
 * TDS Receivable as of date
 */
async function getTdsReceivableAsOf(userId, asOfDate) {
  const result = await Invoice.aggregate([
    {
      $match: {
        user: userId,
        date: { $lte: asOfDate },
        status: { $in: ACTIVE_INVOICE_STATUSES },
        isDeleted: { $ne: true },
      },
    },
    {
      $group: {
        _id: null,
        total: {
          $sum: {
            $max: [
              { $ifNull: ['$tds_amount', 0] },
              { $ifNull: ['$tdsAmount', 0] },
              { $ifNull: ['$tds', 0] },
              { $ifNull: ['$tds_receivable_amount', 0] }
            ],
          },
        },
      },
    },
  ]);
  return roundTwo(result[0]?.total || 0);
}

/**
 * Assets as of date grouped by category
 */
async function getAssetsAsOf(userId, asOfDate) {
  const rows = await Asset.aggregate([
    {
      $match: {
        user: userId,
        status: 'active',
        category: { $ne: 'fixed' },
        isDeleted: { $ne: true },
        $or: [
          { purchaseDate: { $lte: asOfDate } },
          { createdAt: { $lte: asOfDate } },
        ],
      },
    },
    {
      $group: {
        _id: '$category',
        total: { $sum: { $ifNull: ['$currentValue', '$purchaseValue'] } },
      },
    },
    { $project: { _id: 0, category: '$_id', total: 1 } },
  ]);

  return rows.map(r => ({ category: r.category, total: roundTwo(r.total) }));
}

/**
 * Net Fixed Assets & Depreciation calculation
 */
async function getFixedAssetsAndDepreciation(userId, startDate, endDate, asOfDate) {
  const fixedAssets = await Asset.find({
    user: userId,
    category: 'fixed',
    status: 'active',
    isDeleted: { $ne: true },
    $or: [
      { purchaseDate: { $lte: asOfDate } },
      { createdAt: { $lte: asOfDate } },
    ],
  }).lean();

  if (!fixedAssets.length) {
    return {
      hasFixedAssets: false,
      netFixedAssets: null,
      depreciationExpense: null,
      count: 0,
    };
  }

  let totalBookValue = 0;
  let totalPeriodDepreciation = 0;

  for (const asset of fixedAssets) {
    const { bookValue } = computeAssetDepreciation(asset, asOfDate);
    const periodDep = computePeriodDepreciation(asset, startDate, endDate);
    totalBookValue += bookValue;
    totalPeriodDepreciation += periodDep;
  }

  return {
    hasFixedAssets: true,
    netFixedAssets: roundTwo(totalBookValue),
    depreciationExpense: roundTwo(totalPeriodDepreciation),
    count: fixedAssets.length,
  };
}

/**
 * Liabilities as of date grouped by type & category
 */
async function getLiabilitiesAsOf(userId, asOfDate) {
  const rows = await Liability.aggregate([
    {
      $match: {
        user: userId,
        status: 'active',
        isDeleted: { $ne: true },
        $or: [
          { startDate: { $lte: asOfDate } },
          { createdAt: { $lte: asOfDate } },
        ],
      },
    },
    {
      $group: {
        _id: { type: '$type', category: '$category' },
        total: { $sum: '$outstandingAmount' },
        currentPortionTotal: { $sum: { $ifNull: ['$currentPortionAmount', 0] } },
      },
    },
    {
      $project: {
        _id: 0,
        type: '$_id.type',
        category: '$_id.category',
        total: 1,
        currentPortionTotal: 1,
      },
    },
  ]);

  return rows.map(r => ({
    type: r.type,
    category: r.category,
    total: roundTwo(r.total),
    currentPortionTotal: roundTwo(r.currentPortionTotal || 0),
  }));
}

/**
 * Equity transactions as of date grouped by type and calculated splits
 */
async function getEquityTransactionsAsOf(userId, asOfDate) {
  const rows = await EquityTransaction.find({
    user: userId,
    date: { $lte: asOfDate },
    isDeleted: { $ne: true },
  }).lean();

  let commonStockTotal = 0;
  let apicTotal = 0;
  let distributionsTotal = 0;
  let retainedAdjustmentTotal = 0;

  for (const tx of rows) {
    const amt = Number(tx.amount) || 0;
    switch (tx.type) {
      case 'share_issuance':
        const csPortion = Number(tx.commonStockAmount) || amt;
        const apicPortion = Number(tx.apicAmount) || Math.max(0, amt - csPortion);
        commonStockTotal += csPortion;
        apicTotal += apicPortion;
        break;

      case 'owner_contribution':
      case 'opening_equity_balance':
      case 'common_stock_issued':
        commonStockTotal += amt;
        break;

      case 'additional_paid_in_capital':
        apicTotal += amt;
        break;

      case 'owner_distribution':
      case 'capital_withdrawal':
        distributionsTotal += amt;
        break;

      case 'accountant_adjustment':
      case 'retained_earnings_adjustment':
        retainedAdjustmentTotal += amt;
        break;

      default:
        commonStockTotal += amt;
        break;
    }
  }

  const hasCommonStock = commonStockTotal > 0;
  const hasApic = apicTotal > 0;
  const hasAnyEquity = rows.length > 0;

  // Common stock reflects raw contributed capital; distributions are applied against retained earnings
  const netCommonStock = hasCommonStock ? roundTwo(commonStockTotal) : null;
  const netApic = hasApic ? roundTwo(apicTotal) : (hasCommonStock ? 0 : null);

  return {
    hasAnyEquity,
    hasApic,
    hasCommonStock,
    commonStock: netCommonStock,
    additionalPaidInCapital: netApic,
    capitalWithdrawal: hasAnyEquity ? roundTwo(distributionsTotal) : null,
    distributionsTotal: roundTwo(distributionsTotal),
    retainedEarningsAdjustment: hasAnyEquity ? roundTwo(retainedAdjustmentTotal) : null,
  };
}

/**
 * Cumulative retained earnings as of date (since company inception)
 */
async function getCumulativeRetainedEarningsAsOf(userId, asOfDate) {
  const [salesRes, expRes, taxRes, equityData, fixedAssets] = await Promise.all([
    Invoice.aggregate([
      {
        $match: {
          user: userId,
          date: { $lte: asOfDate },
          status: { $in: ACTIVE_INVOICE_STATUSES },
          isDeleted: { $ne: true },
        },
      },
      { $group: { _id: null, total: { $sum: '$grandTotal' } } },
    ]),
    Expense.aggregate([
      {
        $match: {
          user: userId,
          date: { $lte: asOfDate },
          status: ACTIVE_EXPENSE_STATUSES,
          isDeleted: { $ne: true },
        },
      },
      { $group: { _id: null, total: { $sum: '$grandTotal' } } },
    ]),
    Invoice.aggregate([
      {
        $match: {
          user: userId,
          date: { $lte: asOfDate },
          status: { $in: ACTIVE_INVOICE_STATUSES },
          isDeleted: { $ne: true },
        },
      },
      { $group: { _id: null, total: { $sum: '$taxTotal' } } },
    ]),
    getEquityTransactionsAsOf(userId, asOfDate),
    Asset.find({
      user: userId,
      category: 'fixed',
      status: 'active',
      isDeleted: { $ne: true },
      $or: [
        { purchaseDate: { $lte: asOfDate } },
        { createdAt: { $lte: asOfDate } },
      ],
    }).lean(),
  ]);

  const cumSales = salesRes[0]?.total || 0;
  const cumExp = expRes[0]?.total || 0;
  const cumTax = taxRes[0]?.total || 0;
  const adjustments = equityData.retainedEarningsAdjustment || 0;
  const cumDistributions = Number(equityData.distributionsTotal || equityData.capitalWithdrawal || 0);

  // Cumulative depreciation across all periods through asOfDate
  let totalCumDepreciation = 0;
  for (const asset of fixedAssets) {
    const depInfo = computeAssetDepreciation(asset, asOfDate);
    totalCumDepreciation += depInfo.accumulatedDepreciation;
  }
  const cumDepreciation = roundTwo(totalCumDepreciation);

  // Known limitation: If user logged a manual "Depreciation" Expense record, this could double-count.
  const retainedEarnings = roundTwo(cumSales - cumExp - cumTax - cumDepreciation - cumDistributions + adjustments);

  return {
    retainedEarnings,
    cumSales: roundTwo(cumSales),
    cumExp: roundTwo(cumExp),
    cumTax: roundTwo(cumTax),
    cumDepreciation,
    cumDistributions: roundTwo(cumDistributions),
    adjustments: roundTwo(adjustments),
  };
}

/**
 * Inventory valuation as of specific date based on items created on/before asOfDate
 */
async function getInventoryValuationAsOf(userId, asOfDate) {
  const result = await Item.aggregate([
    {
      $match: {
        user: userId,
        isDeleted: { $ne: true },
        openingQuantity: { $gt: 0 },
        createdAt: { $lte: asOfDate },
      },
    },
    {
      $group: {
        _id: null,
        totalValuation: {
          $sum: {
            $multiply: [
              '$openingQuantity',
              { $ifNull: ['$purchasePrice', { $ifNull: ['$purchaseInfo.price', '$rate'] }] },
            ],
          },
        },
        count: { $sum: 1 },
      },
    },
  ]);

  if (!result.length || result[0].count === 0) {
    return {
      hasInventory: false,
      totalValuation: null,
    };
  }

  return {
    hasInventory: true,
    totalValuation: roundTwo(result[0].totalValuation),
  };
}

module.exports = {
  roundTwo,
  parseYearOrDateRange,
  getPeriodSales,
  getPeriodExpenses,
  getPeriodCogs,
  getPeriodInterestExpense,
  getPeriodOperatingExpenses,
  getPeriodTax,
  getReceivablesAsOf,
  getPayablesAsOf,
  getAccrualsAsOf,
  getTdsReceivableAsOf,
  getAssetsAsOf,
  getFixedAssetsAndDepreciation,
  getLiabilitiesAsOf,
  getEquityTransactionsAsOf,
  getCumulativeRetainedEarningsAsOf,
  getInventoryValuationAsOf,
};
