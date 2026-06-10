const User = require('../models/User');
const jwt = require('jsonwebtoken');
const { syncExpiredSubscription } = require('../utils/subscriptionLifecycle');

// Generate JWT Token
const generateToken = (user) => {
  if (!process.env.JWT_SECRET) {
      console.error('ERROR: JWT_SECRET is not defined in environment variables!');
      throw new Error('JWT_SECRET is missing');
  }
  return jwt.sign({
    id: user._id,
    role: user.role,
    subscription: user.subscription,
  }, process.env.JWT_SECRET, {
    expiresIn: '30d'
  });
};

const buildAuthResponse = (user) => ({
  user: {
    _id: user._id,
    username: user.username,
    email: user.email,
    role: user.role,
    subscription: user.subscription
  }
});

// Safari/Chrome Cookie Helper
const getCookieOptions = (req) => {
  const origin = req.get('origin') || '';
  const isLocalhost = origin.includes('localhost') || origin.includes('127.0.0.1');
  const envSameSite = process.env.COOKIE_SAME_SITE?.toLowerCase();
  const sameSite = envSameSite || (isLocalhost ? 'lax' : 'none');
  
  return {
    httpOnly: true,
    secure: !isLocalhost,
    sameSite,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  };
};

// @desc    Register new user
// @route   POST /api/auth/register
// @access  Public (Disabled)
exports.register = async (req, res) => {
  return res.status(403).json({
    message: 'Public registration is disabled. Contact an administrator to create an account.'
  });
};

// @desc    Authenticate user & get token
// @route   POST /api/auth/login
// @access  Public
exports.login = async (req, res) => {
  try {
    const { username, password } = req.body;

    const user = await User.findOne({ 
        $or: [
            { username: username }, 
            { email: username.toLowerCase() }
        ] 
    });

    if (user && (await user.matchPassword(password))) {
      if (user.isActive === false) {
        return res.status(401).json({ message: 'Your account has been deactivated. Please contact your administrator.' });
      }

      // Ensure users whose Pro end date has passed are downgraded at login.
      await syncExpiredSubscription(user);

      const token = generateToken(user);
      res.cookie('token', token, getCookieOptions(req));

      res.json(buildAuthResponse(user));
    } else {
      res.status(401).json({ message: 'Invalid credentials' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.me = async (req, res) => {
  const token = generateToken(req.user);
  res.cookie('token', token, getCookieOptions(req));
  res.json(buildAuthResponse(req.user));
};

// @desc    Update logged-in user's profile (username, email, phone, password)
// @route   PUT /api/auth/profile
// @access  Private
exports.updateProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const { username, email, phone, currentPassword, newPassword } = req.body;

    // If changing password, verify current password first
    if (newPassword) {
      if (!currentPassword) return res.status(400).json({ message: 'Current password is required to set a new password' });
      const match = await user.matchPassword(currentPassword);
      if (!match) return res.status(400).json({ message: 'Current password is incorrect' });
      user.password = newPassword;
    }

    // Check uniqueness for username/email if being changed
    if (username && username !== user.username) {
      const exists = await User.findOne({ username });
      if (exists) return res.status(400).json({ message: 'Username already taken' });
      user.username = username;
    }
    if (email && email.toLowerCase() !== user.email) {
      const exists = await User.findOne({ email: email.toLowerCase() });
      if (exists) return res.status(400).json({ message: 'Email already in use' });
      user.email = email.toLowerCase();
    }
    if (phone !== undefined) user.phone = phone;

    const updated = await user.save();
    res.json({
      user: {
        _id: updated._id,
        username: updated.username,
        email: updated.email,
        phone: updated.phone,
        role: updated.role,
        subscription: updated.subscription
      }
    });
  } catch (error) {
    console.error('updateProfile error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Logout user / clear cookie
// @route   POST /api/auth/logout
// @access  Public
exports.logout = (req, res) => {
  const options = getCookieOptions(req);
  res.cookie('token', '', {
    ...options,
    expires: new Date(0),
    maxAge: 0
  });
  res.status(200).json({ message: 'Logged out successfully' });
};
