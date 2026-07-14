const express = require('express');
const router = express.Router();
const { getRecycleBinItems, restoreItem, permanentlyDeleteItem } = require('../controllers/recycleBinController');
const { protect } = require('../middleware/authMiddleware');

router.get('/', protect, getRecycleBinItems);
router.post('/restore', protect, restoreItem);
router.delete('/permanent', protect, permanentlyDeleteItem);

module.exports = router;
