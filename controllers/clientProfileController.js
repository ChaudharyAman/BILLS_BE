const ClientProfile = require('../models/ClientProfile');
const Settings = require('../models/Settings');
const AccessRole = require('../models/AccessRole');
const { getAccessibleProfilesForUser } = require('../services/profileAccessService');

const MAX_PROFILES_FREE = 1;

/**
 * List all accessible profiles for the current user (owned, team, shared)
 */
exports.getMyProfiles = async (req, res) => {
  try {
    if (req.isShareToken && req.shareSession?.profile) {
      const p = req.shareSession.profile;
      const item = {
        _id: p._id,
        profileId: p._id,
        name: p.name,
        code: p.code,
        clientTag: p.clientTag || '',
        color: p.color || '#2563eb',
        logoUrl: p.logoUrl || '',
        status: p.status,
        isDefault: true,
        source: 'shared_link',
        viewOnly: true,
        shareRules: req.shareSession.rules,
        shareId: req.shareSession.shareId,
      };
      return res.json({
        profiles: [item],
        activeProfileId: p._id,
      });
    }

    const accessible = await getAccessibleProfilesForUser(req.user);
    const activeProfileId = req.activeProfileId || req.headers['x-profile-id'] || (accessible.find(a => a.isDefault)?.profileId) || (accessible[0]?.profileId) || null;

    res.json({
      profiles: accessible,
      activeProfileId,
    });
  } catch (error) {
    console.error('getMyProfiles error:', error.message);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Create a new ClientProfile
 */
exports.createProfile = async (req, res) => {
  try {
    const ownerId = req.user.isOwner || !req.user.companyId ? req.user._id : req.user.companyId;

    // Plan-limit check
    const isOwner = Boolean(req.user.isOwner) || !req.user.companyId;
    if (!isOwner) {
      return res.status(403).json({ message: 'Only account owners can create new client profiles.' });
    }

    const isPro = (req.ownerUser?.subscription?.plan === 'pro' && req.ownerUser?.subscription?.status === 'active') || req.user?.role === 'superadmin';

    const currentProfilesCount = await ClientProfile.countDocuments({ owner: ownerId, status: { $ne: 'deleted' } });
    if (!isPro && currentProfilesCount >= MAX_PROFILES_FREE) {
      return res.status(403).json({
        message: `Free plan is limited to ${MAX_PROFILES_FREE} client profile. Upgrade to Pro for unlimited client profiles.`,
        upgradeRequired: true,
      });
    }

    const { name, code, clientTag, color, logoUrl } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ message: 'Profile name is required' });
    }

    // Generate or format code
    let formattedCode = (code || name.slice(0, 4)).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!formattedCode) formattedCode = 'PROF';

    // Ensure code uniqueness for this owner
    let uniqueCode = formattedCode;
    let codeConflict = await ClientProfile.findOne({ owner: ownerId, code: uniqueCode });
    let counter = 1;
    while (codeConflict) {
      uniqueCode = `${formattedCode}${counter++}`;
      codeConflict = await ClientProfile.findOne({ owner: ownerId, code: uniqueCode });
    }

    const isFirstProfile = (currentProfilesCount === 0);

    let newProfile = null;
    try {
      newProfile = await ClientProfile.create({
        owner: ownerId,
        name: name.trim(),
        code: uniqueCode,
        clientTag: clientTag ? String(clientTag).trim() : '',
        color: color || '#2563eb',
        logoUrl: logoUrl || '',
        isDefault: isFirstProfile,
        status: 'active',
      });

      // 1. Auto-seed Settings for this profile (inherit company details or sensible defaults)
      const existingSettings = await Settings.findOne({ user: ownerId }).lean();
      await Settings.findOneAndUpdate(
        { profile: newProfile._id },
        {
          $setOnInsert: {
            user: ownerId,
            profile: newProfile._id,
            companyName: name.trim(),
            email: existingSettings?.email || req.user.email,
            phone: existingSettings?.phone || '',
            address: existingSettings?.address || {},
            currency: existingSettings?.currency || 'INR',
            timezone: existingSettings?.timezone || 'Asia/Kolkata',
            invoicePrefix: `${uniqueCode}-INV`,
            quotePrefix: `${uniqueCode}-QT`,
            proformaPrefix: `${uniqueCode}-PRF`,
            purchaseOrderPrefix: `${uniqueCode}-PO`,
          }
        },
        { upsert: true, new: true }
      );

      // 2. Auto-seed AccessRole system roles for this profile
      const defaultRoles = AccessRole.getDefaultSystemRoles(ownerId, newProfile._id);
      await AccessRole.insertMany(defaultRoles);

      res.status(201).json(newProfile);
    } catch (seedErr) {
      if (newProfile?._id) {
        await ClientProfile.findByIdAndDelete(newProfile._id).catch(() => {});
        await Settings.deleteMany({ profile: newProfile._id }).catch(() => {});
        await AccessRole.deleteMany({ profile: newProfile._id }).catch(() => {});
      }
      throw seedErr;
    }
  } catch (error) {
    console.error('createProfile error:', error.message);
    if (error.code === 11000) {
      return res.status(400).json({ message: 'A profile with this name or code already exists for this account.' });
    }
    res.status(500).json({ message: error.message });
  }
};

