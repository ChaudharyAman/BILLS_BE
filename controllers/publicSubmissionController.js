/**
 * publicSubmissionController.js
 *
 * Handles the two unauthenticated public endpoints:
 *   GET  /api/public/submit/:token  — returns safe company info for the landing page
 *   POST /api/public/submit/:token  — receives file(s) + submitter details
 *
 * SECURITY CONTRACT (enforced here):
 *   - Token lookup resolves to a Settings document; the User's real _id is NEVER
 *     returned in any response from this controller.
 *   - If the token is invalid or enabled=false, both GET and POST return 404.
 *     No distinction is made between "token exists but disabled" and "token not
 *     found" — returning different codes would allow token enumeration.
 *   - IP address is stored for internal abuse investigation; it is never returned
 *     to the API caller.
 */

const crypto = require('crypto');
const Settings = require('../models/Settings');
const PublicSubmission = require('../models/PublicSubmission');

// ── Parsing pipeline (reused from pdfController / nvidiaInvoiceParser) ───────
const { parseInvoice } = require('../utils/invoiceParser');
const {
  parseInvoiceWithNvidia,
  parseScannedInvoicePdfWithNvidia,
} = require('../services/nvidiaInvoiceParser');

// ── Helper: resolve Settings by public token ─────────────────────────────────
async function resolveSettingsByToken(token) {
  if (!token || typeof token !== 'string' || token.length < 8) return null;
  // Use the sparse unique index on publicSubmissions.token
  const settings = await Settings.findOne({
    'publicSubmissions.token': token,
    'publicSubmissions.enabled': true,
  }).lean();
  return settings;
}

// ── Helper: count today's submissions for a user (daily cap enforcement) ─────
async function countTodaySubmissions(userId) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  return PublicSubmission.countDocuments({
    user: userId,
    createdAt: { $gte: startOfDay },
  });
}

// ── Helper: best-effort suggestedCategory ────────────────────────────────────
// Intentionally simple — the reviewer always confirms. Do not over-engineer.
function guessSuggestedCategory(allowedCategories, parsedData, primaryFileMime) {
  // If only one category is allowed, it's the obvious answer
  if (allowedCategories && allowedCategories.length === 1) {
    return allowedCategories[0];
  }

  const text = [
    parsedData?.invoiceNumber || '',
    parsedData?.vendorName    || '',
    parsedData?.clientName    || '',
  ].join(' ').toLowerCase();

  if (/\bpurchase\s*order\b|\bpo\b|\bprocurement\b/i.test(text)) return 'purchaseorder';
  if (/\btax\s*invoice\b|\bgstin\b/i.test(text)) return 'invoice';
  if (/\breceipt\b|\bbill\b|\bpayment\b/i.test(text)) return 'expense';

  return 'expense'; // safest default
}

// ── Helper: read PDF text using pdf-parse (same pattern as pdfController) ────
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

