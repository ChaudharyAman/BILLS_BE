const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const { createOrder, verifyPayment, getSubscriptionStatus, getUsageStats, getPaymentHistory } = require('../controllers/subscriptionController');

router.post('/create-order', protect, authorize('subscription', 'create'), createOrder);
router.post('/verify', protect, authorize('subscription', 'create'), verifyPayment);
router.get('/status', protect, authorize('subscription', 'view'), getSubscriptionStatus);
router.get('/usage', protect, authorize('subscription', 'view'), getUsageStats);
router.get('/history', protect, authorize('subscription', 'view'), getPaymentHistory);

module.exports = router;
