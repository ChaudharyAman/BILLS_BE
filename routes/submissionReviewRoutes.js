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

// Review decisions
router.post('/:id/approve',          protect, authorize('publicSubmissions', 'approve'), ctrl.approveSubmission);
router.post('/:id/reject',           protect, authorize('publicSubmissions', 'approve'), ctrl.rejectSubmission);
router.post('/:id/request-changes',  protect, authorize('publicSubmissions', 'approve'), ctrl.requestChanges);

module.exports = router;
