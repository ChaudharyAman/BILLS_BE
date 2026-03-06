const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { createOrder, verifyPayment, getSubscriptionStatus, getUsageStats, getPaymentHistory } = require('../controllers/subscriptionController');

router.post('/create-order', protect, createOrder);
router.post('/verify', protect, verifyPayment);
router.get('/status', protect, getSubscriptionStatus);
router.get('/usage', protect, getUsageStats);
router.get('/history', protect, getPaymentHistory);

module.exports = router;
