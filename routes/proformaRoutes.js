const express = require('express');
const router = express.Router();
const proformaController = require('../controllers/proformaController');
const { protect, authorize } = require('../middleware/authMiddleware');

router.get('/', protect, authorize('proformas', 'view'), proformaController.getProformas);
router.get('/:id', protect, authorize('proformas', 'view'), proformaController.getProformaById);
router.post('/', protect, authorize('proformas', 'create'), proformaController.createProforma);
router.post('/bulk', protect, authorize('proformas', 'create'), proformaController.bulkCreateProformas);
router.put('/:id', protect, authorize('proformas', 'edit'), proformaController.updateProforma);
router.put('/:id/status', protect, authorize('proformas', 'approve'), proformaController.updateProformaStatus);
router.delete('/:id', protect, authorize('proformas', 'delete'), proformaController.deleteProforma);
router.post('/:id/convert', protect, authorize('proformas', 'approve'), proformaController.convertToInvoice);

module.exports = router;
