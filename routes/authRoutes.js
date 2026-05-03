const express = require('express');
const router = express.Router();
const { register, login, updateProfile, logout, me } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

router.post('/register', register);
router.post('/login', login);
router.post('/logout', logout);
router.get('/me', protect, me);
router.put('/profile', protect, updateProfile);

module.exports = router;
