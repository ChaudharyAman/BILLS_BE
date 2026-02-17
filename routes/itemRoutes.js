const express = require('express');
const router = express.Router();
const itemController = require('../controllers/itemController');
const { protect } = require('../middleware/authMiddleware');

router.get('/', protect, itemController.getItems);
router.post('/', protect, itemController.createItem);

module.exports = router;
