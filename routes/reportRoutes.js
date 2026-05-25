const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { getBudgetVsActual } = require('../controllers/budgetController');
const { getProfitLoss } = require('../controllers/reports/profitLossController');
const { getBalanceSheet } = require('../controllers/reports/balanceSheetController');
const { getCashFlow } = require('../controllers/reports/cashFlowController');
const {
  getPayrollSummary,
  getBankTransferSheet,
  getPFChallan,
  getTDSSummary,
  getAnnualEmployeeSummary,
} = require('../controllers/reports/payrollSummaryController');
const { getTaxDashboard } = require('../controllers/reports/taxDashboardController');

const authorizeAuthenticatedUser = (req, res, next) => {
  if (req.user?._id) {
    return next();
  }
  return res.status(401).json({ message: 'Not authorized, user not found' });
};

router.use(protect);

router.get('/budget-vs-actual', authorizeAuthenticatedUser, getBudgetVsActual);
router.get('/profit-loss', getProfitLoss);
router.get('/balance-sheet', getBalanceSheet);
router.get('/cash-flow', getCashFlow);
router.get('/payroll-summary', getPayrollSummary);
router.get('/payroll-summary/bank-transfer', getBankTransferSheet);
router.get('/payroll-summary/pf-challan', getPFChallan);
router.get('/payroll-summary/tds-summary', getTDSSummary);
router.get('/payroll-summary/annual-employee-summary', getAnnualEmployeeSummary);
router.get('/tax-dashboard', authorizeAuthenticatedUser, getTaxDashboard);

module.exports = router;
