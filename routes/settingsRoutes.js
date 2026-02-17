const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');

const upload = require('../middleware/upload');

router.get('/', settingsController.getSettings);
router.put('/', upload.single('logo'), settingsController.updateSettings);

module.exports = router;
