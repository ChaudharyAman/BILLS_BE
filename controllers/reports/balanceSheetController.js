const mongoose = require('mongoose');
const { getCashBalanceAsOf, roundTwo } = require('../../utils/cashLedgerHelper');
const {
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
} = require('../../utils/reports/periodAggregates');
const Item = require('../../models/Item');
const EquityTransaction = require('../../models/EquityTransaction');
const Category = require('../../models/Category');
const Asset = require('../../models/Asset');
const Liability = require('../../models/Liability');

exports.getBalanceSheet = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const userId = new mongoose.Types.ObjectId(String(companyId));

    let range;
    try {
      range = parseYearOrDateRange(req.query);
    } catch (err) {
      return res.status(400).json({ message: err.message });
    }

    const { targetYear, priorYear, curStart, curEnd, priorStart, priorEnd } = range;

    const [
      curCashData,
      priorCashData,
      curAssetsList,
      priorAssetsList,
      curFixedAssetData,
      priorFixedAssetData,
      curLiabilitiesList,
      priorLiabilitiesList,
      curTds,
      priorTds,
      curRec,
      priorRec,
      curPay,
      priorPay,
      curAccrualsData,
      priorAccrualsData,
      curSales,
      priorSales,
      curExp,
      priorExp,
      curCogsData,
      priorCogsData,
      curInterestData,
      priorInterestData,
      curTax,
      priorTax,
      curEquity,
      priorEquity,
      curRetainedData,
      priorRetainedData,
      curInvData,
      priorInvData,
    ] = await Promise.all([
      getCashBalanceAsOf(userId, curEnd),
      getCashBalanceAsOf(userId, priorEnd),
      getAssetsAsOf(userId, curEnd),
      getAssetsAsOf(userId, priorEnd),
      getFixedAssetsAndDepreciation(userId, curStart, curEnd, curEnd),
      getFixedAssetsAndDepreciation(userId, priorStart, priorEnd, priorEnd),
      getLiabilitiesAsOf(userId, curEnd),
      getLiabilitiesAsOf(userId, priorEnd),
      getTdsReceivableAsOf(userId, curEnd),
      getTdsReceivableAsOf(userId, priorEnd),
      getReceivablesAsOf(userId, curEnd),
      getReceivablesAsOf(userId, priorEnd),
      getPayablesAsOf(userId, curEnd),
      getPayablesAsOf(userId, priorEnd),
      getAccrualsAsOf(userId, curEnd),
      getAccrualsAsOf(userId, priorEnd),
      getPeriodSales(userId, curStart, curEnd),
      getPeriodSales(userId, priorStart, priorEnd),
      getPeriodExpenses(userId, curStart, curEnd),
      getPeriodExpenses(userId, priorStart, priorEnd),
      getPeriodCogs(userId, curStart, curEnd),
      getPeriodCogs(userId, priorStart, priorEnd),
      getPeriodInterestExpense(userId, curStart, curEnd),
      getPeriodInterestExpense(userId, priorStart, priorEnd),
      getPeriodTax(userId, curStart, curEnd),
      getPeriodTax(userId, priorStart, priorEnd),
      getEquityTransactionsAsOf(userId, curEnd),
      getEquityTransactionsAsOf(userId, priorEnd),
      getCumulativeRetainedEarningsAsOf(userId, curEnd),
      getCumulativeRetainedEarningsAsOf(userId, priorEnd),
      getInventoryValuationAsOf(userId, curEnd),
      getInventoryValuationAsOf(userId, priorEnd),
    ]);

    const cCash = curCashData.totalCash;
    const pCash = priorCashData.totalCash;

    // Operating expenses excluding COGS and Interest Expense to prevent double counting
    const excludedCurCategories = [
      ...(curCogsData.categoryIds || []),
      ...(curInterestData.categoryIds || []),
    ];
    const excludedPriorCategories = [
      ...(priorCogsData.categoryIds || []),
      ...(priorInterestData.categoryIds || []),
    ];

    const curInvTotal = curInvData.hasInventory ? curInvData.totalValuation : null;
    const priorInvTotal = priorInvData.hasInventory ? priorInvData.totalValuation : null;

    const curOperatingExp = await getPeriodOperatingExpenses(userId, curStart, curEnd, excludedCurCategories);
    const priorOperatingExp = await getPeriodOperatingExpenses(userId, priorStart, priorEnd, excludedPriorCategories);

    // Assets aggregation
    const assets = [...curAssetsList];
    if (cCash !== 0) {
      assets.unshift({ category: 'Cash & Bank Balances', total: cCash });
    }
    if (curRec > 0) {
      assets.push({ category: 'Accounts Receivable', total: curRec });
    }
    if (curTds > 0) {
      assets.push({ category: 'TDS Receivable', total: curTds });
    }
    if (curInvTotal !== null && curInvTotal > 0) {
      assets.push({ category: 'Inventories', total: curInvTotal });
    }
    if (curFixedAssetData.hasFixedAssets && curFixedAssetData.netFixedAssets > 0) {
      assets.push({ category: 'Net Fixed Assets', total: curFixedAssetData.netFixedAssets });
    }

    const totalAssets = roundTwo(assets.reduce((sum, item) => sum + item.total, 0));
    
    // Prior assets
    const priorAssets = [...priorAssetsList];
    if (pCash !== 0) {
      priorAssets.unshift({ category: 'Cash & Bank Balances', total: pCash });
    }
    if (priorRec > 0) {
      priorAssets.push({ category: 'Accounts Receivable', total: priorRec });
    }
    if (priorTds > 0) {
      priorAssets.push({ category: 'TDS Receivable', total: priorTds });
    }
    if (priorInvTotal !== null && priorInvTotal > 0) {
      priorAssets.push({ category: 'Inventories', total: priorInvTotal });
    }
    if (priorFixedAssetData.hasFixedAssets && priorFixedAssetData.netFixedAssets > 0) {
      priorAssets.push({ category: 'Net Fixed Assets', total: priorFixedAssetData.netFixedAssets });
    }
    const pTotalAssets = roundTwo(priorAssets.reduce((sum, item) => sum + item.total, 0));

    // Liabilities aggregation
    const liabilities = curLiabilitiesList.map(l => ({
      type: `${l.type} (${l.category || 'general'})`,
      total: l.total,
    }));
    if (curPay > 0) {
      liabilities.unshift({ type: 'Accounts Payable', total: curPay });
    }
    if (curAccrualsData.hasAccruals && curAccrualsData.total > 0) {
      liabilities.push({ type: 'Accruals', total: curAccrualsData.total });
    }
    const totalLiabilities = roundTwo(liabilities.reduce((sum, item) => sum + item.total, 0));

    // Prior liabilities
    const priorLiabilities = priorLiabilitiesList.map(l => ({
      type: `${l.type} (${l.category || 'general'})`,
      total: l.total,
    }));
    if (priorPay > 0) {
      priorLiabilities.unshift({ type: 'Accounts Payable', total: priorPay });
    }
    if (priorAccrualsData.hasAccruals && priorAccrualsData.total > 0) {
      priorLiabilities.push({ type: 'Accruals', total: priorAccrualsData.total });
    }
    const pTotalLiabilities = roundTwo(priorLiabilities.reduce((sum, item) => sum + item.total, 0));

    // Fixed assets & Depreciation
    const curNetFixedAssets = curFixedAssetData.hasFixedAssets ? curFixedAssetData.netFixedAssets : null;
    const priorNetFixedAssets = priorFixedAssetData.hasFixedAssets ? priorFixedAssetData.netFixedAssets : null;

    const curDepreciation = curFixedAssetData.hasFixedAssets ? curFixedAssetData.depreciationExpense : null;
    const priorDepreciation = priorFixedAssetData.hasFixedAssets ? priorFixedAssetData.depreciationExpense : null;

    // Debt categories from actual liabilities (separating short-term notes from long-term loans)
    const hasCurLtDebt = curLiabilitiesList.some(l => l.type === 'long-term');
    const hasPriorLtDebt = priorLiabilitiesList.some(l => l.type === 'long-term');
    const curLtDebt = hasCurLtDebt ? curLiabilitiesList.filter(l => l.type === 'long-term').reduce((s, l) => s + l.total, 0) : null;
    const priorLtDebt = hasPriorLtDebt ? priorLiabilitiesList.filter(l => l.type === 'long-term').reduce((s, l) => s + l.total, 0) : null;

    const curCurrentPortion = hasCurLtDebt ? curLiabilitiesList.filter(l => l.type === 'long-term').reduce((s, l) => s + l.currentPortionTotal, 0) : null;
    const priorCurrentPortion = hasPriorLtDebt ? priorLiabilitiesList.filter(l => l.type === 'long-term').reduce((s, l) => s + l.currentPortionTotal, 0) : null;

    // Notes payable represents short-term loans/credit lines (type === 'current')
    const hasCurShortLoans = curLiabilitiesList.some(l => (l.category === 'loan' || l.category === 'credit-card') && l.type !== 'long-term');
    const hasPriorShortLoans = priorLiabilitiesList.some(l => (l.category === 'loan' || l.category === 'credit-card') && l.type !== 'long-term');
    const curNotesPay = hasCurShortLoans ? curLiabilitiesList.filter(l => (l.category === 'loan' || l.category === 'credit-card') && l.type !== 'long-term').reduce((s, l) => s + l.total, 0) : null;
    const priorNotesPay = hasPriorShortLoans ? priorLiabilitiesList.filter(l => (l.category === 'loan' || l.category === 'credit-card') && l.type !== 'long-term').reduce((s, l) => s + l.total, 0) : null;

    // Retained earnings & Equity (Cumulative from company inception)
    const pRetainedEarnings = priorRetainedData.retainedEarnings;
    const cRetainedEarnings = curRetainedData.retainedEarnings;
    const cNetIncome = roundTwo(curSales - curExp - curTax - (curDepreciation || 0));
    const pNetIncome = roundTwo(priorSales - priorExp - priorTax - (priorDepreciation || 0));

    const commonStockVal = curEquity.commonStock;
    const pCommonStockVal = priorEquity.commonStock;
    const apicVal = curEquity.additionalPaidInCapital;
    const pApicVal = priorEquity.additionalPaidInCapital;

    // Total equity calculation
    const recordedEquity = (commonStockVal || 0) + (apicVal || 0);
    const totalEquity = roundTwo(cRetainedEarnings + recordedEquity);
    const pRecordedEquity = (pCommonStockVal || 0) + (pApicVal || 0);
    const pTotalEquity = roundTwo(pRetainedEarnings + pRecordedEquity);

    // Construct comparative financial categories list with explicit source metadata
    const comparativeCategories = [
      {
        category: 'Cash',
        priorYear: pCash,
        currentYear: cCash,
        isCashRow: true,
        source: {
          type: 'ledger',
          model: 'CashLedgerEntry',
          description: 'Sum of all cash account ledger entries up to period end',
          accountIds: curCashData.accountIds,
          asOf: curEnd.toISOString(),
        },
      },
      {
        category: 'Accounts receivable',
        priorYear: priorRec,
        currentYear: curRec,
        source: {
          type: 'aggregate',
          model: 'Invoice',
          description: 'Outstanding customer invoice balance due as of period end',
          asOf: curEnd.toISOString(),
        },
      },
      {
        category: 'Accounts payable',
        priorYear: priorPay,
        currentYear: curPay,
        source: {
          type: 'aggregate',
          model: 'Expense',
          description: 'Outstanding vendor expense balance due as of period end',
          asOf: curEnd.toISOString(),
        },
      },
      {
        category: 'Accruals',
        priorYear: priorAccrualsData.total,
        currentYear: curAccrualsData.total,
        source: {
          type: 'aggregate',
          model: 'AccrualEntry + Payroll',
          description: 'Unbilled recognized liabilities & pending unpaid payroll obligations',
          asOf: curEnd.toISOString(),
        },
      },
      {
        category: 'Additional paid in capital',
        priorYear: pApicVal,
        currentYear: apicVal,
        source: (apicVal !== null || pApicVal !== null)
          ? {
              type: 'ledger',
              model: 'EquityTransaction',
              description: (curEquity.hasApic || priorEquity.hasApic)
                ? 'Recorded share issuance premium & additional paid-in capital'
                : 'No share premium recorded (standard ₹0.00 balance)',
              asOf: curEnd.toISOString(),
            }
          : {
              type: 'unavailable',
              reason: 'No EquityTransaction records found for this period. Add equity transactions under Settings > Equity to populate this line.',
            },
      },
      {
        category: 'Common Stock',
        priorYear: pCommonStockVal,
        currentYear: commonStockVal,
        source: (commonStockVal !== null || pCommonStockVal !== null)
          ? {
              type: 'ledger',
              model: 'EquityTransaction',
              description: 'Recorded common stock & owner contributions net of distributions',
              asOf: curEnd.toISOString(),
            }
          : {
              type: 'unavailable',
              reason: 'No Common Stock / Owner Equity recorded. Add opening equity under Equity Transactions to populate this line.',
            },
      },
      {
        category: 'COGS',
        priorYear: priorCogsData.total,
        currentYear: curCogsData.total,
        source: curCogsData.hasCogs || priorCogsData.hasCogs
          ? {
              type: 'aggregate',
              model: 'Expense',
              description: 'Expenses classified under categories with isCogs enabled',
              asOf: curEnd.toISOString(),
            }
          : {
              type: 'unavailable',
              reason: 'No expenses categorized under COGS categories found for this period. Mark expense categories as COGS under Categories.',
            },
      },
      {
        category: 'Current portion long-term debt',
        priorYear: priorCurrentPortion,
        currentYear: curCurrentPortion,
        source: hasCurLtDebt || hasPriorLtDebt
          ? {
              type: 'aggregate',
              model: 'Liability',
              description: 'Current portion of long-term debt maturing within 12 months (Liability.currentPortionAmount)',
              asOf: curEnd.toISOString(),
            }
          : {
              type: 'unavailable',
              reason: 'No long-term liabilities recorded. Add long-term liabilities with current portion amounts under Liabilities.',
            },
      },
      {
        category: 'Depreciation expense',
        priorYear: priorDepreciation,
        currentYear: curDepreciation,
        source: curFixedAssetData.hasFixedAssets || priorFixedAssetData.hasFixedAssets
          ? {
              type: 'aggregate',
              model: 'Asset',
              description: 'Depreciation incurred during this period across active fixed assets using straight-line / declining-balance formulas',
              asOf: curEnd.toISOString(),
            }
          : {
              type: 'unavailable',
              reason: 'No active fixed assets with depreciation schedules found for this period. Add fixed assets under Assets.',
            },
      },
      {
        category: 'Interest expense',
        priorYear: priorInterestData.total,
        currentYear: curInterestData.total,
        source: curInterestData.hasCategory || priorInterestData.hasCategory
          ? {
              type: 'aggregate',
              model: 'Expense',
              description: 'Expenses recorded under Interest Expense category in this period',
              asOf: curEnd.toISOString(),
            }
          : {
              type: 'unavailable',
              reason: 'No Interest Expense category or recorded interest expenses found for this period.',
            },
      },
      {
        category: 'Inventories',
        priorYear: priorInvTotal,
        currentYear: curInvTotal,
        source: curInvData.hasInventory || priorInvData.hasInventory
          ? {
              type: 'aggregate',
              model: 'Item',
              description: 'Inventory valuation based on stock quantity and purchase price as of period end',
              asOf: curEnd.toISOString(),
            }
          : {
              type: 'unavailable',
              reason: 'No inventory items with opening stock recorded as of period end.',
            },
      },
      {
        category: 'Long-term debt',
        priorYear: priorLtDebt,
        currentYear: curLtDebt,
        source: hasCurLtDebt || hasPriorLtDebt
          ? {
              type: 'aggregate',
              model: 'Liability',
              description: 'Total active long-term liabilities outstanding as of period end',
              asOf: curEnd.toISOString(),
            }
          : {
              type: 'unavailable',
              reason: 'No long-term liabilities recorded. Add long-term liabilities under Liabilities.',
            },
      },
      {
        category: 'Net fixed assets',
        priorYear: priorNetFixedAssets,
        currentYear: curNetFixedAssets,
        source: curFixedAssetData.hasFixedAssets || priorFixedAssetData.hasFixedAssets
          ? {
              type: 'aggregate',
              model: 'Asset',
              description: 'Net book value (purchase value minus accumulated depreciation) of active fixed assets',
              asOf: curEnd.toISOString(),
            }
          : {
              type: 'unavailable',
              reason: 'No fixed assets recorded in asset ledger. Add fixed assets under Assets.',
            },
      },
      {
        category: 'Notes payable',
        priorYear: priorNotesPay,
        currentYear: curNotesPay,
        source: hasCurShortLoans || hasPriorShortLoans
          ? {
              type: 'aggregate',
              model: 'Liability',
              description: 'Outstanding short-term notes and loan obligations as of period end',
              asOf: curEnd.toISOString(),
            }
          : {
              type: 'unavailable',
              reason: 'No loan or notes payable liabilities recorded. Add loan liabilities under Liabilities.',
            },
      },
      {
        category: 'Operating expenses (excl. depr.)',
        priorYear: priorOperatingExp,
        currentYear: curOperatingExp,
        source: {
          type: 'aggregate',
          model: 'Expense',
          description: 'Total operating expenses recorded in period (excluding COGS and Interest Expense)',
          asOf: curEnd.toISOString(),
        },
      },
      {
        category: 'Retained earnings',
        priorYear: pRetainedEarnings,
        currentYear: cRetainedEarnings,
        source: {
          type: 'aggregate',
          model: 'Invoice,Expense',
          description: 'Cumulative retained earnings carried forward plus net income (Sales - Expenses - Taxes)',
          asOf: curEnd.toISOString(),
        },
      },
      {
        category: 'Sales',
        priorYear: priorSales,
        currentYear: curSales,
        source: {
          type: 'aggregate',
          model: 'Invoice',
          description: 'Total sales revenue recorded in period',
          asOf: curEnd.toISOString(),
        },
      },
      {
        category: 'Taxes',
        priorYear: priorTax,
        currentYear: curTax,
        source: {
          type: 'aggregate',
          model: 'Invoice',
          description: 'Total tax liability billed on invoices in period',
          asOf: curEnd.toISOString(),
        },
      },
    ];

    const changeInCash = roundTwo(cCash - pCash);

    // Architecture Note: Assets, Liabilities, and Equity are aggregated from disjoint collections
    // (CashLedgerEntry, Invoice, Expense, Asset, Liability, EquityTransaction) rather than a unified
    // double-entry journal. If transactions in one module (e.g. Liability loan) lack matching
    // offset entries in another (e.g. CashLedgerEntry deposit), balanceCheck.balanced will be false.
    const curDiff = roundTwo(totalAssets - (totalLiabilities + totalEquity));
    const priorDiff = roundTwo(pTotalAssets - (pTotalLiabilities + pTotalEquity));

    const balanceCheck = {
      currentYear: {
        assets: totalAssets,
        liabilitiesPlusEquity: roundTwo(totalLiabilities + totalEquity),
        difference: curDiff,
        balanced: Math.abs(curDiff) < 0.01,
      },
      priorYear: {
        assets: pTotalAssets,
        liabilitiesPlusEquity: roundTwo(pTotalLiabilities + pTotalEquity),
        difference: priorDiff,
        balanced: Math.abs(priorDiff) < 0.01,
      },
    };

    res.json({
      priorYearLabel: `Prior Year (${priorYear})`,
      currentYearLabel: `Current Year (${targetYear})`,
      categories: comparativeCategories,
      changeInCash,
      periodNetIncome: {
        currentYear: cNetIncome,
        priorYear: pNetIncome,
      },
      assets,
      totalAssets,
      liabilities,
      totalLiabilities,
      equity: totalEquity,
      totalEquity,
      balanceCheck,
    });
  } catch (error) {
    console.error('Error building balance sheet:', error);
    res.status(500).json({ message: 'Server error building balance sheet' });
  }
};

