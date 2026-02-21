const express = require('express');
const router = express.Router();
const proformaController = require('../controllers/proformaController');
const { protect } = require('../middleware/authMiddleware');

router.get('/', protect, proformaController.getProformas);
router.get('/:id', protect, proformaController.getProformaById);
router.post('/', protect, proformaController.createProforma);
router.post('/bulk', protect, proformaController.bulkCreateProformas);
router.put('/:id', protect, proformaController.updateProforma);
router.delete('/:id', protect, proformaController.deleteProforma);
router.post('/:id/convert', protect, proformaController.convertToInvoice);

module.exports = router;
