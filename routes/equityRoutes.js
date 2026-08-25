const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  getEquityTransactions,
  createEquityTransaction,
  updateEquityTransaction,
  deleteEquityTransaction,
} = require('../controllers/equityController');

router.use(protect);

router.get('/', authorize('reports', 'view'), getEquityTransactions);
router.post('/', authorize('reports', 'create'), createEquityTransaction);
router.put('/:id', authorize('reports', 'edit'), updateEquityTransaction);
router.delete('/:id', authorize('reports', 'delete'), deleteEquityTransaction);

module.exports = router;
