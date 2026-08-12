const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  getPayrollComponents,
  getPayrollComponentById,
  createPayrollComponent,
  updatePayrollComponent,
  deletePayrollComponent,
} = require('../controllers/payrollComponentController');

router.use(protect);

router.route('/')
  .get(authorize('payroll', 'view'), getPayrollComponents)
  .post(authorize('payroll', 'create'), createPayrollComponent);

router.route('/:id')
  .get(authorize('payroll', 'view'), getPayrollComponentById)
  .put(authorize('payroll', 'edit'), updatePayrollComponent)
  .delete(authorize('payroll', 'delete'), deletePayrollComponent);

module.exports = router;
