const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const AccessRole = require('../models/AccessRole');
const MasterUser = require('./MasterUser');
const config = require('./config');
const { logSwitchAuditEvent } = require('./audit');
const {
  isMasterEmail,
  canUserSwitch,
  extractToken,
  extractValidToken,
  revokeToken,
  getCookieOptions,
} = require('./middleware');

// Constant-time comparison dummy hash (VULN-05)
const DUMMY_BCRYPT_HASH = '$2a$10$wN9Psm6kR6qGk4eS7H6r3e5lFqX8zJv1i7s1p2q3r4s5t6u7v8w9x';

// Format MasterUser data into standard application auth payload
const formatMasterUserResponse = (master) => {
  const permissionsObj = {};
  for (const mod of AccessRole.SYSTEM_MODULES) {
    permissionsObj[mod] = { view: true, create: true, edit: true, delete: true, approve: true, enabled: true };
  }

  return {
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
  };
};

// Format target user data into standard application auth payload
const formatUserResponse = (user) => {
  let permissionsObj = {};
  if (user.role === 'superadmin') {
    for (const mod of AccessRole.SYSTEM_MODULES) {
      permissionsObj[mod] = { view: true, create: true, edit: true, delete: true, approve: true, enabled: true };
    }
  }

  return {
    _id: user._id,
    username: user.username,
    email: user.email,
    phone: user.phone || '',
    avatar: user.avatar || '',
    role: user.role,
    subscription: user.subscription || { plan: 'free', status: 'active' },
    isOwner: user.isOwner !== false,
    companyId: user.isOwner ? user._id : user.companyId,
    accessRole: user.accessRole,
    status: user.status || 'active',
    permissions: permissionsObj,
    enabledModules: AccessRole.SYSTEM_MODULES,
    isMasterUser: false,
    canSwitchUser: false, // Target user session cannot switch
  };
};

/**
 * @desc    Authenticate directly as Master User (strictly guarded by rate limiter)
 *          Mitigates timing oracle and user enumeration (VULN-05)
 * @route   POST /api/user-switch/login
 * @access  Public
 */
exports.login = async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
    }

    const cleanInput = String(username).trim();
    const master = await MasterUser.findOne({
      $or: [
        { username: cleanInput },
        { email: cleanInput.toLowerCase() },
      ],
    });

    if (!master) {
      // VULN-05: Equalize execution time with dummy hash comparison
      await bcrypt.compare(String(password), DUMMY_BCRYPT_HASH).catch(() => {});
      return res.status(401).json({ message: 'Invalid master credentials' });
    }

    const isMatch = await master.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid master credentials' });
    }

    // Check isActive only after verifying credentials to prevent enumeration
    if (master.isActive === false) {
      return res.status(401).json({ message: 'Master user account is deactivated' });
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

    // Audit logging
    logSwitchAuditEvent({
      action: 'MASTER_LOGIN',
      req,
      masterUser: master,
      details: { via: 'direct-login' },
    });

    return res.json({
      success: true,
      message: 'Master authentication successful',
      token,
      user: formatMasterUserResponse(master),
    });
  } catch (error) {
    console.error('[USER-SWITCHER] Master login error:', error);
    return res.status(500).json({ message: 'Master authentication failed' });
  }
};

/**
 * @desc    Get list of all users available for switching (from standard User model)
 *          Clamped pagination & input bounding to prevent DoS
 * @route   GET /api/user-switch/users
 * @access  Private (Master User or Superadmin)
 */
