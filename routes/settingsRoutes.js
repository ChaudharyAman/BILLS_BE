const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');

const { protect, authorize } = require('../middleware/authMiddleware');
const upload = require('../middleware/upload');

router.get('/', protect, authorize('settings', 'view'), settingsController.getSettings);
router.put('/', protect, authorize('settings', 'edit'), upload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'signature', maxCount: 1 }
]), settingsController.updateSettings);

// ── Public Submission Portal config ──────────────────────────────────────────
// regenerate-token must be declared before the generic PATCH to avoid routing conflicts
router.post('/public-submissions/regenerate-token', protect, authorize('settings', 'edit'), settingsController.regeneratePublicToken);
router.get('/public-submissions',  protect, authorize('settings', 'view'), settingsController.getPublicSubmissionsConfig);
router.patch('/public-submissions', protect, authorize('settings', 'edit'), settingsController.updatePublicSubmissionsConfig);

module.exports = router;
