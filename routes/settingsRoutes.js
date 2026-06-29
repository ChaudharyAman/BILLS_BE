const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');

const { protect } = require('../middleware/authMiddleware');
const upload = require('../middleware/upload');

router.get('/', protect, settingsController.getSettings);
router.put('/', protect, upload.fields([
  { name: 'logo', maxCount: 1 },
  { name: 'signature', maxCount: 1 }
]), settingsController.updateSettings);

// ── Public Submission Portal config ──────────────────────────────────────────
// regenerate-token must be declared before the generic PATCH to avoid routing conflicts
router.post('/public-submissions/regenerate-token', protect, settingsController.regeneratePublicToken);
router.get('/public-submissions',  protect, settingsController.getPublicSubmissionsConfig);
router.patch('/public-submissions', protect, settingsController.updatePublicSubmissionsConfig);

module.exports = router;

