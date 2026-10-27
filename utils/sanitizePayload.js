/**
 * MBB/utils/sanitizePayload.js
 * 
 * Mass-assignment protection utility.
 * Strips dangerous internal, tenant-boundary, and audit fields from request bodies.
 */

const mongoose = require('mongoose');

const FORBIDDEN_FIELDS = [
  'user',
  'profile',
  'companyId',
  'createdBy',
  'updatedBy',
  'isDeleted',
  'deletedAt',
  '_id',
  '__v',
  'createdAt',
  'updatedAt',
];

/**
 * Strips forbidden fields from client payloads to prevent mass-assignment attacks.
 * @param {Object|Array} data - Incoming payload or array of payloads
 * @param {Array<string>} extraForbidden - Additional fields to strip
 * @returns {Object|Array} Sanitized copy of data
 */
function sanitizePayload(data, extraForbidden = []) {
  if (!data || typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    return data.map((item) => sanitizePayload(item, extraForbidden));
  }

  const forbiddenSet = new Set([...FORBIDDEN_FIELDS, ...extraForbidden]);
  const sanitized = {};

  for (const [key, value] of Object.entries(data)) {
    if (!forbiddenSet.has(key)) {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Validates that foreign reference IDs in client payloads (client, vendor, department, businessUnit, project)
 * belong strictly to the current tenant / active profile.
 * Throws a 400 error if any reference does not belong to the tenant.
 */
async function validateTenantReferences(payload, req) {
  if (!payload || typeof payload !== 'object' || !req) return;
  const { getTenantFilter } = require('./tenantHelper');
  const tenantFilter = getTenantFilter(req);

  // 1. Client reference
  if (payload.client && mongoose.Types.ObjectId.isValid(payload.client)) {
    const Client = require('../models/Client');
    const exists = await Client.exists({ _id: payload.client, ...tenantFilter });
    if (!exists) {
      const err = new Error('Referenced Client does not exist or does not belong to your organization');
      err.statusCode = 400;
      throw err;
    }
  }

  // 2. Vendor reference (Client collection with isVendor: true)
  if (payload.vendor && mongoose.Types.ObjectId.isValid(payload.vendor)) {
    const Client = require('../models/Client');
    const exists = await Client.exists({ _id: payload.vendor, isVendor: true, ...tenantFilter });
    if (!exists) {
      const err = new Error('Referenced Vendor does not exist or does not belong to your organization');
      err.statusCode = 400;
      throw err;
    }
  }

  // 3. Department reference
  if (payload.department && mongoose.Types.ObjectId.isValid(payload.department)) {
    const Department = require('../models/Department');
    const exists = await Department.exists({ _id: payload.department, ...tenantFilter });
    if (!exists) {
      const err = new Error('Referenced Department does not exist or does not belong to your organization');
      err.statusCode = 400;
      throw err;
    }
  }

  // 4. Business Unit reference
  if (payload.businessUnit && mongoose.Types.ObjectId.isValid(payload.businessUnit)) {
    const BusinessUnit = require('../models/BusinessUnit');
    const exists = await BusinessUnit.exists({ _id: payload.businessUnit, ...tenantFilter });
    if (!exists) {
      const err = new Error('Referenced Business Unit does not exist or does not belong to your organization');
      err.statusCode = 400;
      throw err;
    }
  }

  // 5. Project reference
  if (payload.project && mongoose.Types.ObjectId.isValid(payload.project)) {
    const Project = require('../models/Project');
    const exists = await Project.exists({ _id: payload.project, ...tenantFilter });
    if (!exists) {
      const err = new Error('Referenced Project does not exist or does not belong to your organization');
      err.statusCode = 400;
      throw err;
    }
  }
}

module.exports = {
  FORBIDDEN_FIELDS,
  sanitizePayload,
  validateTenantReferences,
};
