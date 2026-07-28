const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
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
  .get(getBusinessUnits)
  .post(createBusinessUnit);

router.get('/rollup', getBusinessUnitRollup);
router.get('/summary/:id', getBusinessUnitSummary);

router.route('/:id')
  .put(updateBusinessUnit)
  .delete(deleteBusinessUnit);

module.exports = router;
