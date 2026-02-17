const User = require('../models/User');
const jwt = require('jsonwebtoken');

// Generate JWT Token
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: '30d'
  });
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
      res.status(201).json({
        _id: user._id,
        username: user.username,
        email: user.email,
        token: generateToken(user._id)
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

    res.status(500).json({ message: 'Server error during registration' });
  }
};

// @desc    Authenticate user & get token
// @route   POST /api/auth/login
// @access  Public
exports.login = async (req, res) => {
  try {
    const { username, password } = req.body;

    // Check for user
    // Check for user by username or email (lowercase if checking email)
    const user = await User.findOne({ 
        $or: [
            { username: username }, 
            { email: username.toLowerCase() } // Allow login with email (case-insensitive)
        ] 
    });

    if (user && (await user.matchPassword(password))) {
      res.json({
        _id: user._id,
        _id: user._id,
        username: user.username,
        email: user.email,
        token: generateToken(user._id)
      });
    } else {
      res.status(401).json({ message: 'Invalid credentials' });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};
