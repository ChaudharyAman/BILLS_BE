const mongoose = require('mongoose');
const User = require('../models/User');
const AccessRole = require('../models/AccessRole');
const AdminAuditLog = require('../models/AdminAuditLog');

const Client = require('../models/Client');
const Item = require('../models/Item');
const Invoice = require('../models/Invoice');
const Quote = require('../models/Quote');
const Proforma = require('../models/Proforma');
const PurchaseOrder = require('../models/PurchaseOrder');
const Expense = require('../models/Expense');
const Settings = require('../models/Settings');
const SubscriptionOrder = require('../models/SubscriptionOrder');
const BankStatement = require('../models/BankStatement');
const Employee = require('../models/Employee');
const Payroll = require('../models/Payroll');
const Loan = require('../models/Loan');
const ReimbursementClaim = require('../models/ReimbursementClaim');
const LeaveRequest = require('../models/LeaveRequest');
const Project = require('../models/Project');
const BusinessUnit = require('../models/BusinessUnit');
const Department = require('../models/Department');
const Category = require('../models/Category');

const logAdminAction = async (actor, action, targetType, targetId, targetLabel, metadata = {}) => {
  try {
    await AdminAuditLog.create({
      actorId: actor._id,
      actorUsername: actor.username || '',
      actorEmail: actor.email || '',
      action,
      targetType,
      targetId,
      targetLabel,
      metadata,
    });
  } catch (err) {
    console.error('AdminAuditLog creation error:', err.message);
  }
};

