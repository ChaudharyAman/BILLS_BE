const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { getBudgetVsActual } = require('../controllers/budgetController');
const { getProfitLoss } = require('../controllers/reports/profitLossController');
const { getBalanceSheet } = require('../controllers/reports/balanceSheetController');
const { getCashFlow } = require('../controllers/reports/cashFlowController');
const { getPayrollSummary } = require('../controllers/reports/payrollSummaryController');
const { getTaxDashboard } = require('../controllers/reports/taxDashboardController');

const authorizeFinanceReports = (req, res, next) => {
  const allowedRoles = ['admin', 'finance', 'superadmin'];
  if (allowedRoles.includes(req.user?.role)) {
    return next();
  }
  return res.status(403).json({ message: 'Forbidden: insufficient permissions' });
};

const authorizeAuthenticatedUser = (req, res, next) => {
  if (req.user?._id) {
    return next();
  }
  return res.status(401).json({ message: 'Not authorized, user not found' });
};

router.use(protect);

router.get('/budget-vs-actual', authorizeAuthenticatedUser, getBudgetVsActual);
router.get('/profit-loss', authorizeFinanceReports, getProfitLoss);
router.get('/balance-sheet', authorizeFinanceReports, getBalanceSheet);
router.get('/cash-flow', authorizeFinanceReports, getCashFlow);
router.get('/payroll-summary', authorizeFinanceReports, getPayrollSummary);
router.get('/tax-dashboard', authorizeAuthenticatedUser, getTaxDashboard);

module.exports = router;
