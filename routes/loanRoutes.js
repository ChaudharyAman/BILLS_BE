const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  getLoans,
  getLoanById,
  createLoan,
  updateLoanStatus,
  deleteLoan
} = require('../controllers/loanController');

router.use(protect);

router.route('/')
  .get(getLoans)
  .post(createLoan);

router.route('/:id')
  .get(getLoanById)
  .delete(deleteLoan);

router.put('/:id/status', updateLoanStatus);

module.exports = router;