exports.listUsers = async (req, res) => {
  try {
    const { search = '', role = '', page = 1, limit = 50 } = req.query;

    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
    const safePage = Math.max(1, parseInt(page, 10) || 1);

    const query = {};

    // Exclude master emails from target switch list
    const excludedEmails = [
      (config.masterUser?.email || '').toLowerCase(),
      ...(config.allowedMasterEmails || []).map(e => e.toLowerCase()),
    ].filter(Boolean);

    if (excludedEmails.length > 0) {
      query.email = { $nin: excludedEmails };
    }

    // BUG-01 FIX: Build role constraint as $and array so additional filters
    // cannot accidentally overwrite the superadmin exclusion guard.
    const roleConditions = [{ role: { $ne: 'superadmin' } }];

    const cleanRole = typeof role === 'string' ? role.trim() : '';
    if (cleanRole && cleanRole !== 'superadmin' && cleanRole !== 'ALL') {
      // Merge caller-supplied role filter alongside the superadmin exclusion
      roleConditions.push({ role: cleanRole });
    }

    // Sanitize and truncate search string to 100 chars
    const cleanSearch = String(search || '').trim().slice(0, 100);
    const andConditions = [...roleConditions];

    if (cleanSearch) {
      const escaped = cleanSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      andConditions.push({
        $or: [
          { username: { $regex: escaped, $options: 'i' } },
          { email: { $regex: escaped, $options: 'i' } },
          { phone: { $regex: escaped, $options: 'i' } },
        ],
      });
    }

    query.$and = andConditions;

    const totalCount = await User.countDocuments(query);
    const users = await User.find(query)
      .select('_id username email role phone avatar isActive status subscription isOwner companyId createdAt')
      .sort({ createdAt: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean();

    const formattedUsers = users.map(u => ({
      ...u,
      isMasterUser: false,
    }));

    return res.json({
      success: true,
      users: formattedUsers,
      totalCount,
      currentPage: safePage,
      totalPages: Math.ceil(totalCount / safeLimit),
    });
  } catch (error) {
    console.error('[USER-SWITCHER] listUsers error:', error);
    return res.status(500).json({ message: 'Failed to fetch user list' });
  }
};

/**
 * @desc    Switch active session to target user (Impersonation)
 *          Enforces initiator active status (VULN-02) and revokes previous token (VULN-07)
 * @route   POST /api/user-switch/switch
 * @access  Private (Master User or Superadmin)
 */
exports.switchUser = async (req, res) => {
  try {
    const { targetUserId, email, username } = req.body || {};

    let targetUser = null;
    if (targetUserId && typeof targetUserId === 'string' && mongoose.Types.ObjectId.isValid(targetUserId)) {
      targetUser = await User.findById(targetUserId);
    } else if (email && typeof email === 'string') {
      targetUser = await User.findOne({ email: email.trim().toLowerCase() });
    } else if (username && typeof username === 'string') {
      targetUser = await User.findOne({ username: username.trim() });
    }

    if (!targetUser) {
      return res.status(404).json({ message: 'Target user not found' });
    }

    // Determine identity of the administrator performing the switch
    let masterUser = req.user;
    if (req.tokenPayload && req.tokenPayload.isSwitchedSession && req.tokenPayload.switchedBy) {
      const initiatorId = req.tokenPayload.switchedBy.id;
      // VULN-02: Enforce initiator active check in database
      let initiator = await MasterUser.findById(initiatorId);
      if (!initiator) initiator = await User.findById(initiatorId);

      if (!initiator || initiator.isActive === false || initiator.status === 'suspended') {
        return res.status(401).json({ message: 'The administrator account who initiated switch is deactivated' });
      }
      masterUser = initiator;
    }

    // DEFENSE-IN-DEPTH: Double-verify the initiator is strictly a MasterUser.
    // requireSwitchAccess already enforces this, but we check again here so that
    // the controller can never be exploited even if the route guard is bypassed.
    const isTrueMaster = Boolean(
      masterUser?.isMasterUser === true || isMasterEmail(masterUser?.email)
    );
    if (!isTrueMaster) {
      return res.status(403).json({ message: 'User impersonation is restricted to the Master User account only' });
    }

    const masterIdStr = (masterUser._id || masterUser.id)?.toString();

    // Guard 1: Prevent self-impersonation
    if (targetUser._id.toString() === masterIdStr) {
      return res.status(400).json({ message: 'Cannot impersonate your own account' });
    }

    // Guard 2: Prevent impersonating other Superadmins or Master User accounts
    if (targetUser.role === 'superadmin' || isMasterEmail(targetUser.email)) {
      return res.status(403).json({ message: 'Impersonation of administrative accounts is not permitted' });
    }

    // Guard 3: Prevent impersonating deactivated or suspended accounts
    if (targetUser.isActive === false || targetUser.status === 'suspended') {
      return res.status(400).json({ message: 'Cannot impersonate a deactivated or suspended account' });
    }

    const switchedByPayload = {
      id: masterIdStr,
      username: masterUser.username,
      email: masterUser.email,
      role: masterUser.role || 'superadmin',
    };

    // VULN-07: Invalidate the previous token — use actual token TTL so the
    // revocation cache entry does not expire before the token itself (BUG-03).
    const previousToken = extractToken(req);
    if (previousToken) {
      try {
        const decoded = require('jsonwebtoken').decode(previousToken);
        const ttlMs = decoded?.exp ? Math.max(0, decoded.exp * 1000 - Date.now()) : undefined;
        revokeToken(previousToken, ttlMs);
      } catch {
        revokeToken(previousToken);
      }
    }

    // Generate JWT with short TTL (4 hours)
    const switchToken = jwt.sign(
      {
        id: targetUser._id,
        role: targetUser.role,
        subscription: targetUser.subscription,
        isSwitchedSession: true,
        switchedBy: switchedByPayload,
      },
      process.env.JWT_SECRET,
      { expiresIn: config.switchedTokenExpiry || '4h' }
    );

    res.cookie('token', switchToken, getCookieOptions(req));

    const formattedTarget = formatUserResponse(targetUser);

    // Record audit event
    logSwitchAuditEvent({
      action: 'SWITCH_USER',
      req,
      masterUser: switchedByPayload,
      targetUser,
      details: {
        targetRole: targetUser.role,
        targetEmail: targetUser.email,
        sessionTTL: config.switchedTokenExpiry || '4h',
      },
    });

    console.log(`[USER-SWITCHER] Switched to user: ${targetUser.username} (${targetUser.email}) by ${switchedByPayload.username}`);

    return res.json({
      success: true,
      message: `Successfully switched to user ${targetUser.username}`,
      token: switchToken,
      user: formattedTarget,
      switchedBy: switchedByPayload,
    });
  } catch (error) {
    console.error('[USER-SWITCHER] switchUser error:', error);
    return res.status(500).json({ message: 'Failed to switch user' });
  }
};

/**
 * @desc    Exit switched session and restore Master User
 *          SECURED: Exclusively authenticated via verified switched JWT (requireSwitchedSession)
 *          Revokes active switched token (VULN-07)
 * @route   POST /api/user-switch/exit
 * @access  Private (Active Switched Session Only)
 */
exports.exitSwitch = async (req, res) => {
  try {
    if (req.isAlreadyMaster && req.tokenPayload?.id) {
      let master = await MasterUser.findById(req.tokenPayload.id);
      if (!master) master = await User.findById(req.tokenPayload.id);
      if (master && master.isActive !== false) {
        const isMaster = Boolean(master.isMasterUser || isMasterEmail(master.email));
        return res.json({
          success: true,
          message: 'Already operating as Master User',
          token: req.token,
          user: isMaster ? formatMasterUserResponse(master) : formatUserResponse(master),
        });
      }
    }

    const masterId = req.tokenPayload?.switchedBy?.id;

    if (!masterId) {
      return res.status(400).json({ message: 'Missing initiator metadata in switched session token' });
    }

    // Look up initiator in isolated MasterUser model first
    let masterUser = await MasterUser.findById(masterId);
    // Fallback: check User model (in case switch was initiated by an existing superadmin)
    if (!masterUser) {
      masterUser = await User.findById(masterId);
    }

    if (!masterUser || masterUser.isActive === false || masterUser.status === 'suspended') {
      return res.status(401).json({ message: 'Master user account not found or deactivated' });
    }

    // VULN-07: Invalidate the switched session token — honour actual token expiry (BUG-03)
    if (req.token) {
      try {
        const decoded = require('jsonwebtoken').decode(req.token);
        const ttlMs = decoded?.exp ? Math.max(0, decoded.exp * 1000 - Date.now()) : undefined;
        revokeToken(req.token, ttlMs);
      } catch {
        revokeToken(req.token);
      }
    }

    const isMaster = Boolean(masterUser.isMasterUser || isMasterEmail(masterUser.email));

    // Generate fresh token for Master User
    const masterToken = jwt.sign(
      {
        id: masterUser._id,
        role: isMaster ? 'superadmin' : masterUser.role,
        isMasterUser: isMaster,
        subscription: isMaster ? { plan: 'pro', status: 'active' } : masterUser.subscription,
      },
      process.env.JWT_SECRET,
      { expiresIn: config.tokenExpiry || '7d' }
    );

    res.cookie('token', masterToken, getCookieOptions(req));

    // Record audit event
    logSwitchAuditEvent({
      action: 'EXIT_SWITCH',
      req,
      masterUser,
      targetUser: { id: req.tokenPayload.id },
      details: {
        restoredRole: isMaster ? 'superadmin' : masterUser.role,
      },
    });

    console.log(`[USER-SWITCHER] Restored Master session: ${masterUser.username} (${masterUser.email})`);

    const formattedUser = isMaster ? formatMasterUserResponse(masterUser) : formatUserResponse(masterUser);

    return res.json({
      success: true,
      message: 'Exited switched session and restored Master User',
      token: masterToken,
      user: formattedUser,
    });
  } catch (error) {
    console.error('[USER-SWITCHER] exitSwitch error:', error);
    return res.status(500).json({ message: 'Failed to exit switched session' });
  }
};

/**
 * @desc    Get current switch / impersonation status
 *          Uses candidate verification and checks initiator validity
 * @route   GET /api/user-switch/status
 * @access  Public / Private
 */
exports.getStatus = async (req, res) => {
  try {
    const verified = extractValidToken(req);
    if (!verified) {
      return res.json({
        isSwitched: false,
        canSwitch: false,
        currentUser: null,
      });
    }

    const { decoded } = verified;
    const isSwitched = Boolean(decoded.isSwitchedSession && decoded.switchedBy);

    // VULN-02: If switched, verify initiator in DB
    if (isSwitched && decoded.switchedBy?.id) {
      let initiator = await MasterUser.findById(decoded.switchedBy.id).select('isActive status');
      if (!initiator) initiator = await User.findById(decoded.switchedBy.id).select('isActive status');
      if (!initiator || initiator.isActive === false || initiator.status === 'suspended') {
        return res.json({ isSwitched: false, canSwitch: false, currentUser: null });
      }
    }

    let activeUser = null;
    let isMaster = false;

    if (isSwitched) {
      activeUser = await User.findById(decoded.id).select('-password');
    } else {
      activeUser = await MasterUser.findById(decoded.id).select('-password');
      if (activeUser) {
        isMaster = true;
      } else {
        activeUser = await User.findById(decoded.id).select('-password');
      }
    }

    if (!activeUser || activeUser.isActive === false || activeUser.status === 'suspended') {
      return res.json({ isSwitched: false, canSwitch: false, currentUser: null });
    }

    const canSwitch = canUserSwitch(activeUser, decoded);
    const formattedUser = isMaster ? formatMasterUserResponse(activeUser) : formatUserResponse(activeUser);

    return res.json({
      isSwitched,
      switchedBy: isSwitched ? decoded.switchedBy : null,
      canSwitch,
      currentUser: formattedUser,
    });
  } catch (error) {
    console.error('[USER-SWITCHER] getStatus error:', error);
    return res.status(500).json({ message: 'Failed to get switch status' });
  }
};
