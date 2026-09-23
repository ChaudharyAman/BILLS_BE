/**
 * MBB/utils/tenantHelper.js
 * 
 * Tenancy scoping helper for Multi-Client Profiles.
 * Prioritizes req.activeProfileId; falls back to req.companyId / req.user._id for backward compatibility.
 */

const mongoose = require('mongoose');

function getTenantFilter(req) {
  if (req && req.activeProfileId) {
    return { profile: req.activeProfileId };
  }
  const companyId = req?.companyId || req?.user?._id;
  return companyId ? { user: companyId } : {};
}

function getTenantMatch(req) {
  if (req && req.activeProfileId) {
    return { profile: new mongoose.Types.ObjectId(String(req.activeProfileId)) };
  }
  const companyId = req?.companyId || req?.user?._id;
  return companyId ? { user: new mongoose.Types.ObjectId(String(companyId)) } : {};
}

function attachTenant(req, payload = {}) {
  const companyId = req?.companyId || req?.user?._id;
  const res = { ...payload };
  if (companyId && res.user === undefined) {
    res.user = companyId;
  }
  if (req?.activeProfileId && res.profile === undefined) {
    res.profile = req.activeProfileId;
  }
  return res;
}

module.exports = {
  getTenantFilter,
  getTenantMatch,
  attachTenant,
};

