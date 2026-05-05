const { parseInvoice } = require('../utils/invoiceParser');
const { parseInvoiceWithNvidia, parseScannedInvoicePdfWithNvidia } = require('../services/nvidiaInvoiceParser');

function getPdfTarget(req) {
  const target = String(req.query?.target || 'invoice').toLowerCase();
  return ['invoice', 'expense', 'income'].includes(target) ? target : 'invoice';
}

async function readPdfText(buffer) {
  const pdfParse = require('pdf-parse');

  if (typeof pdfParse === 'function') {
    return pdfParse(buffer);
  }

  if (typeof pdfParse.PDFParse === 'function') {
    const parser = new pdfParse.PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy?.();
    return result;
  }

  throw new Error('Unsupported pdf-parse API');
}

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
      pdfData = await readPdfText(req.file.buffer);
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

/**
 * @desc    Extract structured data from an uploaded PDF invoice using NVIDIA AI with safe fallback
 * @route   POST /api/pdf/extract-ai
 * @access  Protected
 */
const extractInvoiceFromPDFAI = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No PDF file uploaded.' });
    }

    const fileName = req.file.originalname || 'unknown.pdf';
    const documentType = getPdfTarget(req);

    let pdfData;
    try {
      pdfData = await readPdfText(req.file.buffer);
    } catch (pdfErr) {
      console.error('AI Invoice PDF Parse Error:', pdfErr);
      return res.status(400).json({
        message: 'Failed to read PDF file. The file may be corrupted or image-based (scanned).',
        error: pdfErr.message,
      });
    }

    const rawText = pdfData.text || '';
    const result = (!rawText || rawText.trim().length < 20)
      ? await parseScannedInvoicePdfWithNvidia(req.file.buffer, fileName, { documentType })
      : await parseInvoiceWithNvidia(rawText, fileName, { documentType });

    result.metadata = {
      ...result.metadata,
      documentType,
      pdfPages: pdfData.total || 1,
      textLength: rawText.length,
    };

    res.json(result);
  } catch (error) {
    console.error('AI invoice PDF extraction error:', error);
    res.status(500).json({
      message: 'Internal server error during AI invoice PDF processing.',
      error: error.message,
    });
  }
};

module.exports = { extractInvoiceFromPDF, extractInvoiceFromPDFAI };
