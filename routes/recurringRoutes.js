const express = require('express');
const router = express.Router();
const { protect, admin, authorize } = require('../middleware/authMiddleware');
const {
  createRecurringTransaction,
  getRecurringTransactions,
  updateRecurringTransaction,
  deleteRecurringTransaction,
  pauseRecurringTransaction,
  resumeRecurringTransaction,
  processRecurringTransactions,
} = require('../controllers/recurringTransactionController');

router.use(protect);

router.post('/process', admin, processRecurringTransactions);
router.route('/')
  .get(authorize('recurringTransactions', 'view'), getRecurringTransactions)
  .post(authorize('recurringTransactions', 'create'), createRecurringTransaction);

router.post('/:id/pause', authorize('recurringTransactions', 'edit'), pauseRecurringTransaction);
router.post('/:id/resume', authorize('recurringTransactions', 'edit'), resumeRecurringTransaction);

router.route('/:id')
  .put(authorize('recurringTransactions', 'edit'), updateRecurringTransaction)
  .delete(authorize('recurringTransactions', 'delete'), deleteRecurringTransaction);

module.exports = router;
