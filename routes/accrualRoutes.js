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
  .get(authorize('reports', 'view'), getAccruals)
  .post(authorize('reports', 'create'), createAccrual);

router.route('/:id')
  .put(authorize('reports', 'edit'), updateAccrual)
  .delete(authorize('reports', 'delete'), deleteAccrual);

module.exports = router;
