const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  processPayroll,
  getPayrolls,
  getPayrollById,
  updatePayroll,
  markPayrollAsPaid,
  generatePayslip,
} = require('../controllers/payrollController');

router.use(protect);

router.post('/process', processPayroll);
router.get('/', getPayrolls);

router.route('/:id')
  .get(getPayrollById)
  .put(updatePayroll);

router.post('/:id/mark-paid', markPayrollAsPaid);
router.post('/:id/generate-payslip', generatePayslip);

module.exports = router;
