const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const AccessRole = require('../models/AccessRole');
const MasterUser = require('./MasterUser');
const config = require('./config');
const { logSwitchAuditEvent } = require('./audit');

// Precomputed dummy bcrypt hash to ensure constant-time response for nonexistent users (VULN-05)
const DUMMY_BCRYPT_HASH = '$2a$10$wN9Psm6kR6qGk4eS7H6r3e5lFqX8zJv1i7s1p2q3r4s5t6u7v8w9x';

/**
 * Revoked Tokens Cache (VULN-07)
 * Blacklists exited impersonation JWTs until their natural expiration.
 */
const revokedTokens = new Map();

const isTokenRevoked = (token) => {
  if (!token) return false;
  const expiry = revokedTokens.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    revokedTokens.delete(token);
    return false;
  }
  return true;
};

const revokeToken = (token, ttlMs) => {
  if (!token) return;
  // BUG-03 FIX: Use the actual remaining TTL of the token when provided so the
  // revocation cache entry lives at least as long as the token itself.
  // Fall back to 4h default when ttlMs is absent or zero.
  const effectiveTtl = ttlMs && ttlMs > 0 ? ttlMs : 4 * 60 * 60 * 1000;
  revokedTokens.set(token, Date.now() + effectiveTtl);

  // Periodically clean up expired entries if cache grows
  if (revokedTokens.size > 1000) {
    const now = Date.now();
    for (const [k, exp] of revokedTokens.entries()) {
      if (now > exp) revokedTokens.delete(k);
    }
  }
};

/**
 * Dedicated Rate Limiter for Master Login to prevent brute-force attacks
 */
const masterLoginLimiter = rateLimit({
  windowMs: config.rateLimit?.windowMs || 15 * 60 * 1000,
  max: config.rateLimit?.max || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Too many authentication attempts for Master User. Please try again after 15 minutes.',
  },
});

/**
 * Rate Limiter for switching users (prevents rapid session generation) (VULN-04)
 */
const switchActionLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // max 30 switch requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Too many user switch requests. Please slow down.',
  },
});

/**
 * Rate Limiter for user listing / search queries (VULN-04)
 */
const userListLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // max 60 list requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Too many user lookup requests. Please slow down.',
  },
});

/**
 * Check if the given email belongs to a Master User
 */
const isMasterEmail = (email) => {
  if (!email || typeof email !== 'string') return false;
  const normalized = email.trim().toLowerCase();
  if (config.masterUser && config.masterUser.email.toLowerCase() === normalized) {
    return true;
  }
  if (Array.isArray(config.allowedMasterEmails)) {
    return config.allowedMasterEmails.map(e => e.toLowerCase()).includes(normalized);
  }
  return false;
};

/**
 * Check if the given username belongs to the Master User
 */
const isMasterUsername = (username) => {
  if (!username || typeof username !== 'string') return false;
  const clean = username.trim().toLowerCase();
  return (config.masterUser?.username?.toLowerCase() === clean);
};

/**
 * MASTER-ONLY: Only an isolated MasterUser account may switch sessions.
 * Regular superadmins, admins, and team members are always denied.
 * This is intentionally NOT configurable — security by design.
 */
const canUserSwitch = (user, decodedToken = null) => {
  if (!user || user.isActive === false || user.status === 'suspended') return false;

  // Allow if the active user record is a MasterUser
  if (user.isMasterUser === true || isMasterEmail(user.email)) return true;

  // Allow if currently in a switched session whose initiator was the MasterUser
  if (decodedToken?.isSwitchedSession && decodedToken?.switchedBy) {
    if (isMasterEmail(decodedToken.switchedBy.email)) return true;
  }

  // Explicitly deny everyone else — no config flag can override this
  return false;
};

/**
 * Helper to collect candidate JWT tokens from request headers and cookies (VULN-01)
 */
