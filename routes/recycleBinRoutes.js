const express = require('express');
const router = express.Router();
const {
  getRecycleBinItems,
  restoreItem,
  permanentlyDeleteItem,
  bulkRestoreItems,
  bulkPermanentlyDeleteItems,
  emptyRecycleBin
} = require('../controllers/recycleBinController');
const { protect } = require('../middleware/authMiddleware');

router.get('/', protect, getRecycleBinItems);
router.post('/restore', protect, restoreItem);
router.delete('/permanent', protect, permanentlyDeleteItem);
router.post('/bulk-restore', protect, bulkRestoreItems);
router.post('/bulk-permanent', protect, bulkPermanentlyDeleteItems);
router.post('/empty', protect, emptyRecycleBin);

module.exports = router;

