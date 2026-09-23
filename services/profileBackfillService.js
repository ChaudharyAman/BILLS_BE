/**
 * MBB/services/profileBackfillService.js
 *
 * Automatically backfills legacy data created before ClientProfiles were introduced.
 * Any records belonging to the account owner that have no `profile` assigned will be
 * tagged with the owner's default profile ID. This ensures:
 * 1. Default workspace retains 100% of historical records.
 * 2. New or secondary workspaces remain completely clean and isolated.
 */

const mongoose = require('mongoose');

const backfilledOwners = new Set();

async function backfillLegacyProfileData(ownerId, defaultProfileId) {
  if (!ownerId || !defaultProfileId) return;
  const ownerKey = String(ownerId);
  if (backfilledOwners.has(ownerKey)) return;
  backfilledOwners.add(ownerKey);

  try {
    const ownerObjId = mongoose.Types.ObjectId.isValid(String(ownerId))
      ? new mongoose.Types.ObjectId(String(ownerId))
      : ownerId;
    const defaultProfileObjId = mongoose.Types.ObjectId.isValid(String(defaultProfileId))
      ? new mongoose.Types.ObjectId(String(defaultProfileId))
      : defaultProfileId;

    const filter = {
      user: ownerObjId,
      $or: [{ profile: null }, { profile: { $exists: false } }],
    };
    const update = { $set: { profile: defaultProfileObjId } };

    const collections = [
      'invoices',
      'expenses',
      'incomes',
      'assets',
      'budgets',
      'payrolls',
      'employees',
      'loans',
      'reimbursementclaims',
      'liabilities',
      'equitytransactions',
      'purchaseorders',
      'quotes',
      'proformas',
      'items',
      'clients',
      'categories',
      'departments',
      'businessunits',
      'companydocuments',
      'cashledgerentries',
      'bankstatements',
      'cashaccounts',
    ];

    const db = mongoose.connection.db;
    if (!db) return;

    await Promise.allSettled(
      collections.map((name) => db.collection(name).updateMany(filter, update))
    );
  } catch (error) {
    console.error('Error in backfillLegacyProfileData:', error.message);
  }
}

function _resetBackfilledOwnersForTesting() {
  backfilledOwners.clear();
}

module.exports = {
  backfillLegacyProfileData,
  _resetBackfilledOwnersForTesting,
};
