const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { getBudgetVsActual } = require('../controllers/budgetController');
const { getProfitLoss } = require('../controllers/reports/profitLossController');
const { getBalanceSheet } = require('../controllers/reports/balanceSheetController');
const { getCashFlow } = require('../controllers/reports/cashFlowController');
const { getPayrollSummary } = require('../controllers/reports/payrollSummaryController');
const { getTaxDashboard } = require('../controllers/reports/taxDashboardController');

const authorizeReports = (req, res, next) => {
  const allowedRoles = ['admin', 'finance', 'superadmin'];
  if (allowedRoles.includes(req.user?.role)) {
    return next();
  }
  return res.status(403).json({ message: 'Forbidden: insufficient permissions' });
};

router.use(protect);

router.get('/budget-vs-actual', authorizeReports, getBudgetVsActual);
router.get('/profit-loss', authorizeReports, getProfitLoss);
router.get('/balance-sheet', authorizeReports, getBalanceSheet);
router.get('/cash-flow', authorizeReports, getCashFlow);
router.get('/payroll-summary', authorizeReports, getPayrollSummary);
router.get('/tax-dashboard', authorizeReports, getTaxDashboard);

module.exports = router;
