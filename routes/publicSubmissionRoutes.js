/**
 * publicSubmissionRoutes.js
 *
 * PUBLIC routes — NO `protect` middleware.
 * These endpoints are intentionally unauthenticated: the public token in the
 * URL is the only scoping mechanism.
 *
 * Rate limiting strategy (defence-in-depth):
 *   1. Global /api rate limit already applied in index.js (1000 req / 15 min / IP).
 *   2. POST gets an additional tighter per-IP limit: 30 req / 15 min / IP.
 *   3. Per-token daily cap is enforced inside the controller against the DB.
 */

const express    = require('express');
const router     = express.Router();
const rateLimit  = require('express-rate-limit');
const documentUpload = require('../middleware/documentUpload');
const {
  getPublicPage,
  createSubmission,
} = require('../controllers/publicSubmissionController');

// ── Per-IP rate limiter for the public POST route ────────────────────────────
// Tighter than the global /api limiter because this endpoint accepts file
// uploads from the open internet without any authentication.
const publicPostLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,       // 15-minute window
  max: 30,                         // 30 POSTs per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Too many submissions from this IP. Please wait 15 minutes and try again.',
  },
  // Skip the limiter for the GET route (applied only to POST below)
  skip: (req) => req.method !== 'POST',
});

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/public/submit/:token
// Returns safe company info for rendering the landing page.
router.get('/submit/:token', getPublicPage);

// POST /api/public/submit/:token
// Accepts up to 5 files (PDF/JPG/PNG) + submitter metadata.
// multer error handler converts multer errors to clean JSON 400 responses.
router.post(
  '/submit/:token',
  publicPostLimiter,
  (req, res, next) => {
    documentUpload.array('files', 5)(req, res, (err) => {
      if (err) {
        // multer errors (file type, size limit, etc.) → clean 400
        return res.status(400).json({ message: err.message || 'File upload error.' });
      }
      next();
    });
  },
  createSubmission
);

module.exports = router;
