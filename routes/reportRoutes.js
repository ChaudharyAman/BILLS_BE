const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { getBudgetVsActual } = require('../controllers/budgetController');
const { getProfitLoss } = require('../controllers/reports/profitLossController');
const { getBalanceSheet } = require('../controllers/reports/balanceSheetController');
const { getCashFlow } = require('../controllers/reports/cashFlowController');
const { getPayrollSummary } = require('../controllers/reports/payrollSummaryController');
const { getTaxDashboard } = require('../controllers/reports/taxDashboardController');

router.use(protect);

router.get('/budget-vs-actual', getBudgetVsActual);
router.get('/profit-loss', getProfitLoss);
router.get('/balance-sheet', getBalanceSheet);
router.get('/cash-flow', getCashFlow);
router.get('/payroll-summary', getPayrollSummary);
router.get('/tax-dashboard', getTaxDashboard);

module.exports = router;
