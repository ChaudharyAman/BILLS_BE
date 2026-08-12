const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  getTransactions,
  getTransactionById,
  createTransaction,
  updateTransaction,
  deleteTransaction
} = require('../controllers/payrollVariableTransactionController');

router.use(protect);

router.route('/')
  .get(authorize('payroll', 'view'), getTransactions)
  .post(authorize('payroll', 'create'), createTransaction);

router.route('/:id')
  .get(authorize('payroll', 'view'), getTransactionById)
  .put(authorize('payroll', 'edit'), updateTransaction)
  .delete(authorize('payroll', 'delete'), deleteTransaction);

module.exports = router;
