const express = require('express');
const router = express.Router();
const purchaseOrderController = require('../controllers/purchaseOrderController');
const { protect } = require('../middleware/authMiddleware');

router.get('/', protect, purchaseOrderController.getPurchaseOrders);
router.get('/:id', protect, purchaseOrderController.getPurchaseOrderById);
router.post('/', protect, purchaseOrderController.createPurchaseOrder);
router.put('/:id', protect, purchaseOrderController.updatePurchaseOrder);
router.delete('/:id', protect, purchaseOrderController.deletePurchaseOrder);

// The following routes might need adjustment depending on PO workflow
router.post('/:id/convert', protect, purchaseOrderController.convertToInvoice);
router.post('/bulk', protect, purchaseOrderController.bulkCreatePurchaseOrders);

module.exports = router;
