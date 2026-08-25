const express = require('express');
const router = express.Router();
const quoteController = require('../controllers/quoteController');
const { protect, authorize } = require('../middleware/authMiddleware');

router.get('/', protect, authorize('quotes', 'view'), quoteController.getQuotes);
router.get('/:id', protect, authorize('quotes', 'view'), quoteController.getQuoteById);
router.post('/', protect, authorize('quotes', 'create'), quoteController.createQuote);
router.post('/bulk', protect, authorize('quotes', 'create'), quoteController.bulkCreateQuotes);
router.put('/:id', protect, authorize('quotes', 'edit'), quoteController.updateQuote);
router.put('/:id/status', protect, authorize('quotes', 'approve'), quoteController.updateQuoteStatus);
router.delete('/:id', protect, authorize('quotes', 'delete'), quoteController.deleteQuote);
router.post('/:id/convert', protect, authorize('quotes', 'approve'), quoteController.convertToInvoice);

module.exports = router;
