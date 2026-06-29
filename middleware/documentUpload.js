/**
 * documentUpload.js
 *
 * Generalized multer middleware for the public submission portal.
 * Accepts PDF, JPG, JPEG, and PNG files (phone-photographed receipts are a
 * primary use-case, so image types are explicitly included alongside PDFs).
 *
 * Sibling of pdfUpload.js, which is PDF-only and used for the existing
 * /api/pdf/extract routes. This one must NOT replace pdfUpload.js.
 *
 * Limits:
 *   - 10 MB per file  (same as pdfUpload.js)
 *   - 5 files max per request (enforced here via .array('files', 5))
 */

const multer = require('multer');
const path   = require('path');

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png']);
const ALLOWED_MIMETYPES  = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
]);

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const ext      = path.extname(file.originalname).toLowerCase();
  const mime     = (file.mimetype || '').toLowerCase();
  const extOk    = ALLOWED_EXTENSIONS.has(ext);
  const mimeOk   = ALLOWED_MIMETYPES.has(mime);

  if (extOk || mimeOk) {
    cb(null, true);
  } else {
    cb(
      new Error(
        `Only PDF, JPG, and PNG files are accepted. Received: ${file.originalname}`
      ),
      false
    );
  }
};

const documentUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
  fileFilter,
});

module.exports = documentUpload;
