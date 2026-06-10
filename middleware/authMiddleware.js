const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { syncExpiredSubscription } = require('../utils/subscriptionLifecycle');

const protect = async (req, res, next) => {
  let token;

  if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = await User.findById(decoded.id).select('-password');
    if (!req.user) {
      return res.status(401).json({ message: 'Not authorized, user not found' });
    }

    if (req.user.isActive === false) {
      return res.status(401).json({ message: 'Not authorized, user account is deactivated' });
    }

    // Keep plan state consistent: expired Pro users are auto-downgraded to free.
    if (req.user.subscription?.plan !== 'free') {
      await syncExpiredSubscription(req.user);
    }

    next();
  } catch (error) {
    console.error('Auth middleware error:', error.message);
    return res.status(401).json({ message: 'Not authorized, token invalid or expired' });
  }
};

const admin = (req, res, next) => {
  if (req.user && req.user.role === 'superadmin') {
    next();
  } else {
    res.status(401).json({ message: 'Not authorized as an admin' });
  }
};

const premium = (req, res, next) => {
  const isSuperAdmin = req.user?.role === 'superadmin';
  const isActivePro = req.user?.subscription?.plan === 'pro' && req.user?.subscription?.status === 'active';

  if (isSuperAdmin || isActivePro) {
    return next();
  }

  return res.status(403).json({ message: 'This feature is available on the Pro plan only.' });
};

module.exports = { protect, admin, premium };
