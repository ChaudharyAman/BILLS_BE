const express = require('express');
const router = express.Router();
const { extractInvoiceFromPDF, extractInvoiceFromPDFAI } = require('../controllers/pdfController');
const { protect } = require('../middleware/authMiddleware');
const pdfUpload = require('../middleware/pdfUpload');

// POST /api/pdf/extract — Upload a PDF and extract invoice data
router.post('/extract', protect, pdfUpload.single('pdf'), extractInvoiceFromPDF);
router.post('/extract-ai', protect, pdfUpload.single('pdf'), extractInvoiceFromPDFAI);

module.exports = router;
