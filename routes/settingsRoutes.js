const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');

const { protect } = require('../middleware/authMiddleware');
const upload = require('../middleware/upload');

router.get('/', protect, settingsController.getSettings);
router.put('/', protect, upload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'signature', maxCount: 1 }
]), settingsController.updateSettings);

module.exports = router;
