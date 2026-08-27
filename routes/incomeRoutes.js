const express = require('express');
const router = express.Router();
const {
  getIncomes,
  createIncome,
  getIncomeById,
  getIncomeAttachment,
  updateIncome,
  deleteIncome
} = require('../controllers/incomeController');
const { protect, authorize } = require('../middleware/authMiddleware');

router.route('/')
  .get(protect, authorize('income', 'view'), getIncomes)
  .post(protect, authorize('income', 'create'), createIncome);

router.get('/:id/attachments/:attachmentId', protect, authorize('income', 'view'), getIncomeAttachment);

router.route('/:id')
  .get(protect, authorize('income', 'view'), getIncomeById)
  .put(protect, authorize('income', 'edit'), updateIncome)
  .delete(protect, authorize('income', 'delete'), deleteIncome);

module.exports = router;
