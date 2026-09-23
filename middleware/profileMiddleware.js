const AccessRole = require('../models/AccessRole');
const ClientProfile = require('../models/ClientProfile');
const { getAccessibleProfilesForUser } = require('../services/profileAccessService');

/**
 * Middleware running after protect that resolves the active ClientProfile for the request.
 * Sets:
 * - req.activeProfileId: ObjectId of active profile
 * - req.activeProfile: ClientProfile document
 * - req.profileAccessSource: 'owner' | 'team' | 'share'
 * - req.isSharedViewOnly: boolean (true when source === 'share')
 * - req.shareRules: rules object or null
 * - req.accessibleProfiles: array of profiles user can access
 * 
 * When req.isSharedViewOnly is true, rewrites req.permissions into a forced view-only map
 * where only 'view' is true for permitted modules, and create/edit/delete/approve are unconditionally false.
 */
const normalizeModuleList = (rawModules) => {
  const set = new Set();
  if (!Array.isArray(rawModules) || rawModules.length === 0) {
    return new Set(AccessRole.SYSTEM_MODULES);
  }
  for (const m of rawModules) {
    set.add(m);
    if (m === 'incomes') set.add('income');
    if (m === 'income') set.add('incomes');
    if (m === 'financialReports') set.add('reports');
    if (m === 'reports') set.add('financialReports');
  }
  return set;
};

const buildSharedPermissionsMap = (rules = {}) => {
  const rawModules = rules?.modules || [];
  const accessLevel = rules?.accessLevel || 'VIEW_ONLY';
  const modulePerms = rules?.modulePermissions && typeof rules.modulePermissions.get === 'function'
    ? Object.fromEntries(rules.modulePermissions)
    : (rules?.modulePermissions || {});

  const allowedModules = normalizeModuleList(rawModules);
  const permsMap = new Map();

  for (const mod of AccessRole.SYSTEM_MODULES) {
    const visible = allowedModules.has(mod);
    const isModuleEditable = accessLevel === 'CAN_EDIT' && modulePerms[mod] !== 'view';

    permsMap.set(mod, {
      view: visible,
      create: visible && isModuleEditable,
      edit: visible && isModuleEditable,
      delete: false, // Safely disallow deletion in public/invited shares
      approve: false,
      enabled: visible,
    });
  }

  // Ensure common aliases are also explicitly keyed in the map
  if (allowedModules.has('income') || allowedModules.has('incomes')) {
    const isIncomeEditable = accessLevel === 'CAN_EDIT' && modulePerms['incomes'] !== 'view' && modulePerms['income'] !== 'view';
    permsMap.set('incomes', { view: true, create: isIncomeEditable, edit: isIncomeEditable, delete: false, approve: false, enabled: true });
    permsMap.set('income', { view: true, create: isIncomeEditable, edit: isIncomeEditable, delete: false, approve: false, enabled: true });
  }
  if (allowedModules.has('reports') || allowedModules.has('financialReports')) {
    const isReportEditable = accessLevel === 'CAN_EDIT' && modulePerms['financialReports'] === 'edit' && modulePerms['reports'] === 'edit';
    permsMap.set('financialReports', { view: true, create: isReportEditable, edit: isReportEditable, delete: false, approve: false, enabled: true });
    permsMap.set('reports', { view: true, create: isReportEditable, edit: isReportEditable, delete: false, approve: false, enabled: true });
  }

  // 'settings' is always read-only in shared sessions for branding/logo/company info on documents
  permsMap.set('settings', { view: true, create: false, edit: false, delete: false, approve: false, enabled: true });

  return permsMap;
};

