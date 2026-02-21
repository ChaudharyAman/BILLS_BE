const express = require('express');
const router = express.Router();
const invoiceController = require('../controllers/invoiceController');
const { protect } = require('../middleware/authMiddleware');

router.get('/', protect, invoiceController.getInvoices);
router.get('/:id', protect, invoiceController.getInvoiceById);
router.post('/', protect, invoiceController.createInvoice);
router.post('/bulk', protect, invoiceController.bulkCreateInvoices);
router.put('/:id', protect, invoiceController.updateInvoice);
router.delete('/:id', protect, invoiceController.deleteInvoice);

module.exports = router;
