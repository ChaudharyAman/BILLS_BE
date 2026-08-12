const crypto = require('crypto');
const User = require('../models/User');
const AccessRole = require('../models/AccessRole');

// @desc    Invite a new team member to company
// @route   POST /api/team-members/invite
// @access  Private (authorize: teamMembers.create)
const inviteTeamMember = async (req, res) => {
  try {
    const { email, username, accessRoleId } = req.body;

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

    // Verify AccessRole belongs to current company
    let roleId = accessRoleId;
    if (!roleId) {
      const defaultViewer = await AccessRole.findOne({ companyId: req.companyId, name: 'Viewer' });
      if (defaultViewer) roleId = defaultViewer._id;
    } else {
      const validRole = await AccessRole.findOne({ _id: roleId, companyId: req.companyId });
      if (!validRole) {
        return res.status(400).json({ message: 'Invalid AccessRole selected for your company' });
      }
    }

    // Free plan seat check: limit team members on free plan
    const ownerPlan = req.ownerUser?.subscription?.plan || 'free';
    if (ownerPlan === 'free') {
      const currentTeamCount = await User.countDocuments({ companyId: req.companyId, isOwner: false });
      if (currentTeamCount >= 2) {
        return res.status(403).json({
          message: 'Free plan is limited to 2 team members. Upgrade to Pro for unlimited team members.'
        });
      }
    }

    // Generate secure invite token
    const token = crypto.randomBytes(32).toString('hex');
    const tokenExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    // Temporary random password placeholder until invite accepted
    const dummyPassword = crypto.randomBytes(16).toString('hex');

    const newUser = await User.create({
      username: desiredUsername,
      email: emailLower,
      password: dummyPassword,
      companyId: req.companyId,
      isOwner: false,
      accessRole: roleId,
      invitedBy: req.user._id,
      status: 'invited',
      inviteToken: token,
      inviteTokenExpires: tokenExpires,
      isActive: true,
    });

    const populatedUser = await User.findById(newUser._id).select('-password').populate('accessRole');

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
    res.status(500).json({ message: 'Failed to invite team member: ' + error.message });
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
    });

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
    const members = await User.find({ companyId: req.companyId, isOwner: false })
      .select('-password')
      .populate('accessRole')
      .sort({ createdAt: -1 });

    // Include owner details in summary response
    const owner = await User.findById(req.companyId).select('-password');

    res.json({
      owner: {
        _id: owner._id,
        username: owner.username,
        email: owner.email,
        isOwner: true,
        roleName: 'Company Owner',
      },
      teamMembers: members,
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
    const { accessRoleId, status, phone } = req.body;

    const targetUser = await User.findOne({ _id: id, companyId: req.companyId });
    if (!targetUser) {
      return res.status(404).json({ message: 'Team member not found' });
    }

    if (targetUser.isOwner) {
      return res.status(400).json({ message: 'Cannot modify permissions or status of company owner' });
    }

    if (accessRoleId) {
      const validRole = await AccessRole.findOne({ _id: accessRoleId, companyId: req.companyId });
      if (!validRole) {
        return res.status(400).json({ message: 'Invalid AccessRole selected' });
      }
      targetUser.accessRole = accessRoleId;
    }

    if (status && ['active', 'suspended'].includes(status)) {
      targetUser.status = status;
      targetUser.isActive = status === 'active';
    }

    if (phone !== undefined) {
      targetUser.phone = phone;
    }

    await targetUser.save();

    const updated = await User.findById(id).select('-password').populate('accessRole');
    res.json(updated);
  } catch (error) {
    console.error('Update Team Member Error:', error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete / remove team member
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

    await User.deleteOne({ _id: targetUser._id });
    res.json({ message: 'Team member removed successfully' });
  } catch (error) {
    console.error('Delete Team Member Error:', error);
    res.status(500).json({ message: error.message });
  }
};

// ── AccessRole Controller Handlers ──────────────────────────────────────────

// @desc    Get all AccessRoles for company
// @route   GET /api/team-members/roles
// @access  Private (authorize: teamMembers.view)
const getAccessRoles = async (req, res) => {
  try {
    // Ensure default system roles are seeded
    let roles = await AccessRole.find({ companyId: req.companyId }).sort({ isSystemRole: -1, createdAt: 1 });
    if (roles.length === 0) {
      const defaultRoles = AccessRole.getDefaultSystemRoles(req.companyId);
      await AccessRole.insertMany(defaultRoles);
      roles = await AccessRole.find({ companyId: req.companyId }).sort({ isSystemRole: -1, createdAt: 1 });
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
    const existing = await AccessRole.findOne({ companyId: req.companyId, name: trimmedName });
    if (existing) {
      return res.status(400).json({ message: 'A role with this name already exists in your company' });
    }

    // Build permissions map
    const permMap = new Map();
    const inputPerms = permissions || {};

    for (const mod of AccessRole.SYSTEM_MODULES) {
      const item = inputPerms[mod] || {};
      permMap.set(mod, {
        view: Boolean(item.view),
        create: Boolean(item.create),
        edit: Boolean(item.edit),
        delete: Boolean(item.delete),
        approve: Boolean(item.approve),
      });
    }

    const role = await AccessRole.create({
      companyId: req.companyId,
      name: trimmedName,
      description: description || '',
      isSystemRole: false,
      permissions: permMap,
    });

    res.status(201).json(role);
  } catch (error) {
    console.error('Create Access Role Error:', error);
    res.status(500).json({ message: error.message });
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

    if (name && name.trim() !== role.name) {
      if (role.isSystemRole) {
        return res.status(400).json({ message: 'Cannot rename built-in system roles' });
      }
      const existing = await AccessRole.findOne({ companyId: req.companyId, name: name.trim() });
      if (existing) return res.status(400).json({ message: 'Role name already taken' });
      role.name = name.trim();
    }

    if (description !== undefined) role.description = description;

    if (permissions) {
      const permMap = role.permissions || new Map();
      for (const mod of AccessRole.SYSTEM_MODULES) {
        if (permissions[mod]) {
          const item = permissions[mod];
          permMap.set(mod, {
            view: Boolean(item.view),
            create: Boolean(item.create),
            edit: Boolean(item.edit),
            delete: Boolean(item.delete),
            approve: Boolean(item.approve),
          });
        }
      }
      role.permissions = permMap;
      role.markModified('permissions');
    }

    await role.save();
    res.json(role);
  } catch (error) {
    console.error('Update Access Role Error:', error);
    res.status(500).json({ message: error.message });
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

    // Reassign any team members assigned to this role to Viewer system role
    const defaultViewer = await AccessRole.findOne({ companyId: req.companyId, name: 'Viewer' });
    if (defaultViewer) {
      await User.updateMany(
        { companyId: req.companyId, accessRole: role._id },
        { accessRole: defaultViewer._id }
      );
    }

    await AccessRole.deleteOne({ _id: role._id });
    res.json({ message: 'Role deleted successfully' });
  } catch (error) {
    console.error('Delete Access Role Error:', error);
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
};
