const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const AccessRole = require('../models/AccessRole');
const BusinessUnit = require('../models/BusinessUnit');
const Client = require('../models/Client');
const ClientProfile = require('../models/ClientProfile');
const AdminAuditLog = require('../models/AdminAuditLog');

const SCOPE_RANK = {
  own: 1,
  businessUnit: 2,
  client: 2,
  all: 3,
};

function isCompanyOwnerUser(req) {
  if (!req?.user) return false;
  if (req.user.isOwner === true) return true;
  if (req.user.role === 'superadmin' || req.user.role === 'owner') return true;
  if (req.companyId && req.user._id && String(req.companyId) === String(req.user._id)) return true;
  if (!req.user.companyId && !req.user.accessRole && req.user.isOwner !== false) return true;
  return false;
}

/**
 * Validates that an acting non-owner does not grant permissions or data scopes
 * broader than those granted by their own assigned role.
 */
function assertNoPrivilegeEscalation(req, targetPermissionsMap) {
  if (isCompanyOwnerUser(req)) return;

  if (!req.permissions) {
    const err = new Error('Forbidden: No permissions assigned to acting user');
    err.status = 403;
    throw err;
  }

  const actions = ['view', 'create', 'edit', 'delete', 'approve'];
  const entries = targetPermissionsMap instanceof Map
    ? targetPermissionsMap.entries()
    : Object.entries(targetPermissionsMap || {});

  for (const [mod, perm] of entries) {
    if (!perm) continue;
    const actingMod = req.permissions.get ? req.permissions.get(mod) : req.permissions[mod];

    for (const act of actions) {
      if (perm[act] === true) {
        if (!actingMod || actingMod[act] !== true) {
          const err = new Error(`Forbidden: You cannot grant '${act}' permission for module '${mod}' as your own role does not hold it.`);
          err.status = 403;
          throw err;
        }
      }
    }

    const hasAnyPerm = actions.some(act => perm[act] === true);
    if (hasAnyPerm) {
      const targetScope = perm.dataScope || 'all';
      const actingScope = actingMod?.dataScope || 'own';

      if (SCOPE_RANK[targetScope] > SCOPE_RANK[actingScope]) {
        const err = new Error(`Forbidden: You cannot grant '${targetScope}' data scope for module '${mod}' exceeding your assigned scope '${actingScope}'.`);
        err.status = 403;
        throw err;
      }
      if (actingScope === 'businessUnit' && targetScope === 'client') {
        const err = new Error(`Forbidden: You cannot grant 'client' data scope for module '${mod}' when your assigned scope is 'businessUnit'.`);
        err.status = 403;
        throw err;
      }
      if (actingScope === 'client' && targetScope === 'businessUnit') {
        const err = new Error(`Forbidden: You cannot grant 'businessUnit' data scope for module '${mod}' when your assigned scope is 'client'.`);
        err.status = 403;
        throw err;
      }
    }
  }
}

/**
 * Validates that assignedBusinessUnits and assignedClients contain valid ObjectIds
 * that belong to the active company.
 */
async function validateAssignedEntities(companyId, assignedBusinessUnits, assignedClients) {
  if (assignedBusinessUnits !== undefined) {
    if (!Array.isArray(assignedBusinessUnits)) {
      const err = new Error('assignedBusinessUnits must be an array of IDs');
      err.status = 400;
      throw err;
    }
    for (const id of assignedBusinessUnits) {
      if (!mongoose.isValidObjectId(id)) {
        const err = new Error(`Invalid Business Unit ID: ${id}`);
        err.status = 400;
        throw err;
      }
    }
    if (assignedBusinessUnits.length > 0) {
      const validBUs = await BusinessUnit.find({
        _id: { $in: assignedBusinessUnits },
        user: companyId,
        isDeleted: false,
      });
      if (validBUs.length !== assignedBusinessUnits.length) {
        const err = new Error('One or more assigned business units do not exist or do not belong to your company');
        err.status = 400;
        throw err;
      }
    }
  }

  if (assignedClients !== undefined) {
    if (!Array.isArray(assignedClients)) {
      const err = new Error('assignedClients must be an array of IDs');
      err.status = 400;
      throw err;
    }
    for (const id of assignedClients) {
      if (!mongoose.isValidObjectId(id)) {
        const err = new Error(`Invalid Client ID: ${id}`);
        err.status = 400;
        throw err;
      }
    }
    if (assignedClients.length > 0) {
      const validClients = await Client.find({
        _id: { $in: assignedClients },
        user: companyId,
        isDeleted: false,
      });
      if (validClients.length !== assignedClients.length) {
        const err = new Error('One or more assigned clients do not exist or do not belong to your company');
        err.status = 400;
        throw err;
      }
    }
  }
}

