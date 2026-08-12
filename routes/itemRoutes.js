const express = require('express');
const router = express.Router();
const itemController = require('../controllers/itemController');
const { protect, authorize } = require('../middleware/authMiddleware');

router.get('/', protect, authorize('items', 'view'), itemController.getItems);
router.post('/', protect, authorize('items', 'create'), itemController.createItem);
router.post('/bulk', protect, authorize('items', 'create'), itemController.bulkCreateItems);
router.get('/:id', protect, authorize('items', 'view'), itemController.getItemById);
router.put('/:id', protect, authorize('items', 'edit'), itemController.updateItem);
router.delete('/:id', protect, authorize('items', 'delete'), itemController.deleteItem);

module.exports = router;
