const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AccessRole = require('../models/AccessRole');
const { syncExpiredSubscription } = require('../utils/subscriptionLifecycle');

const protect = async (req, res, next) => {
  if (req.user || req.isShareToken) {
    return next();
  }
  const candidateTokens = [];
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    candidateTokens.push(req.headers.authorization.split(' ')[1]);
  }
  if (req.cookies && req.cookies.token) {
    candidateTokens.push(req.cookies.token);
  }

  if (candidateTokens.length === 0) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  let decoded = null;
  let token = null;

  for (const candidate of candidateTokens) {
    try {
      decoded = jwt.verify(candidate, process.env.JWT_SECRET);
      token = candidate;
      break;
    } catch (err) {
      // Continue to next candidate (e.g. if cookie was expired but fresh Bearer token is provided)
    }
  }

  if (!decoded) {
    return res.status(401).json({ message: 'Not authorized, token invalid or expired' });
  }

  try {
    if (decoded.isShareToken && decoded.shareId) {
      const ProfileShare = require('../models/ProfileShare');
      const share = await ProfileShare.findById(decoded.shareId).populate('profile');
      if (!share || share.status !== 'active') {
        return res.status(401).json({ message: 'Share link has been revoked or is inactive' });
      }
      if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
        share.status = 'expired';
        await share.save().catch(() => {});
        return res.status(401).json({ message: 'Share link has expired' });
      }
      req.isShareToken = true;
      req.isSharedAccess = true;
      req.profileAccessSource = 'share';
      req.shareAccessLevel = share.rules?.accessLevel || 'VIEW_ONLY';
      req.isSharedViewOnly = (req.shareAccessLevel === 'VIEW_ONLY');
      req.shareRules = share.rules;
      req.activeProfileId = share.profile._id;
      req.activeProfile = share.profile;
      req.shareSession = {
        shareId: share._id,
        profileId: share.profile._id,
        profile: share.profile,
        rules: share.rules,
      };
      req.user = {
        _id: null,
        isOwner: false,
        role: 'share_viewer',
        username: 'Shared Viewer',
        email: share.sharedWithEmail || '',
      };
      req.ownerUser = {
        _id: share.profile.owner,
        subscription: { plan: 'pro', status: 'active' },
        enabledModules: AccessRole.SYSTEM_MODULES,
      };
      req.companyId = share.profile.owner;
      return next();
    }

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

    // Resolve permissions map with company enabledModules scoping
    if (req.user.role === 'superadmin') {
      // Superadmin has implicit full access to all modules
      const fullMap = new Map();
      for (const mod of AccessRole.SYSTEM_MODULES) {
        fullMap.set(mod, { view: true, create: true, edit: true, delete: true, approve: true, enabled: true });
      }
      req.permissions = fullMap;
    } else {
      const enabledList = Array.isArray(req.ownerUser?.enabledModules)
        ? req.ownerUser.enabledModules
        : AccessRole.SYSTEM_MODULES;
      const enabledSet = new Set(enabledList);

      if (req.user.isOwner) {
        const fullMap = new Map();
        const customPerms = req.ownerUser?.modulePermissions;
        for (const mod of AccessRole.SYSTEM_MODULES) {
          if (enabledSet.has(mod)) {
            const custom = customPerms?.get ? customPerms.get(mod) : customPerms?.[mod];
            const customObj = custom?.toObject ? custom.toObject() : (custom?._doc || custom || null);
            if (customObj) {
              fullMap.set(mod, {
                view: customObj.view !== false,
                create: customObj.create !== false,
                edit: customObj.edit !== false,
                delete: customObj.delete !== false,
                approve: customObj.approve !== false,
                enabled: true,
              });
            } else {
              fullMap.set(mod, { view: true, create: true, edit: true, delete: true, approve: true, enabled: true });
            }
          } else {
            fullMap.set(mod, { view: false, create: false, edit: false, delete: false, approve: false, enabled: false });
          }
        }
        req.permissions = fullMap;
      } else if (req.user.accessRole && req.user.accessRole.permissions) {
        const rawPerms = req.user.accessRole.permissions;
        const roleMap = new Map();
        for (const mod of AccessRole.SYSTEM_MODULES) {
          const modPerm = rawPerms.get ? rawPerms.get(mod) : rawPerms[mod];
          const permObj = modPerm?.toObject ? modPerm.toObject() : (modPerm?._doc || modPerm || {});
          if (enabledSet.has(mod) && modPerm) {
            roleMap.set(mod, {
              view: Boolean(permObj.view),
              create: Boolean(permObj.create),
              edit: Boolean(permObj.edit),
              delete: Boolean(permObj.delete),
              approve: Boolean(permObj.approve),
              enabled: true,
            });
          } else {
            roleMap.set(mod, { view: false, create: false, edit: false, delete: false, approve: false, enabled: false });
          }
        }
        req.permissions = roleMap;
      } else {
        // Fail closed: no permissions granted if accessRole is missing or deleted
        req.permissions = new Map();
      }
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
  // 0. Security Guard for Share Sessions (Both VIEW_ONLY and CAN_EDIT):
  // Must execute BEFORE the owner check so an owner accessing another profile via share cannot bypass share restrictions
  if (req.isSharedAccess || req.isSharedViewOnly || req.profileAccessSource === 'share' || req.isShareToken) {
    // Special handling for 'settings': documents (invoices, quotes, POs) require company branding (logo, name, address, etc.)
    // Read-only access to 'settings' is always allowed for branding, but write operations are strictly forbidden.
    if (moduleName === 'settings') {
      if (action === 'view') {
        return next();
      }
      return res.status(403).json({
        message: 'Forbidden: Settings modifications are not permitted in shared mode.',
      });
    }

    if (req.isSharedViewOnly || req.shareAccessLevel === 'VIEW_ONLY') {
      if (action !== 'view') {
        return res.status(403).json({
          message: 'Forbidden: Write operations are not permitted in view-only share mode.',
        });
      }
    }

    const modPerm = req.permissions ? (req.permissions.get ? req.permissions.get(moduleName) : req.permissions[moduleName]) : null;

    if (!modPerm || !modPerm.view) {
      return res.status(403).json({
        message: `Forbidden: The '${moduleName}' module is not accessible in this share.`,
      });
    }

    if (action === 'view') {
      return next();
    }

    // CAN_EDIT mode: check action permission
    if (modPerm && modPerm[action] === true) {
      return next();
    }

    return res.status(403).json({
      message: `Forbidden: You do not have '${action}' permission for '${moduleName}' in this share.`,
    });
  }

  if (req.user?.role === 'superadmin') {
    return next();
  }

  // 1. Check company-level enabled modules
  if (req.ownerUser?.enabledModules && Array.isArray(req.ownerUser.enabledModules)) {
    if (!req.ownerUser.enabledModules.includes(moduleName)) {
      return res.status(403).json({
        message: `Forbidden: The '${moduleName}' module is disabled for your organization.`,
      });
    }
  }

  // 2. Company Owner Check with custom modulePermissions support
  if (req.user?.isOwner) {
    if (req.ownerUser?.modulePermissions) {
      const customPerms = req.ownerUser.modulePermissions;
      const custom = customPerms.get ? customPerms.get(moduleName) : customPerms[moduleName];
      const customObj = custom?.toObject ? custom.toObject() : (custom?._doc || custom || null);
      if (customObj && customObj[action] === false) {
        return res.status(403).json({
          message: `Forbidden: You do not have '${action}' permission for '${moduleName}'.`,
        });
      }
    }
    return next();
  }

  // 3. Team Member Permission Check
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
  if (req.isSharedAccess || req.isSharedViewOnly || req.profileAccessSource === 'share') {
    return res.status(403).json({ message: 'Forbidden: Admin operations are not accessible in shared mode.' });
  }
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
