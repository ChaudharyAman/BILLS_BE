const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');

const { protect } = require('../middleware/authMiddleware');
const upload = require('../middleware/upload');

router.get('/', protect, settingsController.getSettings);
router.put('/', protect, upload.single('logo'), settingsController.updateSettings);

module.exports = router;
