const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AccessRole = require('../models/AccessRole');
const { syncExpiredSubscription } = require('../utils/subscriptionLifecycle');

const protect = async (req, res, next) => {
  let token;

  if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  } else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = await User.findById(decoded.id)
      .select('-password')
      .populate('accessRole');

    if (!req.user) {
      return res.status(401).json({ message: 'Not authorized, user not found' });
    }

    if (req.user.isActive === false || req.user.status === 'suspended') {
      return res.status(401).json({ message: 'Not authorized, account is deactivated or suspended' });
    }

    // Determine companyId for tenancy scoping
    if (req.user.isOwner || !req.user.companyId) {
      req.companyId = req.user._id;
      req.ownerUser = req.user;
    } else {
      req.companyId = req.user.companyId;
      // Fetch company owner to check master plan and status
      req.ownerUser = await User.findById(req.user.companyId).select('-password');
      if (!req.ownerUser || req.ownerUser.isActive === false) {
        return res.status(401).json({ message: 'Not authorized, company owner account is inactive' });
      }
    }

    // Resolve permissions map
    if (req.user.isOwner || req.user.role === 'superadmin') {
      // Owner / superadmin has implicit full access to all modules
      const fullMap = new Map();
      for (const mod of AccessRole.SYSTEM_MODULES) {
        fullMap.set(mod, { view: true, create: true, edit: true, delete: true, approve: true });
      }
      req.permissions = fullMap;
    } else if (req.user.accessRole && req.user.accessRole.permissions) {
      req.permissions = req.user.accessRole.permissions;
    } else {
      // Fail closed: no permissions granted if accessRole is missing or deleted
      req.permissions = new Map();
    }

    // Keep plan state consistent: expired Pro users are auto-downgraded to free.
    if (req.ownerUser.subscription?.plan !== 'free') {
      await syncExpiredSubscription(req.ownerUser);
    }

    next();
  } catch (error) {
    console.error('Auth middleware error:', error.message);
    return res.status(401).json({ message: 'Not authorized, token invalid or expired' });
  }
};

/**
 * Authorize middleware ensuring acting user has required permission on target module.
 * @param {string} moduleName - Module identifier (e.g. 'expenses', 'invoices', 'teamMembers')
 * @param {string} action - Action identifier ('view', 'create', 'edit', 'delete', 'approve')
 */
const authorize = (moduleName, action) => (req, res, next) => {
  if (req.user?.isOwner || req.user?.role === 'superadmin') {
    return next();
  }

  if (!req.permissions) {
    return res.status(403).json({ message: `Forbidden: No permissions assigned.` });
  }

  const modPerms = req.permissions.get ? req.permissions.get(moduleName) : req.permissions[moduleName];

  if (modPerms && modPerms[action] === true) {
    return next();
  }

  return res.status(403).json({
    message: `Forbidden: You do not have '${action}' permission for '${moduleName}'.`,
  });
};

const admin = (req, res, next) => {
  if (req.user && req.user.role === 'superadmin') {
    next();
  } else {
    res.status(401).json({ message: 'Not authorized as a superadmin' });
  }
};

const premium = (req, res, next) => {
  const isSuperAdmin = req.user?.role === 'superadmin';
  const ownerSub = req.ownerUser?.subscription || req.user?.subscription;
  const isActivePro = ownerSub?.plan === 'pro' && ownerSub?.status === 'active';

  if (isSuperAdmin || isActivePro) {
    return next();
  }

  return res.status(403).json({ message: 'This feature is available on the Pro plan only.' });
};

module.exports = { protect, authorize, admin, premium };
