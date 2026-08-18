const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  getAccruals,
  createAccrual,
  updateAccrual,
  deleteAccrual,
} = require('../controllers/accrualController');

router.use(protect);

router.route('/')
  .get(getAccruals)
  .post(createAccrual);

router.route('/:id')
  .put(updateAccrual)
  .delete(deleteAccrual);

module.exports = router;
