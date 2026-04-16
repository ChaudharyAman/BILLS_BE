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
    console.log('Update Plan Request:', { id: req.params.id, plan, status, endDate, billingCycle });

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Initialize subscription object if it doesn't exist
    if (!user.subscription) {
      user.subscription = { plan: 'free', status: 'active' };
    }

    // Update fields
    if (plan !== undefined) user.subscription.plan = plan;
    if (status !== undefined) user.subscription.status = status;
    if (billingCycle !== undefined) user.subscription.billingCycle = billingCycle;

    // Handle Date safely
    if (endDate === '' || endDate === null || plan === 'free') {
      user.subscription.endDate = null;
    } else if (endDate) {
      const d = new Date(endDate);
      if (!isNaN(d.getTime())) {
        user.subscription.endDate = d;
      }
    }

    // Direct reset if switching to free
    if (plan === 'free') {
      user.subscription.status = 'active';
    }

    // Mark modified for nested object to ensure persistence
    user.markModified('subscription');

    const updatedUser = await user.save();
    console.log('Update Successful:', { id: user._id, plan: user.subscription.plan, endDate: user.subscription.endDate });

    res.json(updatedUser);
  } catch (error) {
    console.error('Plan Update Error:', error);
    res.status(500).json({ message: 'Failed to update plan: ' + error.message });
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
