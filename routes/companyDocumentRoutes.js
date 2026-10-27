const express = require('express');
const router = express.Router();
const companyDocumentController = require('../controllers/companyDocumentController');
const { protect, authorize } = require('../middleware/authMiddleware');
const multer = require('multer');

const upload = multer({
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
  storage: multer.memoryStorage(),
});

router.get('/', protect, authorize('settings', 'view'), companyDocumentController.getDocuments);
router.post('/', protect, authorize('settings', 'create'), upload.single('file'), companyDocumentController.uploadDocument);
router.get('/folders', protect, authorize('settings', 'view'), companyDocumentController.getFolders);
router.post('/folders', protect, authorize('settings', 'create'), companyDocumentController.createFolder);
router.delete('/folders/:id', protect, authorize('settings', 'delete'), companyDocumentController.deleteFolder);
router.get('/:id/view', protect, authorize('settings', 'view'), companyDocumentController.viewDocument);
router.get('/:id/download', protect, authorize('settings', 'view'), companyDocumentController.downloadDocument);
router.post('/send-email', protect, authorize('settings', 'edit'), companyDocumentController.sendDocumentEmail);
router.post('/:id/send-email', protect, authorize('settings', 'edit'), companyDocumentController.sendDocumentEmail);
router.patch('/:id', protect, authorize('settings', 'edit'), companyDocumentController.updateDocument);
router.delete('/:id', protect, authorize('settings', 'delete'), companyDocumentController.deleteDocument);

module.exports = router;
