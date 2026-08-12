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
const { protect, authorize } = require('../middleware/authMiddleware');

router.get('/', protect, authorize('settings', 'view'), getRecycleBinItems);
router.post('/restore', protect, authorize('settings', 'edit'), restoreItem);
router.delete('/permanent', protect, authorize('settings', 'delete'), permanentlyDeleteItem);
router.post('/bulk-restore', protect, authorize('settings', 'edit'), bulkRestoreItems);
router.post('/bulk-permanent', protect, authorize('settings', 'delete'), bulkPermanentlyDeleteItems);
router.post('/empty', protect, authorize('settings', 'delete'), emptyRecycleBin);

module.exports = router;
