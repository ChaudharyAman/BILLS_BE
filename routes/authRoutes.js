const express = require('express');
const router = express.Router();
const { register, login, updateProfile, logout } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

router.post('/register', register);
router.post('/login', login);
router.post('/logout', logout);
router.put('/profile', protect, updateProfile);

module.exports = router;
