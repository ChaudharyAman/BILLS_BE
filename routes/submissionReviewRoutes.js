/**
 * submissionReviewRoutes.js
 *
 * Authenticated review routes for the business owner's submission inbox.
 * All routes use `protect` and `authorize` middleware — req.user is always set.
 */

const express = require('express');
const router  = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/submissionReviewController');

// List & detail
router.get('/',    protect, authorize('publicSubmissions', 'view'), ctrl.getSubmissions);
router.get('/:id', protect, authorize('publicSubmissions', 'view'), ctrl.getSubmissionById);

// Serve a single file (browser-viewable inline)
router.get('/:id/files/:fileIndex', protect, authorize('publicSubmissions', 'view'), ctrl.getSubmissionFile);

// Edit parsed data before deciding
router.patch('/:id', protect, authorize('publicSubmissions', 'edit'), ctrl.editParsedData);

// Split multi-file submission into individual submissions
router.post('/:id/split', protect, authorize('publicSubmissions', 'edit'), ctrl.splitSubmission);

// On-demand parse a single file in a multi-file submission
router.post('/:id/files/:fileIndex/parse', protect, authorize('publicSubmissions', 'edit'), ctrl.parseSubmissionFile);

// Remove a file from a multi-file submission
router.delete('/:id/files/:fileIndex', protect, authorize('publicSubmissions', 'edit'), ctrl.removeSubmissionFile);

// Review decisions
router.post('/:id/approve',          protect, authorize('publicSubmissions', 'approve'), ctrl.approveSubmission);
router.post('/:id/reject',           protect, authorize('publicSubmissions', 'approve'), ctrl.rejectSubmission);
router.post('/:id/request-changes',  protect, authorize('publicSubmissions', 'approve'), ctrl.requestChanges);

module.exports = router;
