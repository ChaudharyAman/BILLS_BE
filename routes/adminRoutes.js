const express = require('express');
const router = express.Router();
const { protect, admin } = require('../middleware/authMiddleware');
const { 
  getAllUsers, 
  updateUserPlan, 
  getUserPayments 
} = require('../controllers/adminController');

// All routes here are protected and require admin role
router.use(protect);
router.use(admin);

router.get('/users', getAllUsers);
router.get('/users/:id/payments', getUserPayments);
router.patch('/users/:id/plan', updateUserPlan);

module.exports = router;
