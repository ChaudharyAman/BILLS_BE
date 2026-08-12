const express = require('express');
const router = express.Router();
const {
  getBankStatements,
  getBankStatementById,
  createBankStatement,
  deleteBankStatement,
} = require('../controllers/bankStatementController');
const { protect, authorize } = require('../middleware/authMiddleware');

router.route('/')
  .get(protect, authorize('bankStatements', 'view'), getBankStatements)
  .post(protect, authorize('bankStatements', 'create'), createBankStatement);

router.route('/:id')
  .get(protect, authorize('bankStatements', 'view'), getBankStatementById)
  .delete(protect, authorize('bankStatements', 'delete'), deleteBankStatement);

module.exports = router;
