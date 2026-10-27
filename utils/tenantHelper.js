/**
 * MBB/utils/tenantHelper.js
 * 
 * Tenancy and RBAC Data-Scoping helper for Multi-Client Profiles.
 * Prioritizes req.activeProfileId; falls back to req.companyId / req.user._id for backward compatibility.
 * Dynamically enforces RBAC Data Scope ('all' | 'own' | 'businessUnit' | 'client') for team members.
 */

const mongoose = require('mongoose');

const URL_TO_MODULE = {
  '/api/expenses': 'expenses',
  '/api/incomes': 'income',
  '/api/invoices': 'invoices',
  '/api/quotes': 'quotes',
  '/api/proformas': 'proformas',
  '/api/purchase-orders': 'purchaseOrders',
  '/api/clients': 'clients',
  '/api/vendors': 'vendors',
  '/api/items': 'items',
  '/api/projects': 'projects',
  '/api/employees': 'employees',
  '/api/payroll': 'payroll',
  '/api/payroll-variable-transactions': 'payroll',
  '/api/leaves': 'leaves',
  '/api/reimbursements': 'reimbursements',
  '/api/loans': 'loans',
  '/api/roles': 'jobRoles',
  '/api/liabilities': 'liabilities',
  '/api/assets': 'assets',
  '/api/budgets': 'budgets',
  '/api/business-units': 'businessUnits',
  '/api/departments': 'departments',
  '/api/categories': 'categories',
  '/api/bank-statements': 'bankStatements',
  '/api/recurring': 'recurringTransactions',
  '/api/reports': 'reports',
  '/api/settings': 'settings',
  '/api/team-members': 'teamMembers',
  '/api/subscriptions': 'subscription',
  '/api/submissions': 'publicSubmissions',
  '/api/equity': 'reports',
  '/api/accruals': 'reports',
  '/api/company-documents': 'settings',
  '/api/recycle-bin': 'settings',
  '/api/pdf': 'invoices',
  '/api/profiles': 'clientProfiles',
};

function resolveModuleName(req, explicitModule) {
  if (explicitModule) return explicitModule;
  if (!req?.baseUrl) return null;
  return URL_TO_MODULE[req.baseUrl] || null;
}

function isCompanyOwner(req) {
  if (!req?.user) return false;
  if (req.user.isOwner === true) return true;
  if (req.user.role === 'superadmin' || req.user.role === 'owner') return true;
  // If companyId matches the user's _id, they are the owner
  if (req.companyId && req.user._id && String(req.companyId) === String(req.user._id)) {
    return true;
  }
  // If the user has no companyId and no accessRole, and is not explicitly marked as a team member
  if (!req.user.companyId && !req.user.accessRole && req.user.isOwner !== false) {
    return true;
  }
  return false;
}

function getDataScopeCondition(req, moduleName, forAggregate = false) {
  if (!req?.user) return {};
  // Account Owner and Superadmin always have unrestricted 'all' access
  if (isCompanyOwner(req)) {
    return {};
  }
  // Public share sessions are governed by shareRules, not team member dataScope
  if (req.isSharedAccess || req.profileAccessSource === 'share') {
    return {};
  }

  const mod = resolveModuleName(req, moduleName);
  // Fail closed for team members: if a module cannot be resolved, deny access (matches zero documents)
  if (!mod) {
    const unmatchableId = new mongoose.Types.ObjectId('000000000000000000000000');
    return { _id: unmatchableId };
  }

  const perm = req.permissions?.get ? req.permissions.get(mod) : req.permissions?.[mod];
  let dataScope = perm?.dataScope || 'all';

  // Ensure dataScope is supported by this module. If unsupported, fallback to 'own' or 'all'
  // so we never silently generate an unmatchable filter on a non-existent field.
  const AccessRole = require('../models/AccessRole');
  const supportedScopes = AccessRole.MODULE_SCOPE_SUPPORT?.[mod] || ['all', 'own'];
  if (!supportedScopes.includes(dataScope)) {
    dataScope = supportedScopes.includes('own') ? 'own' : 'all';
  }

  const userId = req.user._id;
  const userObjId = forAggregate ? (userId instanceof mongoose.Types.ObjectId ? userId : new mongoose.Types.ObjectId(String(userId))) : userId;

  if (dataScope === 'own') {
    return { createdBy: userObjId };
  }

  if (dataScope === 'businessUnit') {
    const rawBUs = req.user.assignedBusinessUnits || [];
    const buIds = rawBUs.map(id => forAggregate ? (id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id))) : id);
    if (buIds.length > 0) {
      if (mod === 'businessUnits') {
        // Direct business unit records match their own _id
        return { _id: { $in: buIds } };
      }
      return { businessUnit: { $in: buIds } };
    }
    // If set to BU scope but user has no BUs assigned, restrict to own data
    return { createdBy: userObjId };
  }

  if (dataScope === 'client') {
    const rawClients = req.user.assignedClients || [];
    const clientIds = rawClients.map(id => forAggregate ? (id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id))) : id);
    if (clientIds.length > 0) {
      if (mod === 'clients') {
        // Direct client records match their own _id
        return { _id: { $in: clientIds } };
      }
      return {
        $or: [
          { 'client.clientRef': { $in: clientIds } },
          { client: { $in: clientIds } },
          { clientRef: { $in: clientIds } },
        ],
      };
    }
    // If set to client scope but user has no clients assigned, restrict to own data
    return { createdBy: userObjId };
  }

  return {};
}