/**
 * Validates profileAccess entries: valid ObjectIds, company ownership,
 * and privilege escalation check for non-owners.
 */
async function validateProfileAccess(reqOrCompanyId, profileAccess) {
  if (!profileAccess) return undefined;
  if (!Array.isArray(profileAccess)) {
    const err = new Error('profileAccess must be an array');
    err.status = 400;
    throw err;
  }

  const companyId = reqOrCompanyId?.companyId || reqOrCompanyId;
  const req = typeof reqOrCompanyId === 'object' && reqOrCompanyId.companyId ? reqOrCompanyId : { companyId, user: { isOwner: true } };

  const sanitized = [];
  for (const entry of profileAccess) {
    const profId = entry.profile?._id || entry.profile;
    const roleId = entry.accessRole?._id || entry.accessRole;

    if (!mongoose.isValidObjectId(profId) || !mongoose.isValidObjectId(roleId)) {
      const err = new Error('Each profileAccess entry must contain a valid profile ID and accessRole ID');
      err.status = 400;
      throw err;
    }

    const profileDoc = await ClientProfile.findOne({
      _id: profId,
      owner: companyId,
      status: { $ne: 'deleted' },
    });
    if (!profileDoc) {
      const err = new Error('Selected profile does not belong to your company or does not exist');
      err.status = 400;
      throw err;
    }

    const roleDoc = await AccessRole.findOne({
      _id: roleId,
      companyId: companyId,
    });
    if (!roleDoc) {
      const err = new Error('Selected access role does not belong to your company or does not exist');
      err.status = 400;
      throw err;
    }

    // Role escalation check
    assertNoPrivilegeEscalation(req, roleDoc.permissions);

    sanitized.push({
      profile: profileDoc._id,
      accessRole: roleDoc._id,
    });
  }

  return sanitized;
}

