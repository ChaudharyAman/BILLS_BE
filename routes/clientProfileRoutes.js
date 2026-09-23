const express = require('express');
const router = express.Router();
const clientProfileController = require('../controllers/clientProfileController');
const { protect } = require('../middleware/authMiddleware');

router.get('/mine', protect, clientProfileController.getMyProfiles);
router.post('/', protect, clientProfileController.createProfile);
router.put('/:id', protect, clientProfileController.updateProfile);
router.patch('/:id', protect, clientProfileController.updateProfile);
router.delete('/:id', protect, clientProfileController.deleteProfile);
router.post('/:id/set-default', protect, clientProfileController.setDefaultProfile);

module.exports = router;
