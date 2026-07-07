const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { verifyMultiTenantWebhook } = require('../utils/cryptoHelper');
const {
  processPayroll,
  bulkApprovePayroll,
  bulkDeletePayroll,
  getPayrolls,
  getPayrollById,
  updatePayroll,
  deletePayroll,
  markPayrollAsPaid,
  generatePayslip,
  getPayrollConfig,
  updatePayrollConfig,
  calculateSalary,
  exportPayrollExcel,
  emailPayslip,
  reopenPayroll,
  getPayrollTrend,
  getPayrollAuditLog,
  syncEmployees,
  syncAttendance,
  receiveHrmsWebhook,
} = require('../controllers/payrollController');

// Webhook endpoint (unprotected, authenticated via HMAC signature check)
router.post('/integration/webhook', verifyMultiTenantWebhook, receiveHrmsWebhook);

router.use(protect);

// Protected integration routes
router.post('/integration/sync-employees', syncEmployees);
router.get('/integration/attendance-sync', syncAttendance);

// Configuration routes
router.get('/config', getPayrollConfig);
router.put('/config', updatePayrollConfig);
router.post('/calculate-salary', calculateSalary);
router.get('/trend', getPayrollTrend);
router.get('/export', exportPayrollExcel);
router.post('/process', processPayroll);
router.put('/bulk-approve', bulkApprovePayroll);
router.post('/bulk-delete', bulkDeletePayroll);
router.get('/', getPayrolls);

router.route('/:id')
  .get(getPayrollById)
  .put(updatePayroll)
  .delete(deletePayroll);

router.post('/:id/mark-paid', markPayrollAsPaid);
router.post('/:id/reopen', reopenPayroll);
router.get('/:id/generate-payslip', generatePayslip);
router.post('/:id/email-payslip', emailPayslip);
router.get('/:id/audit-log', getPayrollAuditLog);

module.exports = router;
