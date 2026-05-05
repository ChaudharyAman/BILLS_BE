const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  getPayrollComponents,
  getPayrollComponentById,
  createPayrollComponent,
  updatePayrollComponent,
  deletePayrollComponent,
} = require('../controllers/payrollComponentController');

router.use(protect);

router.route('/')
  .get(getPayrollComponents)
  .post(createPayrollComponent);

router.route('/:id')
  .get(getPayrollComponentById)
  .put(updatePayrollComponent)
  .delete(deletePayrollComponent);

module.exports = router;
