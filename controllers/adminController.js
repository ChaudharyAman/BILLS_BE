const User = require('../models/User');

// @desc    Get all users
// @route   GET /api/admin/users
// @access  Private/Admin
const getAllUsers = async (req, res) => {
  try {
    const users = await User.find({}).select('-password').sort({ createdAt: -1 });
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update user subscription plan
// @route   PATCH /api/admin/users/:id/plan
// @access  Private/Admin
const updateUserPlan = async (req, res) => {
  try {
    const { plan, status, endDate, billingCycle } = req.body;
    const user = await User.findById(req.params.id);

    if (user) {
      if (plan) user.subscription.plan = plan;
      if (status) user.subscription.status = status;
      if (endDate) user.subscription.endDate = new Date(endDate);
      if (billingCycle) user.subscription.billingCycle = billingCycle;

      const updatedUser = await user.save();
      res.json({
        _id: updatedUser._id,
        username: updatedUser.username,
        subscription: updatedUser.subscription
      });
    } else {
      res.status(404).json({ message: 'User not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get user payment history
// @route   GET /api/admin/users/:id/payments
// @access  Private/Admin
const getUserPayments = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('paymentHistory username');
    if (user) {
      res.json(user);
    } else {
      res.status(404).json({ message: 'User not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getAllUsers,
  updateUserPlan,
  getUserPayments
};