const getCandidateTokens = (req) => {
  const candidates = [];
  if (req.headers?.authorization && req.headers.authorization.startsWith('Bearer ')) {
    candidates.push(req.headers.authorization.split(' ')[1]);
  }
  if (req.cookies && req.cookies.token) {
    candidates.push(req.cookies.token);
  }
  return candidates;
};

/**
 * Helper to extract and verify the first valid, unrevoked JWT token (VULN-01 & VULN-07)
 */
const extractValidToken = (req) => {
  if (!process.env.JWT_SECRET) return null;
  const candidates = getCandidateTokens(req);
  for (const token of candidates) {
    if (isTokenRevoked(token)) continue;
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      return { token, decoded };
    } catch {
      // Continue to next candidate
    }
  }
  return null;
};

/**
 * Backward-compatible helper to extract JWT token string
 */
const extractToken = (req) => {
  return extractValidToken(req)?.token || null;
};

/**
 * Build full module permissions map
 */
const buildFullPermissionsMap = () => {
  const fullMap = new Map();
  for (const mod of AccessRole.SYSTEM_MODULES) {
    fullMap.set(mod, { view: true, create: true, edit: true, delete: true, approve: true, enabled: true });
  }
  return fullMap;
};

/**
 * Cookie options — HTTPS-only by design.
 * Tokens are set as HttpOnly + Secure cookies so they are never accessible
 * from JavaScript and only sent over encrypted connections.
 *
 * Local development override: set COOKIE_ALLOW_HTTP=true in .env
 */
