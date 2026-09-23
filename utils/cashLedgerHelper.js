const mongoose = require('mongoose');
const CashAccount = require('../models/CashAccount');
const CashLedgerEntry = require('../models/CashLedgerEntry');

const roundTwo = (num) => Math.round((Number(num) || 0) * 100) / 100;

function parseUserAndProfile(userIdOrScope) {
  if (!userIdOrScope) return { user: null, profile: null };

  if (
    userIdOrScope instanceof mongoose.Types.ObjectId ||
    typeof userIdOrScope === 'string' ||
    userIdOrScope._bsontype === 'ObjectID' ||
    userIdOrScope._bsontype === 'ObjectId'
  ) {
    return { user: new mongoose.Types.ObjectId(String(userIdOrScope)), profile: null };
  }

  const raw = userIdOrScope.filter || userIdOrScope;
  const user = raw.user || userIdOrScope.user || userIdOrScope.companyId;
  const profile = raw.profile || userIdOrScope.profile || userIdOrScope.activeProfileId;

  return {
    user: user ? new mongoose.Types.ObjectId(String(user)) : null,
    profile: profile ? new mongoose.Types.ObjectId(String(profile)) : null,
  };
}

/**
 * Ensures a default CashAccount exists for the specified company/user/profile.
 */
async function getOrCreateDefaultCashAccount(userIdOrScope) {
  const { user: userObjectId, profile: profileObjectId } = parseUserAndProfile(userIdOrScope);

  const query = profileObjectId
    ? { profile: profileObjectId }
    : (userObjectId ? { user: userObjectId } : {});

  let account = await CashAccount.findOne({
    ...query,
    isDefault: true,
    isDeleted: { $ne: true },
  });

  if (!account) {
    account = await CashAccount.findOne({
      ...query,
      isDeleted: { $ne: true },
    }).sort({ createdAt: 1 });
  }

  if (!account && (userObjectId || profileObjectId)) {
    account = await CashAccount.create({
      user: userObjectId || profileObjectId,
      ...(profileObjectId ? { profile: profileObjectId } : {}),
      name: 'Main Cash Account',
      accountType: 'cash',
      openingBalance: 0,
      openingBalanceDate: new Date(0),
      currentBalance: 0,
      isDefault: true,
    });
  }

  return account;
}

/**
 * Computes the total running cash balance as of a given date across all active accounts.
 */
async function getCashBalanceAsOf(userIdOrScope, asOfDate = new Date()) {
  const { user: userObjectId, profile: profileObjectId } = parseUserAndProfile(userIdOrScope);
  const filter = profileObjectId
    ? { profile: profileObjectId }
    : (userObjectId ? { user: userObjectId } : {});
  const matchFilter = profileObjectId
    ? { profile: profileObjectId }
    : (userObjectId ? { user: userObjectId } : {});
  const dateLimit = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);

  const accounts = await CashAccount.find({
    ...filter,
    status: 'active',
    isDeleted: { $ne: true },
  }).lean();

  if (!accounts.length) {
    return {
      totalCash: 0,
      accountIds: [],
      accounts: [],
    };
  }

  const accountIds = accounts.map(a => a._id);

  // Aggregate signed ledger entries up to asOfDate
  const ledgerSums = await CashLedgerEntry.aggregate([
    {
      $match: {
        ...matchFilter,
        account: { $in: accountIds },
        date: { $lte: dateLimit },
        isDeleted: { $ne: true },
      },
    },
    {
      $group: {
        _id: '$account',
        totalMovement: { $sum: '$amount' },
      },
    },
  ]);

  const movementMap = new Map(ledgerSums.map(l => [String(l._id), l.totalMovement]));

  let totalCash = 0;
  const accountsWithBalance = accounts.map(acc => {
    const hasOpeningDate = acc.openingBalanceDate && !isNaN(new Date(acc.openingBalanceDate).getTime());
    const isOpeningEffective = hasOpeningDate ? new Date(acc.openingBalanceDate) <= dateLimit : true;
    const opening = isOpeningEffective ? (Number(acc.openingBalance) || 0) : 0;
    const movement = movementMap.get(String(acc._id)) || 0;
    const balance = roundTwo(opening + movement);
    totalCash += balance;
    return {
      _id: acc._id,
      name: acc.name,
      accountType: acc.accountType,
      balance,
    };
  });

  return {
    totalCash: roundTwo(totalCash),
    accountIds: accountIds.map(String),
    accounts: accountsWithBalance,
  };
}

/**
 * Posts a signed CashLedgerEntry and updates the CashAccount's currentBalance.
 */
async function recordCashMovement({
  user,
  profile,
  account,
  date = new Date(),
  amount,
  type,
  sourceModel = 'Manual',
  sourceId = null,
  createdBy = null,
  notes = '',
  session = null,
}) {
  const userObjectId = user ? new mongoose.Types.ObjectId(String(user)) : null;
  const profileObjectId = profile ? new mongoose.Types.ObjectId(String(profile)) : null;
  let targetAccount = account;

  if (!targetAccount) {
    targetAccount = await getOrCreateDefaultCashAccount(profileObjectId ? { profile: profileObjectId, user: userObjectId } : userObjectId);
  }

  const accountId = targetAccount._id ? targetAccount._id : targetAccount;
  const entryDate = date ? new Date(date) : new Date();
  const signedAmount = roundTwo(amount);
  const sessionOpt = session ? { session } : {};

  const docToCreate = {
    user: userObjectId,
    account: accountId,
    date: entryDate,
    amount: signedAmount,
    type,
    sourceModel,
    sourceId,
    createdBy,
    notes,
  };
  if (profileObjectId) {
    docToCreate.profile = profileObjectId;
  }

  const createdDocs = await CashLedgerEntry.create([docToCreate], sessionOpt);

  const entry = Array.isArray(createdDocs) ? createdDocs[0] : createdDocs;

  await CashAccount.findByIdAndUpdate(accountId, {
    $inc: { currentBalance: signedAmount },
  }, sessionOpt);

  return entry;
}

module.exports = {
  roundTwo,
  getOrCreateDefaultCashAccount,
  getCashBalanceAsOf,
  recordCashMovement,
};
