const express = require('express');
const router = express.Router();
const invoiceController = require('../controllers/invoiceController');
const { protect, premium } = require('../middleware/authMiddleware');

// Accounts (Premium Features) - MUST BE BEFORE /:id
router.get('/accounts/payments', protect, premium, invoiceController.getPaymentCollection);
router.get('/accounts/statements', protect, premium, invoiceController.getAccountStatement);

// Standard Invoices & Reports
router.get('/', protect, invoiceController.getInvoices);
router.get('/reports/gst', protect, premium, invoiceController.getGSTReport);
router.get('/reports/revenue', protect, premium, invoiceController.getRevenueReport);
router.get('/:id', protect, invoiceController.getInvoiceById);
router.post('/', protect, invoiceController.createInvoice);
router.post('/bulk', protect, invoiceController.bulkCreateInvoices);
router.put('/:id', protect, invoiceController.updateInvoice);
router.put('/:id/status', protect, invoiceController.updateInvoiceStatus);
router.delete('/:id', protect, invoiceController.deleteInvoice);

module.exports = router;