const getCookieOptions = (req) => {
  const isProd = process.env.NODE_ENV === 'production';
  const isHttps = req?.secure || req?.headers?.['x-forwarded-proto'] === 'https';
  const allowHttp = !isProd && process.env.COOKIE_ALLOW_HTTP === 'true';
  const secure = isProd ? true : (isHttps || !allowHttp);
  const envSameSite = process.env.COOKIE_SAME_SITE?.toLowerCase();
  const sameSite = envSameSite || (secure ? (isProd ? 'none' : 'lax') : 'lax');

  return {
    httpOnly: true, // Never accessible via client-side JavaScript
    secure,         // HTTPS only
    sameSite,
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
};

/**
 * Intercepts /api/auth/login requests if credentials belong to MasterUser.
 * Mitigates timing oracle and enumeration (VULN-05).
 */
const masterLoginInterceptor = async (req, res, next) => {
  if (req.method !== 'POST') return next();
  const path = req.path || req.originalUrl || '';
  if (!path.endsWith('/login') && !path.includes('/auth/login')) return next();

  const { username, password } = req.body || {};
  if (!username || !password) return next();

  const cleanInput = String(username).trim();
  const isTargetMaster = isMasterUsername(cleanInput) || isMasterEmail(cleanInput);

  if (!isTargetMaster) {
    return next(); // Regular users & admins go to standard authController
  }

  // Apply dedicated rate limiting
  return masterLoginLimiter(req, res, async () => {
    try {
      const master = await MasterUser.findOne({
        $or: [
          { username: cleanInput },
          { email: cleanInput.toLowerCase() },
        ],
      });

      if (!master) {
        // VULN-05: Equalize execution time with dummy hash comparison
        await bcrypt.compare(String(password), DUMMY_BCRYPT_HASH).catch(() => {});
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      const isMatch = await master.matchPassword(password);
      if (!isMatch) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      // Check isActive only after verifying credentials to avoid account probing
      if (master.isActive === false) {
        return res.status(401).json({ message: 'Master user account has been deactivated' });
      }

      const token = jwt.sign(
        {
          id: master._id,
          role: 'superadmin',
          isMasterUser: true,
          subscription: { plan: 'pro', status: 'active' },
        },
        process.env.JWT_SECRET,
        { expiresIn: config.tokenExpiry || '7d' }
      );

      res.cookie('token', token, getCookieOptions(req));

      // Record audit event
      logSwitchAuditEvent({
        action: 'MASTER_LOGIN',
        req,
        masterUser: master,
        details: { via: 'auth-login-interceptor' },
      });

      const permissionsObj = {};
      for (const mod of AccessRole.SYSTEM_MODULES) {
        permissionsObj[mod] = { view: true, create: true, edit: true, delete: true, approve: true, enabled: true };
      }

      return res.json({
        user: {
          _id: master._id,
          username: master.username,
          email: master.email,
          phone: master.phone || '',
          avatar: master.avatar || '',
          role: 'superadmin',
          subscription: { plan: 'pro', status: 'active' },
          isOwner: true,
          companyId: master._id,
          status: 'active',
          permissions: permissionsObj,
          enabledModules: AccessRole.SYSTEM_MODULES,
          isMasterUser: true,
          canSwitchUser: true,
        },
        token,
      });
    } catch (err) {
      console.error('[USER-SWITCHER] Master login interceptor error:', err);
      return next();
    }
  });
};

/**
 * Global elevation & audit middleware:
 * Ensures requests bearing MasterUser tokens are recognized (with strict isActive verification),
 * while requests with switched-session tokens attach impersonation metadata and audit modifying actions.
 * Fixes VULN-01 (audit bypass) and VULN-02 (initiator revocation gap).
 */
const elevateMasterUser = async (req, res, next) => {
  try {
    const verified = extractValidToken(req);
    if (verified) {
      const { decoded } = verified;
      req.tokenPayload = decoded;

      // Switched impersonation session
      if (decoded.isSwitchedSession && decoded.switchedBy?.id) {
        // VULN-02: Enforce initiator active check
        let initiator = await MasterUser.findById(decoded.switchedBy.id).select('isActive status');
        if (!initiator) {
          initiator = await User.findById(decoded.switchedBy.id).select('isActive status');
        }

        if (!initiator || initiator.isActive === false || initiator.status === 'suspended') {
          return res.status(401).json({
            message: 'Impersonation session terminated: The initiating administrator account is no longer active',
          });
        }

        req.isSwitchedSession = true;
        req.switchedBy = decoded.switchedBy;

        // Non-repudiation audit: Log any mutating actions executed while impersonating
        const reqPath = req.originalUrl || req.path || '';
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !reqPath.includes('/api/user-switch/')) {
          res.on('finish', () => {
            if (res.statusCode >= 200 && res.statusCode < 400) {
              logSwitchAuditEvent({
                action: 'IMPERSONATED_ACTION',
                req,
                masterUser: decoded.switchedBy,
                targetUser: { id: decoded.id },
                details: {
                  statusCode: res.statusCode,
                  method: req.method,
                  path: reqPath,
                },
              });
            }
          });
        }
      }

      // If not already populated, check if the token belongs to isolated MasterUser
      if (!req.user && decoded.id && !decoded.isSwitchedSession) {
        const master = await MasterUser.findById(decoded.id).select('-password');
        if (master) {
          if (master.isActive === false) {
            return res.status(401).json({ message: 'Master user account has been deactivated' });
          }

          master.role = 'superadmin';
          master.isMasterUser = true;
          master.canSwitchUser = true;

          req.user = master;
          req.ownerUser = master;
          req.companyId = master._id;
          req.permissions = buildFullPermissionsMap();
        }
      }
    }

    // If req.user is loaded and is MasterUser, ensure full permissions map is set
    if (req.user && (req.user.isMasterUser || isMasterEmail(req.user.email))) {
      if (req.user.isActive === false) {
        return res.status(401).json({ message: 'Master user account has been deactivated' });
      }

      req.user.role = 'superadmin';
      req.user.isMasterUser = true;
      req.user.canSwitchUser = true;
      req.user.isOwner = true;
      if (!req.user.subscription || req.user.subscription.plan !== 'pro') {
        req.user.subscription = { plan: 'pro', status: 'active' };
      }
      if (!req.permissions || !(req.permissions instanceof Map) || req.permissions.size === 0) {
        req.permissions = buildFullPermissionsMap();
      }
      req.ownerUser = req.user;
      req.companyId = req.user._id;
    }
  } catch (err) {
    console.error('[USER-SWITCHER] Elevation middleware error:', err.message);
  }

  next();
};

/**
 * Route guard requiring master user or admin authorization to access user switch endpoints
 */
const requireSwitchAccess = async (req, res, next) => {
  const verified = extractValidToken(req);
  if (!verified) {
    return res.status(401).json({ message: 'Authentication required to access user switch features' });
  }

  const { decoded } = verified;
  req.tokenPayload = decoded;

  try {
    let user = req.user;
    if (!user) {
      user = await MasterUser.findById(decoded.id).select('-password');
      if (!user) {
        user = await User.findById(decoded.id).select('-password');
      }
      req.user = user;
    }

    if (!user) {
      return res.status(401).json({ message: 'User account not found' });
    }

    if (user.isActive === false || user.status === 'suspended') {
      return res.status(401).json({ message: 'Account is deactivated or suspended' });
    }

    // VULN-02: Ensure initiator is active if already in a switched session
    if (decoded.isSwitchedSession && decoded.switchedBy?.id) {
      let initiator = await MasterUser.findById(decoded.switchedBy.id).select('isActive status');
      if (!initiator) initiator = await User.findById(decoded.switchedBy.id).select('isActive status');
      if (!initiator || initiator.isActive === false || initiator.status === 'suspended') {
        return res.status(401).json({ message: 'The initiating administrator account is no longer active' });
      }
    }

    if (!canUserSwitch(user, decoded)) {
      return res.status(403).json({
        message: 'Forbidden: You do not have permissions to switch users',
      });
    }

    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired authentication token' });
  }
};

/**
 * Route guard strictly requiring an active switched session token to exit.
 * Checks request body (switchToken), authorization header, and cookies to ensure
 * resilience even if headers or cookies were temporarily out of sync.
 */
const requireSwitchedSession = async (req, res, next) => {
  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ message: 'JWT_SECRET is missing' });
  }

  const candidates = [];
  if (req.body?.switchToken && typeof req.body.switchToken === 'string') {
    candidates.push(req.body.switchToken.trim());
  }
  if (req.body?.token && typeof req.body.token === 'string') {
    candidates.push(req.body.token.trim());
  }
  if (req.headers?.authorization && req.headers.authorization.startsWith('Bearer ')) {
    candidates.push(req.headers.authorization.split(' ')[1]);
  }
  if (req.cookies && req.cookies.token) {
    candidates.push(req.cookies.token);
  }

  let switchedCandidate = null;
  let masterCandidate = null;
  let anyValidCandidate = null;

  for (const token of candidates) {
    if (isTokenRevoked(token)) continue;
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (!anyValidCandidate) anyValidCandidate = { token, decoded };
      if (decoded.isSwitchedSession && decoded.switchedBy?.id) {
        switchedCandidate = { token, decoded };
        break;
      }
      if (decoded.isMasterUser) {
        masterCandidate = { token, decoded };
      }
    } catch {
      // Continue searching next candidate
    }
  }

  if (switchedCandidate) {
    req.token = switchedCandidate.token;
    req.tokenPayload = switchedCandidate.decoded;
    req.switchedBy = switchedCandidate.decoded.switchedBy;
    return next();
  }

  if (masterCandidate) {
    req.token = masterCandidate.token;
    req.tokenPayload = masterCandidate.decoded;
    req.isAlreadyMaster = true;
    return next();
  }

  if (!anyValidCandidate) {
    return res.status(401).json({ message: 'Authentication token required to exit switched session' });
  }

  return res.status(400).json({ message: 'Current session is not an active impersonation session' });
};

module.exports = {
  isMasterEmail,
  isMasterUsername,
  canUserSwitch,
  extractToken,
  extractValidToken,
  revokeToken,
  isTokenRevoked,
  elevateMasterUser,
  masterLoginInterceptor,
  masterLoginLimiter,
  switchActionLimiter,
  userListLimiter,
  requireSwitchAccess,
  requireSwitchedSession,
  buildFullPermissionsMap,
  getCookieOptions,
};
