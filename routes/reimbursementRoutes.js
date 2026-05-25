const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  getClaims,
  getClaimById,
  createClaim,
  updateClaimStatus,
  deleteClaim
} = require('../controllers/reimbursementController');

router.use(protect);

router.route('/')
  .get(getClaims)
  .post(createClaim);

router.route('/:id')
  .get(getClaimById)
  .delete(deleteClaim);

router.put('/:id/status', updateClaimStatus);

module.exports = router;
