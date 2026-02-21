const express = require('express');
const router = express.Router();
const quoteController = require('../controllers/quoteController');
const { protect } = require('../middleware/authMiddleware');

router.get('/', protect, quoteController.getQuotes);
router.get('/:id', protect, quoteController.getQuoteById);
router.post('/', protect, quoteController.createQuote);
router.post('/bulk', protect, quoteController.bulkCreateQuotes);
router.put('/:id', protect, quoteController.updateQuote);
router.delete('/:id', protect, quoteController.deleteQuote);
router.post('/:id/convert', protect, quoteController.convertToInvoice);

module.exports = router;
