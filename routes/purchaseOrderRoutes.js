const express = require('express');
const router = express.Router();
const purchaseOrderController = require('../controllers/purchaseOrderController');
const { protect } = require('../middleware/authMiddleware');

router.get('/', protect, purchaseOrderController.getPurchaseOrders);
router.post('/', protect, purchaseOrderController.createPurchaseOrder);
router.post('/bulk', protect, purchaseOrderController.bulkCreatePurchaseOrders);
router.post('/:id/convert', protect, purchaseOrderController.convertToInvoice);
router.get('/:id', protect, purchaseOrderController.getPurchaseOrderById);
router.put('/:id', protect, purchaseOrderController.updatePurchaseOrder);
router.delete('/:id', protect, purchaseOrderController.deletePurchaseOrder);

module.exports = router;
