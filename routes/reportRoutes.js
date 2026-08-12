const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const { getBudgetVsActual } = require('../controllers/budgetController');
const { getProfitLoss } = require('../controllers/reports/profitLossController');
const { getBalanceSheet } = require('../controllers/reports/balanceSheetController');
const { getCashFlow } = require('../controllers/reports/cashFlowController');
const {
  getPayrollSummary,
  getBankTransferSheet,
  getPFChallan,
  getESIChallan,
  getStatutorySummary,
  getTDSSummary,
  getAnnualEmployeeSummary,
  getPFECR,
  getESIMonthlyUpload,
  getBankPaymentBatch,
} = require('../controllers/reports/payrollSummaryController');
const { getTaxDashboard } = require('../controllers/reports/taxDashboardController');

router.use(protect);

router.get('/budget-vs-actual', authorize('reports', 'view'), getBudgetVsActual);
router.get('/profit-loss', authorize('reports', 'view'), getProfitLoss);
router.get('/balance-sheet', authorize('reports', 'view'), getBalanceSheet);
router.get('/cash-flow', authorize('reports', 'view'), getCashFlow);
router.get('/tax-dashboard', authorize('reports', 'view'), getTaxDashboard);

// Payroll Summary & Statutory Reports (require payroll: view permission)
router.get('/payroll-summary', authorize('payroll', 'view'), getPayrollSummary);
router.get('/payroll-summary/bank-transfer', authorize('payroll', 'view'), getBankTransferSheet);
router.get('/payroll-summary/pf-challan', authorize('payroll', 'view'), getPFChallan);
router.get('/payroll-summary/esi-challan', authorize('payroll', 'view'), getESIChallan);
router.get('/payroll-summary/statutory-summary', authorize('payroll', 'view'), getStatutorySummary);
router.get('/payroll-summary/tds-summary', authorize('payroll', 'view'), getTDSSummary);
router.get('/payroll-summary/annual-employee-summary', authorize('payroll', 'view'), getAnnualEmployeeSummary);
router.get('/payroll-summary/pf-ecr', authorize('payroll', 'view'), getPFECR);
router.get('/payroll-summary/esi-monthly-upload', authorize('payroll', 'view'), getESIMonthlyUpload);
router.get('/payroll-summary/bank-payment-batch', authorize('payroll', 'view'), getBankPaymentBatch);

module.exports = router;
