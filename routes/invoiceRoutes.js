const express = require('express');
const router = express.Router();
const invoiceController = require('../controllers/invoiceController');
const { protect, authorize, premium } = require('../middleware/authMiddleware');

// Accounts (Premium Features) - MUST BE BEFORE /:id
router.get('/accounts/payments', protect, authorize('invoices', 'view'), premium, invoiceController.getPaymentCollection);
router.get('/accounts/statements', protect, authorize('invoices', 'view'), premium, invoiceController.getAccountStatement);

// Standard Invoices & Reports
router.get('/', protect, authorize('invoices', 'view'), invoiceController.getInvoices);
router.get('/reports/gst', protect, authorize('reports', 'view'), premium, invoiceController.getGSTReport);
router.get('/reports/revenue', protect, authorize('reports', 'view'), premium, invoiceController.getRevenueReport);
router.get('/:id', protect, authorize('invoices', 'view'), invoiceController.getInvoiceById);
router.get('/:id/attachments/:attachmentId', protect, authorize('invoices', 'view'), invoiceController.getInvoiceAttachment);
router.post('/', protect, authorize('invoices', 'create'), invoiceController.createInvoice);
router.post('/bulk', protect, authorize('invoices', 'create'), invoiceController.bulkCreateInvoices);
router.put('/:id', protect, authorize('invoices', 'edit'), invoiceController.updateInvoice);
router.put('/:id/status', protect, authorize('invoices', 'edit'), invoiceController.updateInvoiceStatus);
router.delete('/:id', protect, authorize('invoices', 'delete'), invoiceController.deleteInvoice);

module.exports = router;
