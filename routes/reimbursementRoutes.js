const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  getClaims,
  getClaimById,
  createClaim,
  updateClaim,
  updateClaimStatus,
  deleteClaim
} = require('../controllers/reimbursementController');

router.use(protect);

router.route('/')
  .get(authorize('reimbursements', 'view'), getClaims)
  .post(authorize('reimbursements', 'create'), createClaim);

router.route('/:id')
  .get(authorize('reimbursements', 'view'), getClaimById)
  .put(authorize('reimbursements', 'edit'), updateClaim)
  .delete(authorize('reimbursements', 'delete'), deleteClaim);

router.put('/:id/status', authorize('reimbursements', 'approve'), updateClaimStatus);

module.exports = router;
