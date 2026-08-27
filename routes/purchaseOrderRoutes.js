const express = require('express');
const router = express.Router();
const purchaseOrderController = require('../controllers/purchaseOrderController');
const { protect, authorize } = require('../middleware/authMiddleware');

router.get('/', protect, authorize('purchaseOrders', 'view'), purchaseOrderController.getPurchaseOrders);
router.post('/', protect, authorize('purchaseOrders', 'create'), purchaseOrderController.createPurchaseOrder);
router.post('/bulk', protect, authorize('purchaseOrders', 'create'), purchaseOrderController.bulkCreatePurchaseOrders);
router.post('/:id/convert', protect, authorize('purchaseOrders', 'approve'), purchaseOrderController.convertToInvoice);
router.post('/:id/receive', protect, authorize('purchaseOrders', 'approve'), purchaseOrderController.markPurchaseOrderReceived);
router.put('/:id/status', protect, authorize('purchaseOrders', 'approve'), purchaseOrderController.updatePurchaseOrderStatus);
router.get('/:id', protect, authorize('purchaseOrders', 'view'), purchaseOrderController.getPurchaseOrderById);
router.get('/:id/attachments/:attachmentId', protect, authorize('purchaseOrders', 'view'), purchaseOrderController.getPurchaseOrderAttachment);
router.put('/:id', protect, authorize('purchaseOrders', 'edit'), purchaseOrderController.updatePurchaseOrder);
router.delete('/:id', protect, authorize('purchaseOrders', 'delete'), purchaseOrderController.deletePurchaseOrder);

module.exports = router;
