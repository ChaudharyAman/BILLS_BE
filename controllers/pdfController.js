const { parseInvoice } = require('../utils/invoiceParser');

/**
 * @desc    Extract structured data from an uploaded PDF invoice
 * @route   POST /api/pdf/extract
 * @access  Protected
 */
const extractInvoiceFromPDF = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No PDF file uploaded.' });
    }

    const fileName = req.file.originalname || 'unknown.pdf';

    // Parse the PDF buffer into raw text
    let pdfData;
    try {
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse({ data: req.file.buffer });
      pdfData = await parser.getText();
    } catch (pdfErr) {
      console.error('PDF Parse Error:', pdfErr);
      return res.status(400).json({
        message: 'Failed to read PDF file. The file may be corrupted or image-based (scanned).',
        error: pdfErr.message,
      });
    }

    const rawText = pdfData.text || '';

    if (!rawText || rawText.trim().length < 20) {
      return res.status(400).json({
        message: 'No readable text found in the PDF. This may be a scanned/image-based PDF which requires OCR.',
        confidence: 0,
        status: 'rejected',
      });
    }

    // Run the extraction pipeline
    const result = parseInvoice(rawText, fileName);

    // Add PDF metadata (using fields from the Mehmet Kozan fork)
    result.metadata.pdfPages = pdfData.total || 1;
    
    res.json(result);
  } catch (error) {
    console.error('PDF extraction error:', error);
    res.status(500).json({
      message: 'Internal server error during PDF processing.',
      error: error.message,
    });
  }
};

module.exports = { extractInvoiceFromPDF };
