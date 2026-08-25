const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  getLiabilities,
  getLiabilityById,
  createLiability,
  updateLiability,
  deleteLiability,
} = require('../controllers/liabilityController');

router.use(protect);

router.route('/')
  .get(authorize('liabilities', 'view'), getLiabilities)
  .post(authorize('liabilities', 'create'), createLiability);

router.route('/:id')
  .get(authorize('liabilities', 'view'), getLiabilityById)
  .put(authorize('liabilities', 'edit'), updateLiability)
  .delete(authorize('liabilities', 'delete'), deleteLiability);

module.exports = router;
