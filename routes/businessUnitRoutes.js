const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  getBusinessUnits,
  createBusinessUnit,
  updateBusinessUnit,
  deleteBusinessUnit,
  getBusinessUnitRollup,
  getBusinessUnitSummary,
} = require('../controllers/businessUnitController');

router.use(protect);

router.route('/')
  .get(authorize('businessUnits', 'view'), getBusinessUnits)
  .post(authorize('businessUnits', 'create'), createBusinessUnit);

router.get('/rollup', authorize('businessUnits', 'view'), getBusinessUnitRollup);
router.get('/summary/:id', authorize('businessUnits', 'view'), getBusinessUnitSummary);

router.route('/:id')
  .put(authorize('businessUnits', 'edit'), updateBusinessUnit)
  .delete(authorize('businessUnits', 'delete'), deleteBusinessUnit);

module.exports = router;
