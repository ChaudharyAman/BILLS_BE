const express = require('express');
const router = express.Router();
const { protect, admin } = require('../middleware/authMiddleware');
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
  .get(getRecurringTransactions)
  .post(createRecurringTransaction);

router.post('/:id/pause', pauseRecurringTransaction);
router.post('/:id/resume', resumeRecurringTransaction);

router.route('/:id')
  .put(updateRecurringTransaction)
  .delete(deleteRecurringTransaction);

module.exports = router;
