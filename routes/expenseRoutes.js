const express = require('express');
const router = express.Router();
const {
  getExpenses,
  createExpense,
  getExpenseById,
  updateExpense,
  deleteExpense
} = require('../controllers/expenseController');
const { protect, authorize } = require('../middleware/authMiddleware');

router.route('/')
  .get(protect, authorize('expenses', 'view'), getExpenses)
  .post(protect, authorize('expenses', 'create'), createExpense);

router.route('/:id')
  .get(protect, authorize('expenses', 'view'), getExpenseById)
  .put(protect, authorize('expenses', 'edit'), updateExpense)
  .delete(protect, authorize('expenses', 'delete'), deleteExpense);

module.exports = router;
