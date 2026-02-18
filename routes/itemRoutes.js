const express = require('express');
const router = express.Router();
const itemController = require('../controllers/itemController');
const { protect } = require('../middleware/authMiddleware');

router.get('/', protect, itemController.getItems);
router.post('/', protect, itemController.createItem);
router.get('/:id', protect, itemController.getItemById);
router.put('/:id', protect, itemController.updateItem);
router.delete('/:id', protect, itemController.deleteItem);

module.exports = router;