// ── Helper: run the parsing pipeline on the primary file ─────────────────────
async function parseFile(file, suggestedDocumentType) {
  const documentType = suggestedDocumentType || 'expense';
  const mime = (file.mimetype || '').toLowerCase();
  const isPdf = mime === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf');
  const isImage = /^image\//.test(mime);

  try {
    if (isPdf) {
      // Text PDF path — same as pdfController.extractInvoiceFromPDFAI
      let rawText = '';
      try {
        const pdfData = await readPdfText(file.buffer);
        rawText = pdfData.text || '';
      } catch (_err) {
        // PDF text extraction failed — fall through to vision
      }

      if (rawText && rawText.trim().length >= 20) {
        return await parseInvoiceWithNvidia(rawText, file.originalname, { documentType });
      }
      // Scanned / image-based PDF → vision model
      return await parseScannedInvoicePdfWithNvidia(file.buffer, file.originalname, { documentType });
    }

    if (isImage) {
      // Direct image (JPG/PNG phone photo) → vision model.
      // The vision path in nvidiaInvoiceParser converts pages to base64 images;
      // for a direct image we wrap the buffer in the same format it expects.
      return await parseScannedInvoicePdfWithNvidia(file.buffer, file.originalname, {
        documentType,
        isRawImage: true,       // signals to the service that no PDF rendering is needed
        imageMimeType: mime,
      });
    }
  } catch (err) {
    console.error(`[PublicSubmission] Parsing failed for ${file.originalname}:`, err.message);
  }

  // Could not parse — return a minimal "rejected" parsedData shape so the
  // reviewer can fill fields manually (same shape as parseInvoice minimal result)
  return {
    invoiceNumber: null,
    invoiceDate: null,
    dueDate: null,
    clientName: null,
    clientGST: null,
    vendorName: null,
    items: [],
    subTotal: null,
    taxAmount: null,
    totalAmount: null,
    confidence: 0,
    status: 'rejected',
    errors: ['Automatic parsing failed — please fill fields manually.'],
    warnings: [],
    metadata: { fileName: file.originalname, processingTime: '0ms' },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/public/submit/:token
// Returns only safe-to-display company info — never the User's real _id, email,
// GSTIN, or any other internal field.
// ─────────────────────────────────────────────────────────────────────────────
exports.getPublicPage = async (req, res) => {
  try {
    const settings = await resolveSettingsByToken(req.params.token);
    if (!settings) {
      return res.status(404).json({
        message: 'This link is no longer active or does not exist.',
      });
    }

    const ps = settings.publicSubmissions;
    return res.json({
      companyDisplayName: ps.companyDisplayName || 'A business',
      allowedCategories: ps.allowedCategories || ['expense'],
      instructionsText: ps.instructionsText || '',
      enabled: true,
    });
  } catch (error) {
    console.error('[PublicSubmission] getPublicPage error:', error.message);
    return res.status(500).json({ message: 'Server error' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/public/submit/:token
// Receives uploaded files + submitter metadata.
// Rate limiting (per-IP and daily-per-token) is applied by the route before
// this handler is reached.
// ─────────────────────────────────────────────────────────────────────────────
exports.createSubmission = async (req, res) => {
  try {
    // ── Token validation ────────────────────────────────────────────────────
    const settings = await resolveSettingsByToken(req.params.token);
    if (!settings) {
      return res.status(404).json({
        message: 'This link is no longer active or does not exist.',
      });
    }

    const ps = settings.publicSubmissions;

    // ── Daily cap ───────────────────────────────────────────────────────────
    const todayCount = await countTodaySubmissions(settings.user);
    if (todayCount >= (ps.maxSubmissionsPerDay || 100)) {
      return res.status(429).json({
        message: 'Daily submission limit reached for this portal. Please try again tomorrow.',
      });
    }

    // ── File validation ─────────────────────────────────────────────────────
    const uploadedFiles = req.files || [];
    if (uploadedFiles.length === 0) {
      return res.status(400).json({
        message: 'At least one file (PDF, JPG, or PNG) is required.',
      });
    }

    // ── Body fields (all optional) ──────────────────────────────────────────
    const submitterName  = String(req.body.submitterName  || '').trim().slice(0, 200);
    const submitterEmail = String(req.body.submitterEmail || '').trim().toLowerCase().slice(0, 200);
    const submitterPhone = String(req.body.submitterPhone || '').trim().slice(0, 50);
    const submitterNote  = String(req.body.submitterNote  || '').trim().slice(0, 2000);

    // The submitter may choose a category if allowedCategories has > 1 option.
    // We validate that the chosen category is actually in the allowed list.
    let chosenCategory = String(req.body.category || '').trim().toLowerCase();
    const allowed = ps.allowedCategories || ['expense'];
    if (!chosenCategory || !allowed.includes(chosenCategory)) {
      chosenCategory = allowed[0] || 'expense'; // Default to first allowed
    }

    // ── Build files array for storage ───────────────────────────────────────
    const filesForDb = uploadedFiles.map((f) => ({
      originalName: f.originalname,
      mimeType:     f.mimetype,
      sizeBytes:    f.size,
      buffer:       f.buffer,
      uploadedAt:   new Date(),
    }));

    // ── Parse primary file ──────────────────────────────────────────────────
    const primaryFile = uploadedFiles[0];
    const parsedData  = await parseFile(primaryFile, chosenCategory);

    // ── Guess category (heuristic, reviewer always confirms) ────────────────
    const suggestedCategory = guessSuggestedCategory(allowed, parsedData, primaryFile.mimetype);

    // ── Collect submitter IP (for abuse investigation only) ─────────────────
    const ip = req.ip || req.socket?.remoteAddress || '';

    // ── Persist ─────────────────────────────────────────────────────────────
    const submission = await PublicSubmission.create({
      user:             settings.user,
      submitterName,
      submitterEmail,
      submitterPhone,
      submitterNote,
      files:            filesForDb,
      parsedData,
      suggestedCategory,
      status:           'pending',
      ipAddress:        ip,
    });

    // ── Response (safe — no internal IDs or parsedData returned) ───────────
    const referenceNumber = `SUB-${submission._id.toString().slice(-8).toUpperCase()}`;
    return res.status(201).json({
      success: true,
      referenceNumber,
      message: 'Your documents have been submitted successfully. Keep your reference number for follow-up.',
    });
  } catch (error) {
    console.error('[PublicSubmission] createSubmission error:', error.message);
    return res.status(500).json({
      message: 'An error occurred while processing your submission. Please try again.',
    });
  }
};
