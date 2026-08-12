const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  getBudgets,
  createBudget,
  updateBudget,
  deleteBudget,
} = require('../controllers/budgetController');

router.use(protect);

router.route('/')
  .get(authorize('budgets', 'view'), getBudgets)
  .post(authorize('budgets', 'create'), createBudget);

router.route('/:id')
  .put(authorize('budgets', 'edit'), updateBudget)
  .delete(authorize('budgets', 'delete'), deleteBudget);

module.exports = router;
