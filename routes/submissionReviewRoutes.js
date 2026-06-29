/**
 * submissionReviewRoutes.js
 *
 * Authenticated review routes for the business owner's submission inbox.
 * All routes use the `protect` middleware — req.user is always set.
 * Scoping to req.user._id is enforced inside each controller handler.
 */

const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/submissionReviewController');

// List & detail
router.get('/',    protect, ctrl.getSubmissions);
router.get('/:id', protect, ctrl.getSubmissionById);

// Serve a single file (browser-viewable inline)
router.get('/:id/files/:fileIndex', protect, ctrl.getSubmissionFile);

// Edit parsed data before deciding
router.patch('/:id', protect, ctrl.editParsedData);

// Review decisions
router.post('/:id/approve',          protect, ctrl.approveSubmission);
router.post('/:id/reject',           protect, ctrl.rejectSubmission);
router.post('/:id/request-changes',  protect, ctrl.requestChanges);

module.exports = router;