// @desc    Invite a new team member to company
// @route   POST /api/team-members/invite
// @access  Private (authorize: teamMembers.create)
const inviteTeamMember = async (req, res) => {
  try {
    const { email, username, accessRoleId, assignedBusinessUnits, assignedClients, profileAccess } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email address is required' });
    }

    const emailLower = email.toLowerCase().trim();
    const desiredUsername = (username || emailLower.split('@')[0]).trim();

    // Check existing email or username
    const existingUser = await User.findOne({
      $or: [{ email: emailLower }, { username: desiredUsername }]
    });

    if (existingUser) {
      if (existingUser.email === emailLower) {
        return res.status(400).json({ message: 'A user with this email address already exists' });
      }
      return res.status(400).json({ message: 'Username already taken' });
    }

    // Validate assigned Business Units & Clients
    await validateAssignedEntities(req.companyId, assignedBusinessUnits, assignedClients);

    // Validate profileAccess if provided
    const validatedProfileAccess = await validateProfileAccess(req, profileAccess);

    // Verify AccessRole belongs to current company
    let roleId = accessRoleId;
    if (!roleId && (!validatedProfileAccess || validatedProfileAccess.length === 0)) {
      const defaultViewer = await AccessRole.findOne({ companyId: req.companyId, profile: req.activeProfileId || null, name: 'Viewer' })
        || await AccessRole.findOne({ companyId: req.companyId, name: 'Viewer' });
      if (defaultViewer) roleId = defaultViewer._id;
    } else if (roleId) {
      const validRole = await AccessRole.findOne({ _id: roleId, companyId: req.companyId });
      if (!validRole) {
        return res.status(400).json({ message: 'Invalid AccessRole selected for your company' });
      }
      assertNoPrivilegeEscalation(req, validRole.permissions);
    } else if (validatedProfileAccess && validatedProfileAccess.length > 0) {
      // If profileAccess is provided without global role, default to first profile's role
      roleId = validatedProfileAccess[0].accessRole;
    }

    // Free plan seat check: limit team members on free plan
    const ownerPlan = req.ownerUser?.subscription?.plan || 'free';
    if (ownerPlan === 'free') {
      const currentTeamCount = await User.countDocuments({ companyId: req.companyId, isOwner: false, isDeleted: { $ne: true } });
      if (currentTeamCount >= 2) {
        return res.status(403).json({
          message: 'Free plan is limited to 2 team members. Upgrade to Pro for unlimited team members.'
        });
      }
    }

    // Generate secure invite token
    const token = crypto.randomBytes(32).toString('hex');
    const tokenExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const dummyPassword = crypto.randomBytes(16).toString('hex');

    const newUser = await User.create({
      username: desiredUsername,
      email: emailLower,
      password: dummyPassword,
      companyId: req.companyId,
      isOwner: false,
      accessRole: roleId,
      profileAccess: validatedProfileAccess || [],
      assignedBusinessUnits: Array.isArray(assignedBusinessUnits) ? assignedBusinessUnits : [],
      assignedClients: Array.isArray(assignedClients) ? assignedClients : [],
      invitedBy: req.user._id,
      status: 'invited',
      inviteToken: token,
      inviteTokenExpires: tokenExpires,
      isActive: true,
      isDeleted: false,
    });

    const populatedUser = await User.findById(newUser._id)
      .select('-password -inviteToken -inviteTokenExpires')
      .populate('accessRole')
      .populate('profileAccess.profile', 'name code color clientTag isDefault')
      .populate('profileAccess.accessRole', 'name description')
      .populate('assignedBusinessUnits', 'name code')
      .populate('assignedClients', 'name clientTag');

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const inviteLink = `${clientUrl}/accept-invite?token=${token}`;

    res.status(201).json({
      message: 'Team member invited successfully',
      teamMember: populatedUser,
      inviteLink,
      inviteToken: token,
    });
  } catch (error) {
    console.error('Invite Team Member Error:', error);
    res.status(error.status || 500).json({ message: error.message || 'Failed to invite team member' });
  }
};

// @desc    Accept invitation & set password
// @route   POST /api/team-members/accept-invite
// @access  Public
const acceptInvite = async (req, res) => {
  try {
    const { token, password, username } = req.body;

    if (!token || !password) {
      return res.status(400).json({ message: 'Token and password are required' });
    }

    const user = await User.findOne({
      inviteToken: token,
      inviteTokenExpires: { $gt: Date.now() }
    }).select('+inviteToken +inviteTokenExpires');

    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired invitation token' });
    }

    if (username && username.trim() !== user.username) {
      const taken = await User.findOne({ username: username.trim(), _id: { $ne: user._id } });
      if (taken) return res.status(400).json({ message: 'Username is already taken' });
      user.username = username.trim();
    }

    user.password = password;
    user.status = 'active';
    user.inviteToken = null;
    user.inviteTokenExpires = null;
    user.isActive = true;
    user.tokenVersion = (user.tokenVersion || 0) + 1;

    await user.save();

    res.json({ message: 'Account activated successfully. You can now log in.' });
  } catch (error) {
    console.error('Accept Invite Error:', error);
    res.status(500).json({ message: 'Failed to accept invitation: ' + error.message });
  }
};

