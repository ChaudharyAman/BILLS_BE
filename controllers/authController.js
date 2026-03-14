const User = require('../models/User');
const jwt = require('jsonwebtoken');

// Generate JWT Token
const generateToken = (id) => {
  if (!process.env.JWT_SECRET) {
      console.error('ERROR: JWT_SECRET is not defined in environment variables!');
      throw new Error('JWT_SECRET is missing');
  }
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: '30d'
  });
};

// Safari/Chrome Cookie Helper
const getCookieOptions = (req) => {
  const origin = req.get('origin') || '';
  const isLocalhost = origin.includes('localhost') || origin.includes('127.0.0.1');
  
  return {
    httpOnly: true,
    secure: true, // Default to secure
    sameSite: 'none',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    // Override for local dev if not using HTTPS
    ...(isLocalhost && {
      secure: false,
      sameSite: 'lax'
    })
  };
};

// @desc    Register new user
// @route   POST /api/auth/register
// @access  Public
exports.register = async (req, res) => {
  try {
    const { username, password } = req.body;
    let { email } = req.body;
    
    // Enforce lowercase email
    if (email) email = email.toLowerCase();

    // Check if user or email already exists
    const existingUser = await User.findOne({ $or: [{ username }, { email }] });

    if (existingUser) {
      if (existingUser.email === email) {
        return res.status(400).json({ message: 'Email is already registered' });
      }
      return res.status(400).json({ message: 'Username is already taken' });
    }

    // Create user
    const user = await User.create({
      username,
      email,
      password
    });

    if (user) {
      const token = generateToken(user._id);
      res.cookie('token', token, getCookieOptions(req));

      res.status(201).json({
        user: {
          _id: user._id,
          username: user.username,
          email: user.email,
          role: user.role,
          subscription: user.subscription
        },
        token
      });
    } else {
      res.status(400).json({ message: 'Invalid user data' });
    }
  } catch (error) {
    console.error('Registration Error:', error);
    
    // Handle Mongoose Validation Errors
    if (error.name === 'ValidationError') {
        const messages = Object.values(error.errors).map(val => val.message);
        return res.status(400).json({ message: messages.join(', ') });
    }
    
    // Handle Duplicate Key Error (fallback)
    if (error.code === 11000) {
        return res.status(400).json({ message: 'User or Email already exists' });
    }

    console.error('CRITICAL SERVER ERROR during registration:', error);
    res.status(500).json({ message: 'Server error during registration', error: error.message });
  }
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
      const token = generateToken(user._id);
      res.cookie('token', token, getCookieOptions(req));

      res.json({
        user: {
          _id: user._id,
          username: user.username,
          email: user.email,
          role: user.role,
          subscription: user.subscription
        },
        token
      });
    } else {
      res.status(401).json({ message: 'Invalid credentials' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
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
