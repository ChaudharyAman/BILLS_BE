const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const { verifyMultiTenantWebhook } = require('../utils/cryptoHelper');
const {
  processPayroll,
  previewPayroll,
  bulkApprovePayroll,
  bulkDeletePayroll,
  getPayrolls,
  getPayrollById,
  updatePayroll,
  deletePayroll,
  markPayrollAsPaid,
  generatePayslip,
  getPayslipPdf,
  bulkPayslipPdf,
  getPayrollConfig,
  updatePayrollConfig,
  calculateSalary,
  exportPayrollExcel,
  exportPayrollInputsExcel,
  emailPayslip,
  reopenPayroll,
  getPayrollTrend,
  getPayrollAuditLog,
  syncEmployees,
  syncAttendance,
  receiveHrmsWebhook,
  publishPayslips,
  getCompensationTypes,
  processFullAndFinalSettlement,
  getBatchJobStatus,
} = require('../controllers/payrollController');

// Webhook endpoint (unprotected, authenticated via HMAC signature check)
router.post('/integration/webhook', verifyMultiTenantWebhook, receiveHrmsWebhook);

router.use(protect);

// Strategy metadata route
router.get('/compensation-types', authorize('payroll', 'view'), getCompensationTypes);
router.post('/full-and-final', authorize('payroll', 'approve'), processFullAndFinalSettlement);
router.get('/process/:jobId/status', authorize('payroll', 'view'), getBatchJobStatus);

// Bulk ZIP payslip route
router.post('/bulk-payslip-pdf', authorize('payroll', 'view'), bulkPayslipPdf);

// Protected integration routes
router.post('/integration/sync-employees', authorize('payroll', 'edit'), syncEmployees);
router.get('/integration/attendance-sync', authorize('payroll', 'view'), syncAttendance);
router.post('/integration/publish-payslips', authorize('payroll', 'approve'), publishPayslips);

// Configuration routes
router.get('/config', authorize('payroll', 'view'), getPayrollConfig);
router.put('/config', authorize('payroll', 'edit'), updatePayrollConfig);
router.post('/calculate-salary', authorize('payroll', 'view'), calculateSalary);
router.get('/trend', authorize('payroll', 'view'), getPayrollTrend);
router.get('/export', authorize('payroll', 'view'), exportPayrollExcel);
router.get('/export-inputs', authorize('payroll', 'view'), exportPayrollInputsExcel);
router.post('/process', authorize('payroll', 'approve'), processPayroll);
router.post('/preview', authorize('payroll', 'view'), previewPayroll);
router.put('/bulk-approve', authorize('payroll', 'approve'), bulkApprovePayroll);
router.post('/bulk-delete', authorize('payroll', 'delete'), bulkDeletePayroll);
router.get('/', authorize('payroll', 'view'), getPayrolls);

router.route('/:id')
  .get(authorize('payroll', 'view'), getPayrollById)
  .put(authorize('payroll', 'edit'), updatePayroll)
  .delete(authorize('payroll', 'delete'), deletePayroll);

router.post('/:id/mark-paid', authorize('payroll', 'approve'), markPayrollAsPaid);
router.post('/:id/reopen', authorize('payroll', 'approve'), reopenPayroll);
router.get('/:id/generate-payslip', authorize('payroll', 'view'), generatePayslip);
router.get('/:id/payslip-pdf', authorize('payroll', 'view'), getPayslipPdf);
router.post('/:id/email-payslip', authorize('payroll', 'view'), emailPayslip);
router.get('/:id/audit-log', authorize('payroll', 'view'), getPayrollAuditLog);

module.exports = router;