// @desc    Get all users (flat list - backward compatibility)
// @route   GET /api/admin/users
// @access  Private/Admin
const getAllUsers = async (req, res) => {
  try {
    const users = await User.find({}).select('-password').sort({ createdAt: -1 });
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get companies (owners only) with filters, search & pagination
// @route   GET /api/admin/companies
// @access  Private/Admin
const getCompanies = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 10);
    const skip = (page - 1) * limit;

    const filter = {
      $or: [
        { isOwner: true },
        { companyId: null },
        { companyId: { $exists: false } },
      ],
    };

    if (req.query.q) {
      const regex = new RegExp(req.query.q, 'i');
      filter.$and = [{ $or: [{ username: regex }, { email: regex }] }];
    }

    if (req.query.plan) {
      filter['subscription.plan'] = req.query.plan;
    }
    if (req.query.status) {
      filter['subscription.status'] = req.query.status;
    }
    if (req.query.isActive !== undefined) {
      filter.isActive = req.query.isActive === 'true';
    }

    const total = await User.countDocuments(filter);
    const owners = await User.find(filter)
      .select('-password')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const ownerIds = owners.map(o => o._id);
    const teamCounts = await User.aggregate([
      { $match: { companyId: { $in: ownerIds }, _id: { $nin: ownerIds } } },
      { $group: { _id: '$companyId', count: { $sum: 1 } } },
    ]);

    const countMap = new Map();
    teamCounts.forEach(t => countMap.set(String(t._id), t.count));

    const companies = owners.map(o => ({
      ...o,
      teamMemberCount: countMap.get(String(o._id)) || 0,
    }));

    res.json({
      companies,
      page,
      pages: Math.ceil(total / limit) || 1,
      total,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get company team members & owner for specific ownerId
// @route   GET /api/admin/companies/:ownerId/team
// @access  Private/Admin
const getCompanyTeam = async (req, res) => {
  try {
    const { ownerId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(ownerId)) {
      return res.status(400).json({ message: 'Invalid company owner ID' });
    }

    const owner = await User.findById(ownerId).select('-password').lean();
    if (!owner) {
      return res.status(404).json({ message: 'Company owner not found' });
    }

    const team = await User.find({ companyId: ownerId, _id: { $ne: ownerId } })
      .select('-password')
      .populate('accessRole', 'name permissions isSystemRole')
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      owner,
      team,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get custom access roles for a specific company
// @route   GET /api/admin/companies/:ownerId/roles
// @access  Private/Admin
const getCompanyRoles = async (req, res) => {
  try {
    const { ownerId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(ownerId)) {
      return res.status(400).json({ message: 'Invalid company owner ID' });
    }

    const roles = await AccessRole.find({ companyId: ownerId }).sort({ createdAt: 1 });
    res.json(roles);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Superadmin cross-tenant update of a team member's role or status
// @route   PATCH /api/admin/team-members/:id
// @access  Private/Admin
const updateTeamMember = async (req, res) => {
  try {
    const { id } = req.params;
    const { accessRole, status } = req.body;

    const member = await User.findById(id);
    if (!member) {
      return res.status(404).json({ message: 'Team member not found' });
    }

    if (member.isOwner) {
      return res.status(400).json({ message: 'Cannot update owner via team-member endpoint' });
    }

    const changes = {};
    if (accessRole !== undefined) {
      if (accessRole) {
        const roleDoc = await AccessRole.findById(accessRole);
        if (!roleDoc) return res.status(400).json({ message: 'Selected access role does not exist' });
        member.accessRole = accessRole;
      } else {
        member.accessRole = null;
      }
      changes.accessRole = accessRole;
    }

    if (status !== undefined) {
      if (!['active', 'suspended', 'invited'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status value' });
      }
      member.status = status;
      member.isActive = status === 'active';
      changes.status = status;
    }

    await member.save();

    await logAdminAction(
      req.user,
      'UPDATE_TEAM_MEMBER',
      'TeamMember',
      member._id,
      member.email || member.username,
      changes
    );

    res.json(member);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get paginated admin audit logs
// @route   GET /api/admin/audit-log
// @access  Private/Admin
const getAuditLogs = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 20);
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.action) filter.action = req.query.action;
    if (req.query.q) {
      const regex = new RegExp(req.query.q, 'i');
      filter.$or = [{ actorEmail: regex }, { targetLabel: regex }];
    }

    const total = await AdminAuditLog.countDocuments(filter);
    const logs = await AdminAuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({
      logs,
      page,
      pages: Math.ceil(total / limit) || 1,
      total,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create a new user by Admin
// @route   POST /api/admin/users
// @access  Private/Admin
const createUser = async (req, res) => {
  try {
    const { username, email, password, role, plan, billingCycle, endDate } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ message: 'Username, email and password are required' });
    }

    const emailLower = email.toLowerCase();

    const existingUser = await User.findOne({ $or: [{ username }, { email: emailLower }] });
    if (existingUser) {
      if (existingUser.email === emailLower) {
        return res.status(400).json({ message: 'Email is already registered' });
      }
      return res.status(400).json({ message: 'Username is already taken' });
    }

    const subscription = {
      plan: plan || 'free',
      status: 'active',
      billingCycle: billingCycle || 'monthly'
    };

    if (plan === 'pro' && endDate) {
      const d = new Date(endDate);
      if (!isNaN(d.getTime())) {
        subscription.endDate = d;
      }
    }

    const user = await User.create({
      username,
      email: emailLower,
      password,
      role: role || 'user',
      subscription,
      isActive: true,
      isOwner: true,
    });

    user.companyId = user._id;
    await user.save();

    await AccessRole.getDefaultSystemRoles(user._id).forEach(r => AccessRole.create(r).catch(() => {}));

    const userObj = user.toObject();
    delete userObj.password;

    await logAdminAction(
      req.user,
      'CREATE_USER',
      'User',
      user._id,
      user.email,
      { role: user.role, plan: subscription.plan }
    );

    res.status(201).json(userObj);
  } catch (error) {
    console.error('Admin Create User Error:', error);
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(val => val.message);
      return res.status(400).json({ message: messages.join(', ') });
    }
    res.status(500).json({ message: 'Failed to create user: ' + error.message });
  }
};

// @desc    Update user subscription plan & active status with self-demotion & last-superadmin guards
// @route   PATCH /api/admin/users/:id/plan
// @access  Private/Admin
const updateUserPlan = async (req, res) => {
  try {
    const { plan, status, endDate, billingCycle, isActive, role } = req.body;

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // 1. Self-demotion guard
    if (String(req.user._id) === String(user._id) && role && role !== 'superadmin') {
      return res.status(400).json({ message: 'Self-demotion is forbidden. You cannot remove your own Super Admin role.' });
    }

    // 2. Last superadmin account guard
    if ((role && role !== 'superadmin') || isActive === false) {
      if (user.role === 'superadmin') {
        const activeSuperAdmins = await User.countDocuments({
          role: 'superadmin',
          isActive: { $ne: false },
          _id: { $ne: user._id },
        });
        if (activeSuperAdmins === 0) {
          return res.status(400).json({ message: 'Cannot demote or deactivate the last remaining active Super Admin account.' });
        }
      }
    }

    if (!user.subscription) {
      user.subscription = { plan: 'free', status: 'active' };
    }

    const previousRole = user.role;
    if (plan !== undefined) user.subscription.plan = plan;
    if (status !== undefined) user.subscription.status = status;
    if (billingCycle !== undefined) user.subscription.billingCycle = billingCycle;
    if (isActive !== undefined) user.isActive = isActive;
    if (role !== undefined) user.role = role;

    if (endDate === '' || endDate === null || plan === 'free') {
      user.subscription.endDate = null;
    } else if (endDate) {
      const d = new Date(endDate);
      if (!isNaN(d.getTime())) {
        user.subscription.endDate = d;
      }
    }

    if (plan === 'free') {
      user.subscription.status = 'active';
    }

    user.markModified('subscription');

    const updatedUser = await user.save();

    let action = 'UPDATE_USER_PLAN';
    if (role && role !== previousRole) {
      action = role === 'superadmin' ? 'SUPERADMIN_PROMOTION' : 'SUPERADMIN_DEMOTION';
    }

    await logAdminAction(
      req.user,
      action,
      'User',
      user._id,
      user.email || user.username,
      { plan, status, billingCycle, isActive, role }
    );

    res.json(updatedUser);
  } catch (error) {
    console.error('User Update Error:', error);
    res.status(500).json({ message: 'Failed to update user: ' + error.message });
  }
};

// @desc    Delete a user and their associated team & data (with force safety check & cascading)
// @route   DELETE /api/admin/users/:id
// @access  Private/Admin
const deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (String(user._id) === String(req.user._id)) {
      return res.status(400).json({ message: 'You cannot delete your own admin account' });
    }

    if (user.role === 'superadmin') {
      const activeSuperAdmins = await User.countDocuments({
        role: 'superadmin',
        isActive: { $ne: false },
        _id: { $ne: user._id },
      });
      if (activeSuperAdmins === 0) {
        return res.status(400).json({ message: 'Cannot delete the last remaining Super Admin account.' });
      }
    }

    const companyId = user.isOwner || !user.companyId ? user._id : user.companyId;

    if (user.isOwner || String(user._id) === String(companyId)) {
      const teamCount = await User.countDocuments({ companyId, _id: { $ne: user._id } });
      if (teamCount > 0 && req.query.force !== 'true') {
        return res.status(400).json({
          message: `This company owner has ${teamCount} active team member(s). Deleting this user will permanently remove the company and all team members.`,
          requiresForce: true,
          teamMemberCount: teamCount,
        });
      }
    }

    await Promise.all([
      Client.deleteMany({ user: companyId }),
      Item.deleteMany({ user: companyId }),
      Invoice.deleteMany({ user: companyId }),
      Quote.deleteMany({ user: companyId }),
      Proforma.deleteMany({ user: companyId }),
      PurchaseOrder.deleteMany({ user: companyId }),
      Expense.deleteMany({ user: companyId }),
      Settings.deleteMany({ user: companyId }),
      SubscriptionOrder.deleteMany({ user: companyId }),
      BankStatement.deleteMany({ user: companyId }),
      Employee.deleteMany({ user: companyId }),
      Payroll.deleteMany({ user: companyId }),
      Loan.deleteMany({ user: companyId }),
      ReimbursementClaim.deleteMany({ user: companyId }),
      LeaveRequest.deleteMany({ user: companyId }),
      Project.deleteMany({ user: companyId }),
      BusinessUnit.deleteMany({ user: companyId }),
      Department.deleteMany({ user: companyId }),
      Category.deleteMany({ user: companyId }),
      AccessRole.deleteMany({ companyId }),
      User.deleteMany({ companyId }),
      User.deleteOne({ _id: user._id }),
    ]);

    await logAdminAction(
      req.user,
      'DELETE_USER',
      'User',
      user._id,
      user.email || user.username,
      { isOwner: user.isOwner, companyId }
    );

    res.json({ message: 'User and all associated team and company data deleted successfully' });
  } catch (error) {
    console.error('Delete User Error:', error);
    res.status(500).json({ message: 'Failed to delete user: ' + error.message });
  }
};

// @desc    Get user payment history
// @route   GET /api/admin/users/:id/payments
// @access  Private/Admin
const getUserPayments = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('paymentHistory username email');
    if (user) {
      res.json(user);
    } else {
      res.status(404).json({ message: 'User not found' });
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Reset password for a user account by Superadmin
// @route   PATCH /api/admin/users/:id/password
// @access  Private/Admin
const resetUserPassword = async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.trim().length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters long' });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User account not found' });
    }

    user.password = newPassword.trim();
    await user.save();

    await logAdminAction(
      req.user,
      'RESET_USER_PASSWORD',
      'User',
      user._id,
      user.email || user.username,
      { isOwner: user.isOwner }
    );

    res.json({ message: 'User password reset successfully' });
  } catch (error) {
    console.error('Reset User Password Error:', error);
    res.status(500).json({ message: 'Failed to reset password: ' + error.message });
  }
};

module.exports = {
  getAllUsers,
  getCompanies,
  getCompanyTeam,
  getCompanyRoles,
  updateTeamMember,
  getAuditLogs,
  createUser,
  updateUserPlan,
  deleteUser,
  getUserPayments,
  resetUserPassword,
};
