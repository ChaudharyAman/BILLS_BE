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
    
    // Prepare update object
    const update = {};
    if (plan !== undefined) update['subscription.plan'] = plan;
    if (status !== undefined) update['subscription.status'] = status;
    if (billingCycle !== undefined) update['subscription.billingCycle'] = billingCycle;
    
    // Handle Date safely
    if (endDate === '' || endDate === null || plan === 'free') {
      update['subscription.endDate'] = null;
    } else if (endDate) {
      const d = new Date(endDate);
      if (!isNaN(d.getTime())) {
        update['subscription.endDate'] = d;
      }
    }

    // Direct reset if switching to free
    if (plan === 'free') {
      update['subscription.status'] = 'active';
    }

    const updatedUser = await User.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, runValidators: false } // runValidators: false helps bypass required email checks if they fail
    ).select('-password');

    if (updatedUser) {
      res.json(updatedUser);
    } else {
      res.status(404).json({ message: 'User not found' });
    }
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