// @desc    Get all team members for company
// @route   GET /api/team-members
// @access  Private (authorize: teamMembers.view)
const getTeamMembers = async (req, res) => {
  try {
    const filter = { companyId: req.companyId, isOwner: false };
    if (req.query.includeDeleted !== 'true') {
      filter.isDeleted = { $ne: true };
    }

    const members = await User.find(filter)
      .select('-password -inviteToken -inviteTokenExpires')
      .populate('accessRole')
      .populate('profileAccess.profile', 'name code color clientTag isDefault')
      .populate('profileAccess.accessRole', 'name description')
      .populate('assignedBusinessUnits', 'name code')
      .populate('assignedClients', 'name clientTag')
      .sort({ createdAt: -1 });

    // Include owner details in summary response
    let owner = await User.findById(req.companyId).select('-password -inviteToken -inviteTokenExpires');
    if (!owner && req.user) {
      owner = req.user;
    }

    res.json({
      owner: owner ? {
        _id: owner._id,
        username: owner.username,
        email: owner.email,
        isOwner: true,
        roleName: owner.role === 'superadmin' ? 'Master Administrator' : 'Company Owner',
      } : {
        _id: req.companyId,
        username: 'Owner',
        email: '',
        isOwner: true,
        roleName: 'Company Owner',
      },
      teamMembers: members || [],
    });
  } catch (error) {
    console.error('Get Team Members Error:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update team member status or accessRole
// @route   PATCH /api/team-members/:id
// @access  Private (authorize: teamMembers.edit)
const updateTeamMember = async (req, res) => {
  try {
    const { id } = req.params;
    const { accessRoleId, status, phone, assignedBusinessUnits, assignedClients, profileAccess } = req.body;

    const targetUser = await User.findOne({ _id: id, companyId: req.companyId });
    if (!targetUser) {
      return res.status(404).json({ message: 'Team member not found' });
    }

    if (targetUser.isOwner) {
      return res.status(400).json({ message: 'Cannot modify permissions or status of company owner' });
    }

    // Role escalation: non-owners cannot change their own role or profileAccess
    if (String(targetUser._id) === String(req.user._id)) {
      if (accessRoleId && String(accessRoleId) !== String(targetUser.accessRole)) {
        return res.status(403).json({ message: 'You cannot change your own access role' });
      }
      if (profileAccess !== undefined) {
        return res.status(403).json({ message: 'You cannot change your own profile access' });
      }
    }

    // Validate assigned Business Units & Clients
    await validateAssignedEntities(req.companyId, assignedBusinessUnits, assignedClients);

    let invalidateSession = false;

    if (accessRoleId && String(accessRoleId) !== String(targetUser.accessRole)) {
      const validRole = await AccessRole.findOne({ _id: accessRoleId, companyId: req.companyId });
      if (!validRole) {
        return res.status(400).json({ message: 'Invalid AccessRole selected' });
      }
      assertNoPrivilegeEscalation(req, validRole.permissions);
      targetUser.accessRole = accessRoleId;
      invalidateSession = true;
    }

    if (profileAccess !== undefined) {
      const validatedPA = await validateProfileAccess(req, profileAccess);
      targetUser.profileAccess = validatedPA;
      invalidateSession = true;
    }

    if (status && ['active', 'suspended'].includes(status) && status !== targetUser.status) {
      targetUser.status = status;
      targetUser.isActive = status === 'active';
      invalidateSession = true;
    }

    if (phone !== undefined) {
      targetUser.phone = phone;
    }

    if (Array.isArray(assignedBusinessUnits)) {
      targetUser.assignedBusinessUnits = assignedBusinessUnits;
    }

    if (Array.isArray(assignedClients)) {
      targetUser.assignedClients = assignedClients;
    }

    if (invalidateSession) {
      targetUser.tokenVersion = (targetUser.tokenVersion || 0) + 1;
    }

    await targetUser.save();

    const updated = await User.findById(id)
      .select('-password -inviteToken -inviteTokenExpires')
      .populate('accessRole')
      .populate('profileAccess.profile', 'name code color clientTag isDefault')
      .populate('profileAccess.accessRole', 'name description')
      .populate('assignedBusinessUnits', 'name code')
      .populate('assignedClients', 'name clientTag');
    res.json(updated);
  } catch (error) {
    console.error('Update Team Member Error:', error);
    res.status(error.status || 500).json({ message: error.message });
  }
};

// @desc    Deactivate / soft-delete team member
// @route   DELETE /api/team-members/:id
// @access  Private (authorize: teamMembers.delete)
const deleteTeamMember = async (req, res) => {
  try {
    const { id } = req.params;

    const targetUser = await User.findOne({ _id: id, companyId: req.companyId });
    if (!targetUser) {
      return res.status(404).json({ message: 'Team member not found' });
    }

    if (targetUser.isOwner) {
      return res.status(400).json({ message: 'Cannot remove company owner' });
    }

    // Soft delete & deactivation
    targetUser.status = 'suspended';
    targetUser.isActive = false;
    targetUser.isDeleted = true;
    targetUser.deletedAt = new Date();
    targetUser.tokenVersion = (targetUser.tokenVersion || 0) + 1;
    await targetUser.save();

    // Audit log entry
    try {
      await AdminAuditLog.create({
        actorId: req.user._id,
        actorUsername: req.user.username || '',
        actorEmail: req.user.email || '',
        action: 'UPDATE_TEAM_MEMBER',
        targetType: 'TeamMember',
        targetId: targetUser._id,
        details: {
          action: 'DEACTIVATE_TEAM_MEMBER',
          status: 'suspended',
          isDeleted: true,
          deletedAt: targetUser.deletedAt,
          email: targetUser.email,
        },
        ipAddress: req.ip || '',
      });
    } catch (auditErr) {
      console.error('Audit log creation error on team member deactivation:', auditErr.message);
    }

    res.json({ message: 'Team member deactivated and removed successfully' });
  } catch (error) {
    console.error('Delete Team Member Error:', error);
    res.status(500).json({ message: error.message });
  }
};

// ── AccessRole Controller Handlers ──────────────────────────────────────────

// @desc    Get all AccessRoles for company / active workspace
// @route   GET /api/team-members/roles
// @access  Private (authorize: teamMembers.view)
const getAccessRoles = async (req, res) => {
  try {
    const profileId = req.activeProfileId || null;
    let filter = profileId
      ? { companyId: req.companyId, profile: profileId }
      : { companyId: req.companyId, $or: [{ profile: null }, { profile: { $exists: false } }] };

    let roles = await AccessRole.find(filter).sort({ isSystemRole: -1, createdAt: 1 });

    // Fallback: If no roles found for this specific profile, check for legacy un-scoped roles
    if (roles.length === 0 && profileId) {
      const legacyRoles = await AccessRole.find({
        companyId: req.companyId,
        $or: [{ profile: null }, { profile: { $exists: false } }],
      });
      if (legacyRoles.length > 0) {
        await AccessRole.updateMany(
          { companyId: req.companyId, $or: [{ profile: null }, { profile: { $exists: false } }] },
          { $set: { profile: profileId } }
        );
        roles = await AccessRole.find(filter).sort({ isSystemRole: -1, createdAt: 1 });
      }
    }

    // Ensure default system roles are seeded if none exist
    if (roles.length === 0) {
      const defaultRoles = AccessRole.getDefaultSystemRoles(req.companyId, profileId);
      await AccessRole.insertMany(defaultRoles);
      roles = await AccessRole.find(filter).sort({ isSystemRole: -1, createdAt: 1 });
    }

    // Auto-backfill any newly added system modules to existing system roles
    for (const role of roles) {
      if (role.isSystemRole) {
        const defaultRoleDef = AccessRole.getDefaultSystemRoles(req.companyId, role.profile).find(r => r.name === role.name);
        const defaultMap = defaultRoleDef?.permissions;
        if (defaultMap) {
          let roleChanged = false;
          const permMap = role.permissions || new Map();
          for (const mod of AccessRole.SYSTEM_MODULES) {
            const hasMod = permMap instanceof Map ? permMap.has(mod) : Boolean(permMap[mod]);
            if (!hasMod) {
              const defaultPerm = defaultMap.get(mod);
              if (defaultPerm) {
                if (permMap instanceof Map) {
                  permMap.set(mod, defaultPerm);
                } else {
                  permMap[mod] = defaultPerm;
                }
                roleChanged = true;
              }
            }
          }
          if (roleChanged) {
            role.permissions = permMap;
            role.markModified('permissions');
            await role.save();
          }
        }
      }
    }

    res.json(roles);
  } catch (error) {
    console.error('Get Access Roles Error:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create custom AccessRole
// @route   POST /api/team-members/roles
// @access  Private (authorize: teamMembers.create)
const createAccessRole = async (req, res) => {
  try {
    const { name, description, permissions } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Role name is required' });
    }

    const trimmedName = name.trim();
    const profileId = req.activeProfileId || null;
    const existing = await AccessRole.findOne({
      companyId: req.companyId,
      profile: profileId,
      name: trimmedName,
    });
    if (existing) {
      return res.status(400).json({ message: 'A role with this name already exists in this workspace' });
    }

    // Build permissions map scoped to organization enabled modules
    const permMap = new Map();
    const inputPerms = permissions || {};
    const isModuleAllowed = (mod) => {
      if (!req.ownerUser?.enabledModules || !Array.isArray(req.ownerUser.enabledModules)) return true;
      return req.ownerUser.enabledModules.includes(mod);
    };

    const approvableList = AccessRole.APPROVABLE_MODULES || [];

    for (const mod of AccessRole.SYSTEM_MODULES) {
      const isAllowed = isModuleAllowed(mod);
      const item = isAllowed ? (inputPerms[mod] || {}) : {};
      const supportedScopes = AccessRole.MODULE_SCOPE_SUPPORT?.[mod] || ['all', 'own'];
      let requestedScope = item.dataScope || 'all';
      if (!['all', 'own', 'businessUnit', 'client'].includes(requestedScope)) {
        requestedScope = 'all';
      }
      if (!supportedScopes.includes(requestedScope)) {
        return res.status(400).json({
          message: `The module "${mod}" does not support "${requestedScope}" data scope. Supported scopes: ${supportedScopes.join(', ')}`,
        });
      }

      permMap.set(mod, {
        view: Boolean(item.view),
        create: Boolean(item.create),
        edit: Boolean(item.edit),
        delete: Boolean(item.delete),
        approve: approvableList.includes(mod) ? Boolean(item.approve) : false,
        dataScope: requestedScope,
      });
    }

    // Role escalation check for non-owners
    assertNoPrivilegeEscalation(req, permMap);

    const role = await AccessRole.create({
      companyId: req.companyId,
      profile: profileId,
      name: trimmedName,
      description: description || '',
      isSystemRole: false,
      permissions: permMap,
      createdBy: req.user?._id || null,
      updatedBy: req.user?._id || null,
    });

    res.status(201).json(role);
  } catch (error) {
    console.error('Create Access Role Error:', error);
    res.status(error.status || 500).json({ message: error.message });
  }
};

// @desc    Update AccessRole permissions
// @route   PATCH /api/team-members/roles/:id
// @access  Private (authorize: teamMembers.edit)
const updateAccessRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, permissions } = req.body;

    const role = await AccessRole.findOne({ _id: id, companyId: req.companyId });
    if (!role) {
      return res.status(404).json({ message: 'Role not found' });
    }

    if (role.isSystemRole) {
      if (name && name.trim() !== role.name) {
        return res.status(403).json({ message: 'System default roles are protected and cannot be renamed' });
      }
      if (permissions) {
        return res.status(403).json({ message: 'Permissions of built-in system roles cannot be modified' });
      }
    }

    if (name && name.trim() !== role.name) {
      const existing = await AccessRole.findOne({
        companyId: req.companyId,
        profile: role.profile || null,
        name: name.trim(),
        _id: { $ne: role._id },
      });
      if (existing) return res.status(400).json({ message: 'Role name already taken in this workspace' });
      role.name = name.trim();
    }

    if (description !== undefined) role.description = description;

    if (permissions) {
      const permMap = role.permissions || new Map();
      const isModuleAllowed = (mod) => {
        if (!req.ownerUser?.enabledModules || !Array.isArray(req.ownerUser.enabledModules)) return true;
        return req.ownerUser.enabledModules.includes(mod);
      };

      const approvableList = AccessRole.APPROVABLE_MODULES || [];

      for (const mod of AccessRole.SYSTEM_MODULES) {
        if (permissions[mod]) {
          const isAllowed = isModuleAllowed(mod);
          const item = isAllowed ? permissions[mod] : {};
          const supportedScopes = AccessRole.MODULE_SCOPE_SUPPORT?.[mod] || ['all', 'own'];
          let requestedScope = item.dataScope || 'all';
          if (!['all', 'own', 'businessUnit', 'client'].includes(requestedScope)) {
            requestedScope = 'all';
          }
          if (!supportedScopes.includes(requestedScope)) {
            return res.status(400).json({
              message: `The module "${mod}" does not support "${requestedScope}" data scope. Supported scopes: ${supportedScopes.join(', ')}`,
            });
          }

          permMap.set(mod, {
            view: Boolean(item.view),
            create: Boolean(item.create),
            edit: Boolean(item.edit),
            delete: Boolean(item.delete),
            approve: approvableList.includes(mod) ? Boolean(item.approve) : false,
            dataScope: requestedScope,
          });
        }
      }

      // Role escalation check for non-owners
      assertNoPrivilegeEscalation(req, permMap);

      role.permissions = permMap;
      role.markModified('permissions');
    }

    if (req.user?._id) {
      role.updatedBy = req.user._id;
    }

    await role.save();
    res.json(role);
  } catch (error) {
    console.error('Update Access Role Error:', error);
    res.status(error.status || 500).json({ message: error.message });
  }
};

// @desc    Delete custom AccessRole
// @route   DELETE /api/team-members/roles/:id
// @access  Private (authorize: teamMembers.delete)
const deleteAccessRole = async (req, res) => {
  try {
    const { id } = req.params;

    const role = await AccessRole.findOne({ _id: id, companyId: req.companyId });
    if (!role) {
      return res.status(404).json({ message: 'Role not found' });
    }

    if (role.isSystemRole) {
      return res.status(400).json({ message: 'Built-in system roles cannot be deleted' });
    }

    // Reassign any team members assigned to this role to Viewer system role for this workspace
    const defaultViewer = await AccessRole.findOne({ companyId: req.companyId, profile: role.profile || null, name: 'Viewer' })
      || await AccessRole.findOne({ companyId: req.companyId, name: 'Viewer' });

    if (defaultViewer) {
      // 1. Reassign direct accessRole on User
      await User.updateMany(
        { companyId: req.companyId, accessRole: role._id },
        { accessRole: defaultViewer._id }
      );

      // 2. Reassign profileAccess.accessRole entries matching deleted role
      await User.updateMany(
        { companyId: req.companyId, 'profileAccess.accessRole': role._id },
        { $set: { 'profileAccess.$[elem].accessRole': defaultViewer._id } },
        { arrayFilters: [{ 'elem.accessRole': role._id }] }
      );
    }

    await AccessRole.deleteOne({ _id: role._id });
    res.json({ message: 'Role deleted successfully' });
  } catch (error) {
    console.error('Delete Access Role Error:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get system modules metadata (shared source of truth)
// @route   GET /api/team-members/modules
// @access  Private (authorize: teamMembers.view)
const getSystemModules = async (req, res) => {
  try {
    res.json({
      modules: AccessRole.SYSTEM_MODULES,
      approvableModules: AccessRole.APPROVABLE_MODULES,
      moduleScopeSupport: AccessRole.MODULE_SCOPE_SUPPORT,
    });
  } catch (error) {
    console.error('Get System Modules Error:', error);
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  inviteTeamMember,
  acceptInvite,
  getTeamMembers,
  updateTeamMember,
  deleteTeamMember,
  getAccessRoles,
  createAccessRole,
  updateAccessRole,
  deleteAccessRole,
  getSystemModules,
  assertNoPrivilegeEscalation,
  validateAssignedEntities,
  validateProfileAccess,
  isCompanyOwnerUser,
};
