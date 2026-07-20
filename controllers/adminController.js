const User = require('../models/User');
const Client = require('../models/Client');
const Item = require('../models/Item');
const Invoice = require('../models/Invoice');
const Quote = require('../models/Quote');
const Proforma = require('../models/Proforma');
const PurchaseOrder = require('../models/PurchaseOrder');
const Expense = require('../models/Expense');
const Settings = require('../models/Settings');
const SubscriptionOrder = require('../models/SubscriptionOrder');

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

// @desc    Create a new user by Admin
// @route   POST /api/admin/users
// @access  Private/Admin
const createUser = async (req, res) => {
  try {
    const { username, email, password, role, plan, billingCycle, endDate } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ message: 'Username, email and password are required' });
    }

    const emailLower = email.toLowerCase();

    // Check if user or email already exists
    const existingUser = await User.findOne({ $or: [{ username }, { email: emailLower }] });
    if (existingUser) {
      if (existingUser.email === emailLower) {
        return res.status(400).json({ message: 'Email is already registered' });
      }
      return res.status(400).json({ message: 'Username is already taken' });
    }

    // Prepare subscription object
    const subscription = {
      plan: plan || 'free',
      status: 'active',
      billingCycle: billingCycle || 'monthly'
    };

    if (plan === 'pro' && endDate) {
      const d = new Date(endDate);
      if (!isNaN(d.getTime())) {
        subscription.endDate = d;
      }
    }

    // Create user
    const user = await User.create({
      username,
      email: emailLower,
      password, // hashed by the pre-save hook in User model
      role: role || 'user',
      subscription,
      isActive: true
    });

    const userObj = user.toObject();
    delete userObj.password;

    res.status(201).json(userObj);
  } catch (error) {
    console.error('Admin Create User Error:', error);
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(val => val.message);
      return res.status(400).json({ message: messages.join(', ') });
    }
    res.status(500).json({ message: 'Failed to create user: ' + error.message });
  }
};

// @desc    Update user subscription plan & active status
// @route   PATCH /api/admin/users/:id/plan
// @access  Private/Admin
const updateUserPlan = async (req, res) => {
  try {
    const { plan, status, endDate, billingCycle, isActive, role } = req.body;
    console.log('Update User Request:', { id: req.params.id, plan, status, endDate, billingCycle, isActive, role });

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
    if (isActive !== undefined) user.isActive = isActive;
    if (role !== undefined) user.role = role;

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
    console.log('Update Successful:', { 
      id: user._id, 
      plan: user.subscription.plan, 
      endDate: user.subscription.endDate,
      isActive: user.isActive,
      role: user.role
    });

    res.json(updatedUser);
  } catch (error) {
    console.error('User Update Error:', error);
    res.status(500).json({ message: 'Failed to update user: ' + error.message });
  }
};

// @desc    Delete a user and their associated data
// @route   DELETE /api/admin/users/:id
// @access  Private/Admin
const deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Protect against self-deletion
    if (String(user._id) === String(req.user._id)) {
      return res.status(400).json({ message: 'You cannot delete your own admin account' });
    }

    // Delete all related records
    await Promise.all([
      Client.deleteMany({ user: user._id }),
      Item.deleteMany({ user: user._id }),
      Invoice.deleteMany({ user: user._id }),
      Quote.deleteMany({ user: user._id }),
      Proforma.deleteMany({ user: user._id }),
      PurchaseOrder.deleteMany({ user: user._id }),
      Expense.deleteMany({ user: user._id }),
      Settings.deleteMany({ user: user._id }),
      SubscriptionOrder.deleteMany({ user: user._id }),
      User.deleteOne({ _id: user._id })
    ]);

    res.json({ message: 'User and all associated data deleted successfully' });
  } catch (error) {
    console.error('Delete User Error:', error);
    res.status(500).json({ message: 'Failed to delete user: ' + error.message });
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
  createUser,
  updateUserPlan,
  deleteUser,
  getUserPayments
};
