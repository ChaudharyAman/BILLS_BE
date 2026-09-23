const ClientProfile = require('../models/ClientProfile');
const ProfileShare = require('../models/ProfileShare');

/**
 * Returns the list of ClientProfiles a user has access to, annotated with access source and rules.
 * @param {Object} user - Mongoose User document or plain user object
 * @returns {Promise<Array<{profileId, name, code, color, logoUrl, status, isDefault, owner, source, viewOnly, shareRules, shareId}>>}
 */
async function getAccessibleProfilesForUser(user) {
  if (!user) return [];

  const accessible = [];
  const profileIdMap = new Map();

  const isAccountOwner = Boolean(user.isOwner) || !user.companyId;

  // 1. Owned Profiles
  if (isAccountOwner) {
    const ownedProfiles = await ClientProfile.find({ owner: user._id, status: { $ne: 'deleted' } }).lean();
    for (const p of ownedProfiles) {
      const item = {
        _id: p._id,
        profileId: p._id,
        name: p.name,
        code: p.code,
        clientTag: p.clientTag || '',
        color: p.color || '#2563eb',
        logoUrl: p.logoUrl || '',
        status: p.status,
        isDefault: Boolean(p.isDefault),
        owner: p.owner,
        source: 'owner',
        viewOnly: false,
        shareRules: null,
        shareId: null,
      };
      accessible.push(item);
      profileIdMap.set(String(p._id), item);
    }
  }

  // 2. Team Member Access via User.profileAccess
  if (Array.isArray(user.profileAccess) && user.profileAccess.length > 0) {
    const accessIds = user.profileAccess.map(pa => pa.profile).filter(Boolean);
    if (accessIds.length > 0) {
      const teamProfiles = await ClientProfile.find({ _id: { $in: accessIds }, status: { $ne: 'deleted' } }).lean();
      for (const p of teamProfiles) {
        if (!profileIdMap.has(String(p._id))) {
          const item = {
            profileId: p._id,
            name: p.name,
            code: p.code,
            clientTag: p.clientTag || '',
            color: p.color || '#2563eb',
            logoUrl: p.logoUrl || '',
            status: p.status,
            isDefault: Boolean(p.isDefault),
            owner: p.owner,
            source: 'team',
            viewOnly: false,
            shareRules: null,
            shareId: null,
          };
          accessible.push(item);
          profileIdMap.set(String(p._id), item);
        }
      }
    }
  } else if (!isAccountOwner && user.companyId) {
    // Fallback: if existing team member doesn't have profileAccess populated yet, grant access to the owner's default profile
    const ownerProfiles = await ClientProfile.find({ owner: user.companyId, status: { $ne: 'deleted' } }).lean();
    const defaultProfile = ownerProfiles.find(p => p.isDefault) || ownerProfiles[0];
    if (defaultProfile && !profileIdMap.has(String(defaultProfile._id))) {
      const item = {
        _id: defaultProfile._id,
        profileId: defaultProfile._id,
        name: defaultProfile.name,
        code: defaultProfile.code,
        clientTag: defaultProfile.clientTag || '',
        color: defaultProfile.color || '#2563eb',
        logoUrl: defaultProfile.logoUrl || '',
        status: defaultProfile.status,
        isDefault: Boolean(defaultProfile.isDefault),
        owner: defaultProfile.owner,
        source: 'team',
        viewOnly: false,
        shareRules: null,
        shareId: null,
      };
      accessible.push(item);
      profileIdMap.set(String(defaultProfile._id), item);
    }
  }

  // 3. Profiles Shared with this User (USER_INVITE)
  const now = new Date();
  const shareConditions = [
    { sharedWithUser: user._id },
  ];
  if (user.email) {
    shareConditions.push({ sharedWithEmail: String(user.email).trim().toLowerCase() });
  }

  const shares = await ProfileShare.find({
    shareType: 'USER_INVITE',
    status: 'active',
    $or: shareConditions,
    $and: [
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }
    ]
  }).populate('profile').lean();

  for (const share of shares) {
    const p = share.profile;
    if (p && p.status !== 'deleted') {
      const pidStr = String(p._id);
      // Only attach as share if the user isn't already the direct owner
      if (!profileIdMap.has(pidStr)) {
        const item = {
          _id: p._id,
          profileId: p._id,
          name: p.name,
          code: p.code,
          clientTag: p.clientTag || '',
          color: p.color || '#2563eb',
          logoUrl: p.logoUrl || '',
          status: p.status,
          isDefault: false,
          owner: p.owner,
          source: 'share',
          viewOnly: share.rules?.accessLevel !== 'CAN_EDIT',
          accessLevel: share.rules?.accessLevel || 'VIEW_ONLY',
          shareRules: share.rules || {},
          shareId: share._id,
        };
        accessible.push(item);
        profileIdMap.set(pidStr, item);
      }
    }
  }

  return accessible;
}

module.exports = {
  getAccessibleProfilesForUser,
};