/**
 * Update an existing ClientProfile
 */
exports.updateProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = req.user.isOwner || !req.user.companyId ? req.user._id : req.user.companyId;

    const profile = await ClientProfile.findOne({ _id: id, owner: ownerId });
    if (!profile) {
      return res.status(404).json({ message: 'Client profile not found or not owned by you.' });
    }

    const { name, clientTag, color, logoUrl, status } = req.body;
    if (name !== undefined) profile.name = String(name).trim();
    if (clientTag !== undefined) profile.clientTag = String(clientTag).trim();
    if (color !== undefined) profile.color = String(color).trim();
    if (logoUrl !== undefined) profile.logoUrl = String(logoUrl).trim();
    if (status !== undefined && ['active', 'archived'].includes(status)) {
      if (status === 'archived') {
        if (profile.isDefault) {
          return res.status(400).json({ message: 'Default profile cannot be archived.' });
        }
        const activeCount = await ClientProfile.countDocuments({ owner: ownerId, status: 'active', isDeleted: { $ne: true } });
        if (activeCount <= 1) {
          return res.status(400).json({ message: 'Cannot archive the only active profile in your account.' });
        }
      }
      profile.status = status;
    }

    const saved = await profile.save();
    res.json(saved);
  } catch (error) {
    console.error('updateProfile error:', error.message);
    if (error.code === 11000) {
      return res.status(400).json({ message: 'A profile with this name already exists for this account.' });
    }
    res.status(500).json({ message: error.message });
  }
};

/**
 * Soft-delete a ClientProfile (owner only, not allowed if default or last active profile)
 */
exports.deleteProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = req.user.isOwner || !req.user.companyId ? req.user._id : req.user.companyId;

    const profile = await ClientProfile.findOne({ _id: id, owner: ownerId });
    if (!profile) {
      return res.status(404).json({ message: 'Client profile not found.' });
    }

    if (profile.isDefault) {
      return res.status(400).json({ message: 'Default profile cannot be deleted. Please set another profile as default first.' });
    }

    // Only block deletion if the profile being deleted is active and it's the last active one
    if (profile.status === 'active') {
      const activeCount = await ClientProfile.countDocuments({ owner: ownerId, status: 'active', isDeleted: { $ne: true } });
      if (activeCount <= 1) {
        return res.status(400).json({ message: 'Cannot delete the only active profile in your account.' });
      }
    }

    profile.status = 'archived';
    profile.isDeleted = true;
    profile.deletedAt = new Date();

    // Suffix unique name and code so they can be reused if needed
    if (profile.name && !profile.name.includes('_del_')) {
      profile.name = `${profile.name}_del_${Date.now()}`;
    }
    if (profile.code && !profile.code.includes('_del_')) {
      profile.code = `${profile.code}_DEL_${Date.now().toString().slice(-4)}`;
    }

    await profile.save();

    res.json({ message: 'Profile deleted successfully' });
  } catch (error) {
    console.error('deleteProfile error:', error.message);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Set a ClientProfile as default
 */
exports.setDefaultProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = req.user.isOwner || !req.user.companyId ? req.user._id : req.user.companyId;

    const targetProfile = await ClientProfile.findOne({ _id: id, owner: ownerId, status: 'active' });
    if (!targetProfile) {
      return res.status(404).json({ message: 'Active profile not found.' });
    }

    await ClientProfile.updateMany({ owner: ownerId }, { $set: { isDefault: false } });
    targetProfile.isDefault = true;
    await targetProfile.save();

    res.json({ message: 'Default profile updated', profile: targetProfile });
  } catch (error) {
    console.error('setDefaultProfile error:', error.message);
    res.status(500).json({ message: error.message });
  }
};
