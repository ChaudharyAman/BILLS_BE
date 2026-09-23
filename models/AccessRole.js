const mongoose = require('mongoose');

const PermissionSchema = new mongoose.Schema({
  view: { type: Boolean, default: false },
  create: { type: Boolean, default: false },
  edit: { type: Boolean, default: false },
  delete: { type: Boolean, default: false },
  approve: { type: Boolean, default: false },
}, { _id: false });

const AccessRoleSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    index: true,
  },
  profile: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ClientProfile',
    required: false,
    index: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  description: {
    type: String,
    default: '',
    trim: true,
  },
  isSystemRole: {
    type: Boolean,
    default: false,
  },
  permissions: {
    type: Map,
    of: PermissionSchema,
    default: {},
  },
}, { timestamps: true });

// Ensure unique role names per profile (and per company when profile is null)
AccessRoleSchema.index({ companyId: 1, profile: 1, name: 1 }, { unique: true, sparse: true });
AccessRoleSchema.index({ companyId: 1, name: 1 }, { unique: true, partialFilterExpression: { profile: null } });

// Standard system role templates
AccessRoleSchema.statics.SYSTEM_MODULES = [
  'clientProfiles',
  'expenses',
  'income',
  'invoices',
  'quotes',
  'proformas',
  'purchaseOrders',
  'clients',
  'vendors',
  'items',
  'projects',
  'employees',
  'payroll',
  'leaves',
  'reimbursements',
  'loans',
  'liabilities',
  'assets',
  'budgets',
  'businessUnits',
  'departments',
  'categories',
  'bankStatements',
  'recurringTransactions',
  'reports',
  'settings',
  'teamMembers',
  'subscription',
  'jobRoles',
  'publicSubmissions',
];

AccessRoleSchema.statics.getDefaultSystemRoles = function (companyId, profileId = null) {
  const modules = this.SYSTEM_MODULES;

  const buildPermissionMap = (view, create, edit, del, approve) => {
    const map = new Map();
    for (const mod of modules) {
      map.set(mod, { view, create, edit, delete: del, approve });
    }
    return map;
  };

  const adminMap = buildPermissionMap(true, true, true, true, true);
  // Admin cannot alter root subscription or root ownership deletion
  adminMap.set('subscription', { view: true, create: false, edit: false, delete: false, approve: false });

  const managerMap = buildPermissionMap(true, true, true, false, true);
  managerMap.set('settings', { view: true, create: false, edit: false, delete: false, approve: false });
  managerMap.set('teamMembers', { view: false, create: false, edit: false, delete: false, approve: false });
  managerMap.set('subscription', { view: false, create: false, edit: false, delete: false, approve: false });

  const accountantMap = buildPermissionMap(false, false, false, false, false);
  const finModules = ['expenses', 'income', 'invoices', 'quotes', 'proformas', 'purchaseOrders', 'clients', 'vendors', 'items', 'budgets', 'bankStatements', 'recurringTransactions', 'reports', 'categories', 'publicSubmissions'];
  for (const mod of finModules) {
    accountantMap.set(mod, { view: true, create: true, edit: true, delete: true, approve: true });
  }

  const viewerMap = buildPermissionMap(true, false, false, false, false);

  return [
    {
      companyId,
      profile: profileId,
      name: 'Admin',
      description: 'Full operational access across all company modules',
      isSystemRole: true,
      permissions: adminMap,
    },
    {
      companyId,
      profile: profileId,
      name: 'Manager',
      description: 'View, create, and edit operations; no delete or administrative settings access',
      isSystemRole: true,
      permissions: managerMap,
    },
    {
      companyId,
      profile: profileId,
      name: 'Accountant',
      description: 'Full access to financial, billing, and accounting modules',
      isSystemRole: true,
      permissions: accountantMap,
    },
    {
      companyId,
      profile: profileId,
      name: 'Viewer',
      description: 'Read-only access across all enabled modules',
      isSystemRole: true,
      permissions: viewerMap,
    },
  ];
};

module.exports = mongoose.model('AccessRole', AccessRoleSchema);
