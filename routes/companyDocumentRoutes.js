const express = require('express');
const router = express.Router();
const companyDocumentController = require('../controllers/companyDocumentController');
const { protect } = require('../middleware/authMiddleware');
const multer = require('multer');

const upload = multer({
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
  storage: multer.memoryStorage(),
});

router.get('/', protect, companyDocumentController.getDocuments);
router.post('/', protect, upload.single('file'), companyDocumentController.uploadDocument);
router.get('/folders', protect, companyDocumentController.getFolders);
router.post('/folders', protect, companyDocumentController.createFolder);
router.delete('/folders/:id', protect, companyDocumentController.deleteFolder);
router.get('/:id/view', protect, companyDocumentController.viewDocument);
router.get('/:id/download', protect, companyDocumentController.downloadDocument);
router.post('/send-email', protect, companyDocumentController.sendDocumentEmail);
router.post('/:id/send-email', protect, companyDocumentController.sendDocumentEmail);
router.patch('/:id', protect, companyDocumentController.updateDocument);
router.delete('/:id', protect, companyDocumentController.deleteDocument);

module.exports = router;
