const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { register, login, googleLogin, updateProfile, logout, me } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

// Dedicated rate limiter for login to prevent credential stuffing and brute-force attacks
const loginLimiter = rateLimit({
  windowMs: Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: Number(process.env.LOGIN_RATE_LIMIT_MAX) || 10, // Max 10 failed attempts per IP per 15 minutes
  skipSuccessfulRequests: true, // Successful logins do not count against the limit
  skip: () => process.env.NODE_ENV === 'test', // Bypass in test environments
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Too many failed login attempts from this IP. Please try again after 15 minutes.',
  },
});

router.post('/register', register);
router.post('/login', loginLimiter, login);
router.post('/google', googleLogin);
router.post('/logout', logout);
router.get('/me', protect, me);
router.put('/profile', protect, updateProfile);

module.exports = router;
