const express = require('express');
const router = express.Router();
const {
  getExpenses,
  createExpense,
  getExpenseById,
  getExpenseAttachment,
  getVendorAccountStatement,
  updateExpense,
  deleteExpense
} = require('../controllers/expenseController');
const { protect, authorize, premium } = require('../middleware/authMiddleware');

router.get('/accounts/statements', protect, authorize('expenses', 'view'), premium, getVendorAccountStatement);

router.route('/')
  .get(protect, authorize('expenses', 'view'), getExpenses)
  .post(protect, authorize('expenses', 'create'), createExpense);

router.get('/:id/attachments/:attachmentId', protect, authorize('expenses', 'view'), getExpenseAttachment);

router.route('/:id')
  .get(protect, authorize('expenses', 'view'), getExpenseById)
  .put(protect, authorize('expenses', 'edit'), updateExpense)
  .delete(protect, authorize('expenses', 'delete'), deleteExpense);

module.exports = router;
