const mongoose = require('mongoose');

const PermissionSchema = new mongoose.Schema({
  view: { type: Boolean, default: false },
  create: { type: Boolean, default: false },
  edit: { type: Boolean, default: false },
  delete: { type: Boolean, default: false },
  approve: { type: Boolean, default: false },
  dataScope: {
    type: String,
    enum: ['all', 'own', 'businessUnit', 'client'],
    default: 'all',
  },
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
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
    index: true,
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
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

/**
 * Per-module scope capability map.
 * Declares which RBAC dataScopes ('all' | 'own' | 'businessUnit' | 'client') are supported by each module.
 * - 'all' and 'own' are universally supported across all modules recording createdBy.
 * - 'businessUnit' is supported if model has businessUnit field, or matches _id (for businessUnits module).
 * - 'client' is supported if model has client/clientRef reference, or matches _id (for clients module).
 * - PurchaseOrder: POs are issued to vendors (vendor.vendorRef), not clients. Client scope is therefore unsupported.
 * - Payroll: Payroll and PayrollVariableTransaction use plain String client descriptions, so client scope is unsupported.
 */
AccessRoleSchema.statics.MODULE_SCOPE_SUPPORT = {
  clientProfiles:        ['all'],
  expenses:              ['all', 'own', 'businessUnit', 'client'],
  income:                ['all', 'own', 'businessUnit', 'client'],
  invoices:              ['all', 'own', 'businessUnit', 'client'],
  quotes:                ['all', 'own', 'businessUnit', 'client'],
  proformas:             ['all', 'own', 'businessUnit', 'client'],
  purchaseOrders:        ['all', 'own', 'businessUnit'], // Vendors only, no client ref
  clients:               ['all', 'own', 'client'],       // Matches _id against assignedClients
  vendors:               ['all', 'own'],
  items:                 ['all', 'own'],
  projects:              ['all', 'own', 'client'],       // Project.client reference
  employees:             ['all', 'own'],
  payroll:               ['all', 'own'],                 // Client is plain text string; client scope unsupported
  leaves:                ['all', 'own'],
  reimbursements:        ['all', 'own'],
  loans:                 ['all', 'own'],
  liabilities:           ['all', 'own'],
  assets:                ['all', 'own'],
  budgets:               ['all', 'own', 'businessUnit'], // Budget.businessUnit
  businessUnits:         ['all', 'own', 'businessUnit'], // Matches _id against assignedBusinessUnits
  departments:           ['all', 'own'],
  categories:            ['all', 'own'],
  bankStatements:        ['all', 'own'],
  recurringTransactions: ['all', 'own', 'businessUnit', 'client'],
  reports:               ['all', 'own'],
  settings:              ['all'],                        // Organization-wide settings
  teamMembers:           ['all', 'own'],
  subscription:          ['all'],
  jobRoles:              ['all', 'own'],
  publicSubmissions:     ['all', 'own'],
};

AccessRoleSchema.statics.APPROVABLE_MODULES = [
  'leaves',
  'loans',
  'payroll',
  'proformas',
  'purchaseOrders',
  'quotes',
  'reimbursements',
  'publicSubmissions',
];

AccessRoleSchema.statics.getDefaultSystemRoles = function (companyId, profileId = null) {
  const modules = this.SYSTEM_MODULES;
  const approvableModules = this.APPROVABLE_MODULES;

  const buildPermissionMap = (view, create, edit, del, approve, dataScope = 'all') => {
    const map = new Map();
    for (const mod of modules) {
      const isApprovable = approvableModules.includes(mod);
      map.set(mod, {
        view,
        create,
        edit,
        delete: del,
        approve: isApprovable ? approve : false,
        dataScope,
      });
    }
    return map;
  };

  const adminMap = buildPermissionMap(true, true, true, true, true, 'all');
  // Admin cannot alter root subscription or root ownership deletion
  adminMap.set('subscription', { view: true, create: false, edit: false, delete: false, approve: false });

  const managerMap = buildPermissionMap(true, true, true, false, true);
  managerMap.set('settings', { view: true, create: false, edit: false, delete: false, approve: false });
  managerMap.set('teamMembers', { view: false, create: false, edit: false, delete: false, approve: false });
  managerMap.set('subscription', { view: false, create: false, edit: false, delete: false, approve: false });

  const accountantMap = buildPermissionMap(false, false, false, false, false);
  const finModules = ['expenses', 'income', 'invoices', 'quotes', 'proformas', 'purchaseOrders', 'clients', 'vendors', 'items', 'budgets', 'bankStatements', 'recurringTransactions', 'reports', 'categories', 'publicSubmissions'];
  for (const mod of finModules) {
    accountantMap.set(mod, { view: true, create: true, edit: true, delete: true, approve: approvableModules.includes(mod) });
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

const AccessRole = mongoose.model('AccessRole', AccessRoleSchema);
AccessRole.APPROVABLE_MODULES = AccessRoleSchema.statics.APPROVABLE_MODULES;
AccessRole.SYSTEM_MODULES = AccessRoleSchema.statics.SYSTEM_MODULES;
AccessRole.MODULE_SCOPE_SUPPORT = AccessRoleSchema.statics.MODULE_SCOPE_SUPPORT;

module.exports = AccessRole;
