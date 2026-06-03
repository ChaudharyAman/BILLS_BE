const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  processPayroll,
  bulkApprovePayroll,
  getPayrolls,
  getPayrollById,
  updatePayroll,
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
} = require('../controllers/payrollController');

router.use(protect);

router.get('/config', getPayrollConfig);
router.put('/config', updatePayrollConfig);
router.post('/calculate-salary', calculateSalary);
router.get('/trend', getPayrollTrend);
router.get('/export', exportPayrollExcel);
router.post('/process', processPayroll);
router.put('/bulk-approve', bulkApprovePayroll);
router.get('/', getPayrolls);

router.route('/:id')
  .get(getPayrollById)
  .put(updatePayroll);

router.post('/:id/mark-paid', markPayrollAsPaid);
router.post('/:id/reopen', reopenPayroll);
router.get('/:id/generate-payslip', generatePayslip);
router.post('/:id/email-payslip', emailPayslip);
router.get('/:id/audit-log', getPayrollAuditLog);

module.exports = router;
