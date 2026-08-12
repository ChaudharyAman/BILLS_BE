const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  getLoans,
  getLoanById,
  createLoan,
  updateLoanStatus,
  deleteLoan
} = require('../controllers/loanController');

router.use(protect);

router.route('/')
  .get(authorize('loans', 'view'), getLoans)
  .post(authorize('loans', 'create'), createLoan);

router.route('/:id')
  .get(authorize('loans', 'view'), getLoanById)
  .delete(authorize('loans', 'delete'), deleteLoan);

router.put('/:id/status', authorize('loans', 'approve'), updateLoanStatus);

module.exports = router;