const resolveActiveProfile = async (req, res, next) => {
  try {
    // Case 1: Special scoped JWT for public share link
    if (req.isShareToken && req.shareSession) {
      const { profileId, profile, rules } = req.shareSession;
      req.activeProfileId = profileId;
      req.activeProfile = profile;
      req.profileAccessSource = 'share';
      req.isSharedAccess = true;
      req.shareRules = rules || { modules: [], hiddenFields: [], accessLevel: 'VIEW_ONLY' };
      const accessLevel = req.shareRules.accessLevel || 'VIEW_ONLY';
      req.shareAccessLevel = accessLevel;
      req.isSharedViewOnly = (accessLevel === 'VIEW_ONLY');

      // Overwrite permissions map based on access level
      req.permissions = buildSharedPermissionsMap(req.shareRules);
      return next();
    }

    if (!req.user) {
      return res.status(401).json({ message: 'Not authorized, no user context' });
    }

    // 1. Read requested profile id from header
    const requestedProfileId = req.headers['x-profile-id'];

    // 2. Fetch accessible profiles
    const accessible = await getAccessibleProfilesForUser(req.user);

    if (accessible.length === 0) {
      // If user has no profile yet (e.g. before migration runs), create an automatic default profile for them on the fly
      if (req.user.isOwner || !req.user.companyId) {
        const companyName = req.user.username || 'My Company';
        const code = companyName.slice(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'COMP';
        let defaultProfile = await ClientProfile.findOne({ owner: req.user._id, isDefault: true });
        if (!defaultProfile) {
          defaultProfile = await ClientProfile.create({
            owner: req.user._id,
            name: companyName,
            code: `${code}-${Date.now().toString().slice(-4)}`,
            isDefault: true,
            status: 'active',
          });
        }
        accessible.push({
          profileId: defaultProfile._id,
          name: defaultProfile.name,
          code: defaultProfile.code,
          color: defaultProfile.color,
          status: defaultProfile.status,
          isDefault: true,
          owner: defaultProfile.owner,
          source: 'owner',
          viewOnly: false,
          shareRules: null,
          shareId: null,
        });
      } else {
        return res.status(403).json({ message: 'No client profile is accessible for this account.' });
      }
    }

    // 3. Match active profile
    let active = null;
    if (requestedProfileId) {
      active = accessible.find(a => String(a.profileId) === String(requestedProfileId));
    }
    if (!active) {
      active = accessible.find(a => a.isDefault) || accessible[0];
    }

    if (!active) {
      return res.status(403).json({ message: 'You do not have access to the requested profile.' });
    }

    req.activeProfileId = active.profileId;
    req.profileAccessSource = active.source; // 'owner' | 'team' | 'share'
    req.shareRules = active.shareRules || null;
    const accessLevel = req.shareRules?.accessLevel || (active.viewOnly ? 'VIEW_ONLY' : 'CAN_EDIT') || 'VIEW_ONLY';
    req.shareAccessLevel = accessLevel;
    req.isSharedAccess = (active.source === 'share');
    req.isSharedViewOnly = (active.source === 'share' && accessLevel === 'VIEW_ONLY');
    req.accessibleProfiles = accessible;

    // Load full active profile document if needed
    req.activeProfile = await ClientProfile.findById(active.profileId).lean();

    // 4. If shared session, overwrite req.permissions centrally
    if (active.source === 'share') {
      req.permissions = buildSharedPermissionsMap(req.shareRules);
    } else if (active.source === 'team' && Array.isArray(req.user.profileAccess)) {
      // 5. If team member, resolve permissions specific to this profileAccess entry
      const pEntry = req.user.profileAccess.find(pa => String(pa.profile) === String(active.profileId));
      if (pEntry && pEntry.accessRole) {
        const role = await AccessRole.findById(pEntry.accessRole).lean();
        if (role && role.permissions) {
          const roleMap = new Map();
          const raw = role.permissions;
          for (const mod of AccessRole.SYSTEM_MODULES) {
            const modPerm = raw.get ? raw.get(mod) : raw[mod];
            if (modPerm) {
              roleMap.set(mod, {
                view: Boolean(modPerm.view),
                create: Boolean(modPerm.create),
                edit: Boolean(modPerm.edit),
                delete: Boolean(modPerm.delete),
                approve: Boolean(modPerm.approve),
                enabled: true,
              });
            } else {
              roleMap.set(mod, { view: false, create: false, edit: false, delete: false, approve: false, enabled: false });
            }
          }
          req.permissions = roleMap;
        }
      }
    }

    next();
  } catch (error) {
    console.error('resolveActiveProfile error:', error.message);
    return res.status(500).json({ message: 'Internal error resolving client profile' });
  }
};

module.exports = {
  resolveActiveProfile,
};
