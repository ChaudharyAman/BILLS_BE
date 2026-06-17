const express = require('express');
const router = express.Router();
const {
  getBankStatements,
  getBankStatementById,
  createBankStatement,
  deleteBankStatement,
} = require('../controllers/bankStatementController');
const { protect } = require('../middleware/authMiddleware');

router.route('/')
  .get(protect, getBankStatements)
  .post(protect, createBankStatement);

router.route('/:id')
  .get(protect, getBankStatementById)
  .delete(protect, deleteBankStatement);

module.exports = router;
