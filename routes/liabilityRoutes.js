const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  getLiabilities,
  getLiabilityById,
  createLiability,
  updateLiability,
  deleteLiability,
} = require('../controllers/liabilityController');

router.use(protect);

router.route('/')
  .get(getLiabilities)
  .post(createLiability);

router.route('/:id')
  .get(getLiabilityById)
  .put(updateLiability)
  .delete(deleteLiability);

module.exports = router;
