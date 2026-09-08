const User = require('../models/User');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
const { syncExpiredSubscription } = require('../utils/subscriptionLifecycle');
const escapeRegex = require('../utils/escapeRegex');

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

const buildAuthResponse = (req) => {
  const user = req.user || {};
  let permissionsObj = {};
  if (req.permissions) {
    if (req.permissions instanceof Map) {
      permissionsObj = Object.fromEntries(req.permissions);
    } else {
      permissionsObj = req.permissions;
    }
  }

  return {
    user: {
      _id: user._id,
      username: user.username,
      email: user.email,
      phone: user.phone,
      avatar: user.avatar || '',
      role: user.role,
      subscription: req.ownerUser?.subscription || user.subscription,
      isOwner: user.isOwner !== false,
      companyId: user.isOwner ? user._id : user.companyId,
      accessRole: user.accessRole,
      status: user.status || 'active',
      permissions: permissionsObj,
    }
  };
};

// Safari/Chrome Cookie Helper
const getCookieOptions = (req) => {
  const origin = req.get('origin') || '';
  const isLocalhost = origin.includes('localhost') || origin.includes('127.0.0.1');
  const isHttps = req.secure || req.protocol === 'https' || req.get('x-forwarded-proto') === 'https';
  const envSameSite = process.env.COOKIE_SAME_SITE?.toLowerCase();
  
  // Browsers drop cookies if Secure is true over plain HTTP.
  const secure = Boolean(isHttps && !isLocalhost);
  const sameSite = envSameSite || (secure ? 'none' : 'lax');
  
  return {
    httpOnly: true,
    secure,
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
    const cleanUsername = String(username || '').trim();

    if (!cleanUsername || !password) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const user = await User.findOne({ 
        $or: [
            { username: { $regex: new RegExp(`^${escapeRegex(cleanUsername)}$`, 'i') } }, 
            { email: cleanUsername.toLowerCase() }
        ] 
    });

    if (user && (await user.matchPassword(password))) {
      if (user.isActive === false) {
        return res.status(401).json({ message: 'Your account has been deactivated. Please contact your administrator.' });
      }

      // Ensure users whose Pro end date has passed are downgraded at login.
      await syncExpiredSubscription(user);

      req.user = user;
      const token = generateToken(user);
      res.cookie('token', token, getCookieOptions(req));

      res.json({
        ...buildAuthResponse(req),
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

// @desc    Authenticate with Google OAuth ID token (GIS credential)
// @route   POST /api/auth/google
// @access  Public
exports.googleLogin = async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential || typeof credential !== 'string') {
      return res.status(400).json({ message: 'Google credential token is required' });
    }

    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    if (!googleClientId) {
      console.error('ERROR: GOOGLE_CLIENT_ID is not configured in environment variables');
      return res.status(500).json({ message: 'Google OAuth is not configured on this server' });
    }

    // Verify token with Google's official OAuth2 tokeninfo endpoint
    let googlePayload;
    try {
      const response = await axios.get(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`,
        { timeout: 10000 }
      );
      googlePayload = response.data;
    } catch (err) {
      console.error('Google token verification failed:', err.response?.data || err.message);
      return res.status(401).json({ message: 'Invalid or expired Google credential' });
    }

    // Verify audience matches configured Google Client ID
    if (googlePayload.aud !== googleClientId) {
      return res.status(401).json({ message: 'Google credential audience does not match this application' });
    }

    // Verify valid Google issuer
    const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
    if (!validIssuers.includes(googlePayload.iss)) {
      return res.status(401).json({ message: 'Invalid Google token issuer' });
    }

    const email = (googlePayload.email || '').trim().toLowerCase();
    const isEmailVerified = googlePayload.email_verified === 'true' || googlePayload.email_verified === true;

    if (!email || !isEmailVerified) {
      return res.status(401).json({ message: 'A verified Google email address is required' });
    }

    let user = await User.findOne({ email });

    if (user) {
      if (user.isActive === false || user.status === 'suspended') {
        return res.status(401).json({
          message: 'Your account has been deactivated or suspended. Please contact your administrator.'
        });
      }

      // If user was invited, activate status upon verified Google login
      if (user.status === 'invited') {
        user.status = 'active';
      }

      // Populate avatar from Google profile if not already set
      if (!user.avatar && googlePayload.picture) {
        user.avatar = googlePayload.picture;
      }

      await user.save();
      await syncExpiredSubscription(user);
    } else {
      // Auto-provision new account for verified Google user
      const baseName = (googlePayload.name || email.split('@')[0])
        .replace(/[^a-zA-Z0-9_]/g, '')
        .slice(0, 15) || 'user';

      let username = baseName;
      let exists = await User.findOne({ username });
      let attempts = 0;
      while (exists && attempts < 20) {
        username = `${baseName}_${Math.floor(1000 + Math.random() * 9000)}`;
        exists = await User.findOne({ username });
        attempts++;
      }

      const randomPassword = crypto.randomBytes(32).toString('hex');

      user = await User.create({
        username,
        email,
        password: randomPassword,
        avatar: googlePayload.picture || '',
        phone: '',
        role: 'user',
        isOwner: true,
        companyId: null,
        status: 'active',
        subscription: {
          plan: 'free',
          status: 'active',
        },
      });
    }

    req.user = user;
    if (user.isOwner || !user.companyId) {
      req.ownerUser = user;
    } else {
      req.ownerUser = await User.findById(user.companyId).select('-password');
    }

    const token = generateToken(user);
    res.cookie('token', token, getCookieOptions(req));

    return res.json({
      ...buildAuthResponse(req),
      token,
    });
  } catch (error) {
    console.error('Google login error:', error);
    return res.status(500).json({ message: 'Server error during Google authentication' });
  }
};


exports.me = async (req, res) => {
  const token = generateToken(req.user);
  res.cookie('token', token, getCookieOptions(req));
  res.json({
    ...buildAuthResponse(req),
    token
  });
};

// @desc    Update logged-in user's profile (username, email, phone, password)
// @route   PUT /api/auth/profile
// @access  Private
exports.updateProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const { username, email, phone, avatar, currentPassword, newPassword } = req.body;

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
    if (avatar !== undefined) user.avatar = avatar;

    const updated = await user.save();
    res.json({
      user: {
        _id: updated._id,
        username: updated.username,
        email: updated.email,
        phone: updated.phone,
        avatar: updated.avatar || '',
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