/**
 * Endpoint to retrieve setup status for Balance Sheet data sources
 */
exports.getSetupStatus = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const userId = new mongoose.Types.ObjectId(String(companyId));

    const [
      equityCount,
      cogsCategoryCount,
      fixedAssetCount,
      liabilityCount,
      interestCategoryCount,
    ] = await Promise.all([
      EquityTransaction.countDocuments({ user: userId, isDeleted: { $ne: true } }),
      Category.countDocuments({ user: userId, isCogs: true, isDeleted: { $ne: true } }),
      Asset.countDocuments({ user: userId, category: 'fixed', isDeleted: { $ne: true } }),
      Liability.countDocuments({ user: userId, isDeleted: { $ne: true } }),
      Category.countDocuments({ user: userId, name: { $regex: /interest\s*expense/i }, isDeleted: { $ne: true } }),
    ]);

    const steps = {
      equity: equityCount > 0,
      cogsCategories: cogsCategoryCount > 0,
      fixedAssets: fixedAssetCount > 0,
      liabilityCategorization: liabilityCount > 0,
      interestExpenseCategory: interestCategoryCount > 0,
    };

    const completedCount = Object.values(steps).filter(Boolean).length;
    const totalCount = Object.keys(steps).length;

    res.json({
      completedCount,
      totalCount,
      isFullyConfigured: completedCount === totalCount,
      steps,
    });
  } catch (error) {
    console.error('Error fetching setup status:', error);
    res.status(500).json({ message: 'Server error fetching balance sheet setup status' });
  }
};