function getTenantFilter(req, moduleName) {
  let filter = {};
  if (req && req.activeProfileId) {
    filter.profile = req.activeProfileId;
  } else {
    const companyId = req?.companyId || req?.user?._id;
    if (companyId) {
      filter.user = companyId;
    }
  }

  const scopeCond = getDataScopeCondition(req, moduleName, false);
  if (scopeCond.$or) {
    if (filter.$or) {
      filter.$and = (filter.$and || []).concat([{ $or: filter.$or }, { $or: scopeCond.$or }]);
      delete filter.$or;
    } else {
      filter.$or = scopeCond.$or;
    }
  } else {
    Object.assign(filter, scopeCond);
  }

  return filter;
}

function getTenantMatch(req, moduleName) {
  let match = {};
  if (req && req.activeProfileId) {
    match.profile = new mongoose.Types.ObjectId(String(req.activeProfileId));
  } else {
    const companyId = req?.companyId || req?.user?._id;
    if (companyId) {
      match.user = new mongoose.Types.ObjectId(String(companyId));
    }
  }

  const scopeCond = getDataScopeCondition(req, moduleName, true);
  if (scopeCond.$or) {
    if (match.$or) {
      match.$and = (match.$and || []).concat([{ $or: match.$or }, { $or: scopeCond.$or }]);
      delete match.$or;
    } else {
      match.$or = scopeCond.$or;
    }
  } else {
    Object.assign(match, scopeCond);
  }

  return match;
}

function attachTenant(req, payload = {}) {
  const companyId = req?.companyId || req?.user?._id;
  const { sanitizePayload } = require('./sanitizePayload');
  
  // 1. Strip dangerous mass-assignment fields from payload
  const res = sanitizePayload(payload);

  // 2. Force user and profile from request context - never accept from body
  if (companyId) {
    res.user = companyId;
  }
  if (req?.activeProfileId) {
    res.profile = req.activeProfileId;
  }
  if (req?.user?._id) {
    res.createdBy = req.user._id;
    res.updatedBy = req.user._id;
  }
  return res;
}

/**
 * Enforce RBAC Data Scope on write operations (create and update).
 * Validates that any businessUnit or client in payload falls within user's assigned scopes.
 * For 'own' scope, strictly forces createdBy/updatedBy to the acting user.
 *
 * @param {Object} req - Express request object
 * @param {string} moduleName - Module identifier (e.g. 'expenses', 'invoices', 'projects')
 * @param {Object} payload - Body payload for create/update
 * @throws {Error} with status 403 if write violates user scope
 */
function assertWriteWithinScope(req, moduleName, payload = {}) {
  if (!req?.user) return payload;
  // Account Owner and Superadmin always have unrestricted write access
  if (isCompanyOwner(req) || req.isSharedAccess) {
    return payload;
  }

  const mod = resolveModuleName(req, moduleName);
  if (!mod) {
    const error = new Error('Access denied: Unresolved module');
    error.status = 403;
    error.statusCode = 403;
    throw error;
  }

  const perm = req.permissions?.get ? req.permissions.get(mod) : req.permissions?.[mod];
  const AccessRole = require('../models/AccessRole');
  const supportedScopes = AccessRole.MODULE_SCOPE_SUPPORT?.[mod] || ['all', 'own'];
  let dataScope = perm?.dataScope || 'all';
  if (!supportedScopes.includes(dataScope)) {
    dataScope = supportedScopes.includes('own') ? 'own' : 'all';
  }

  // 1. 'own' scope: force createdBy and updatedBy
  if (dataScope === 'own') {
    payload.createdBy = req.user._id;
    payload.updatedBy = req.user._id;
  }

  // 2. 'businessUnit' scope enforcement
  if (dataScope === 'businessUnit') {
    const assignedBUs = (req.user.assignedBusinessUnits || []).map(String);
    const targetBU = payload.businessUnit?._id || payload.businessUnit;

    if (mod === 'businessUnits' && req.params?.id) {
      if (!assignedBUs.includes(String(req.params.id))) {
        const error = new Error('Forbidden: You are not authorized to modify business units outside your assigned units');
        error.status = 403;
        error.statusCode = 403;
        throw error;
      }
    } else if (targetBU) {
      if (!assignedBUs.includes(String(targetBU))) {
        const error = new Error('Forbidden: Selected business unit is outside your assigned business units');
        error.status = 403;
        error.statusCode = 403;
        throw error;
      }
    } else if (assignedBUs.length > 0 && !targetBU) {
      payload.businessUnit = assignedBUs[0];
    }
  }

  // 3. 'client' scope enforcement
  if (dataScope === 'client') {
    const assignedClients = (req.user.assignedClients || []).map(String);
    const targetClient = payload.client?.clientRef || payload.client?._id || payload.client || payload.clientRef;

    if (mod === 'clients' && req.params?.id) {
      if (!assignedClients.includes(String(req.params.id))) {
        const error = new Error('Forbidden: You are not authorized to modify clients outside your assigned clients');
        error.status = 403;
        error.statusCode = 403;
        throw error;
      }
    } else if (targetClient) {
      if (!assignedClients.includes(String(targetClient))) {
        const error = new Error('Forbidden: Selected client is outside your assigned clients');
        error.status = 403;
        error.statusCode = 403;
        throw error;
      }
    } else if (assignedClients.length > 0 && !targetClient && mod !== 'clients') {
      const error = new Error('Forbidden: A client belonging to your assigned clients is required');
      error.status = 403;
      error.statusCode = 403;
      throw error;
    }
  }

  return payload;
}

module.exports = {
  getTenantFilter,
  getTenantMatch,
  attachTenant,
  getDataScopeCondition,
  assertWriteWithinScope,
  URL_TO_MODULE,
};
