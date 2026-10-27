const express = require('express');
const router = express.Router();
const clientProfileController = require('../controllers/clientProfileController');
const { protect, authorize } = require('../middleware/authMiddleware');

router.get('/mine', protect, clientProfileController.getMyProfiles);
router.post('/', protect, authorize('clientProfiles', 'create'), clientProfileController.createProfile);
router.put('/:id', protect, authorize('clientProfiles', 'edit'), clientProfileController.updateProfile);
router.patch('/:id', protect, authorize('clientProfiles', 'edit'), clientProfileController.updateProfile);
router.delete('/:id', protect, authorize('clientProfiles', 'delete'), clientProfileController.deleteProfile);
router.post('/:id/set-default', protect, authorize('clientProfiles', 'edit'), clientProfileController.setDefaultProfile);

module.exports = router;
