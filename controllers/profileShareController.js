const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ProfileShare = require('../models/ProfileShare');
const ClientProfile = require('../models/ClientProfile');
const User = require('../models/User');
const Settings = require('../models/Settings');
const mailService = require('../utils/mailService');

const DEFAULT_HIDDEN_FIELDS = [
  'settings.bankDetails',
  'bankDetails',
  'monthlyCTC',
  'employees.*.monthlyCTC',
  'pan',
  'gstin',
  'default_tds_rate',
  'tds_default_rate'
];

/**
 * List all shares for a given profile
 */
exports.getShares = async (req, res) => {
  try {
    const { profileId } = req.params;

    const shares = await ProfileShare.find({ profile: profileId })
      .populate('sharedWithUser', 'username email avatar')
      .populate('createdBy', 'username email')
      .sort({ createdAt: -1 })
      .lean();

    // Strip sensitive IP addresses from access log and expose hasPasscode flag
    const sanitized = shares.map(share => {
      const hasPasscode = Boolean(share.passcodeHash);
      const { passcodeHash, ...rest } = share;
      return {
        ...rest,
        hasPasscode,
        accessLog: (share.accessLog || []).map(log => ({
          at: log.at,
          userId: log.userId,
        })),
      };
    });

    res.json(sanitized);
  } catch (error) {
    console.error('getShares error:', error.message);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Create a new ProfileShare (USER_INVITE or PUBLIC_LINK)
 */
exports.createShare = async (req, res) => {
  try {
    const { profileId } = req.params;
    const { shareType, email, rules = {}, expiresAt, passcode } = req.body;

    if (!['USER_INVITE', 'PUBLIC_LINK'].includes(shareType)) {
      return res.status(400).json({ message: 'Invalid shareType. Must be USER_INVITE or PUBLIC_LINK.' });
    }

    const profile = await ClientProfile.findById(profileId);
    if (!profile) {
      return res.status(404).json({ message: 'Client profile not found' });
    }

    // Prepare default rules
    const shareRules = {
      accessLevel: rules.accessLevel === 'CAN_EDIT' ? 'CAN_EDIT' : 'VIEW_ONLY',
      modules: Array.isArray(rules.modules) ? rules.modules : [],
      modulePermissions: (rules.modulePermissions && typeof rules.modulePermissions === 'object')
        ? rules.modulePermissions
        : {},
      hiddenFields: Array.isArray(rules.hiddenFields) && rules.hiddenFields.length > 0
        ? rules.hiddenFields
        : DEFAULT_HIDDEN_FIELDS,
      dateRange: {
        from: rules.dateRange?.from || null,
        to: rules.dateRange?.to || null,
      },
      watermarkLabel: rules.watermarkLabel || `Shared View • ${profile.name}`,
      allowPdfDownload: rules.allowPdfDownload !== false,
      allowDataExport: Boolean(rules.allowDataExport), // default false for safety
    };

    let sharedWithUser = null;
    let sharedWithEmail = '';
    let token = null;
    let passcodeHash = null;

    if (shareType === 'USER_INVITE') {
      if (!email || typeof email !== 'string' || !email.includes('@')) {
        return res.status(400).json({ message: 'A valid email is required for user invite shares.' });
      }
      sharedWithEmail = email.trim().toLowerCase();

      // Check if user already exists
      const existingUser = await User.findOne({ email: sharedWithEmail });
      if (existingUser) {
        sharedWithUser = existingUser._id;
      }
    } else if (shareType === 'PUBLIC_LINK') {
      token = crypto.randomBytes(32).toString('hex');
      if (passcode && typeof passcode === 'string' && passcode.trim()) {
        passcodeHash = await bcrypt.hash(passcode.trim(), 10);
      }
    }

    const newShare = await ProfileShare.create({
      profile: profileId,
      createdBy: req.user._id,
      shareType,
      sharedWithUser,
      sharedWithEmail,
      token,
      passcodeHash,
      status: 'active',
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      rules: shareRules,
    });

    const shareUrl = token ? `${process.env.CLIENT_URL || 'http://localhost:5173'}/shared/${token}` : null;

    res.status(201).json({
      _id: newShare._id,
      shareType: newShare.shareType,
      token: newShare.token,
      shareUrl,
      status: newShare.status,
      expiresAt: newShare.expiresAt,
      rules: newShare.rules,
      sharedWithEmail: newShare.sharedWithEmail,
      createdAt: newShare.createdAt,
    });
  } catch (error) {
    console.error('createShare error:', error.message);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Update dynamic rules, expiresAt, or passcode on an existing share
 */
exports.updateShare = async (req, res) => {
  try {
    const { shareId } = req.params;
    const { rules, expiresAt, passcode, status } = req.body;

    const share = await ProfileShare.findById(shareId);
    if (!share) {
      return res.status(404).json({ message: 'Profile share not found' });
    }

    if (status && ['active', 'revoked'].includes(status)) {
      share.status = status;
    }

    if (rules) {
      if (rules.accessLevel && ['VIEW_ONLY', 'CAN_EDIT'].includes(rules.accessLevel)) {
        share.rules.accessLevel = rules.accessLevel;
      }
      if (Array.isArray(rules.modules)) share.rules.modules = rules.modules;
      if (rules.modulePermissions && typeof rules.modulePermissions === 'object') {
        share.rules.modulePermissions = rules.modulePermissions;
      }
      if (Array.isArray(rules.hiddenFields)) share.rules.hiddenFields = rules.hiddenFields;
      if (rules.dateRange) {
        share.rules.dateRange = {
          from: rules.dateRange.from || null,
          to: rules.dateRange.to || null,
        };
      }
      if (rules.watermarkLabel !== undefined) share.rules.watermarkLabel = rules.watermarkLabel;
      if (rules.allowPdfDownload !== undefined) share.rules.allowPdfDownload = Boolean(rules.allowPdfDownload);
      if (rules.allowDataExport !== undefined) share.rules.allowDataExport = Boolean(rules.allowDataExport);
    }

    if (expiresAt !== undefined) {
      share.expiresAt = expiresAt ? new Date(expiresAt) : null;
    }

    if (passcode !== undefined) {
      if (passcode && typeof passcode === 'string' && passcode.trim()) {
        share.passcodeHash = await bcrypt.hash(passcode.trim(), 10);
      } else {
        share.passcodeHash = null;
      }
    }

    const saved = await share.save();
    res.json({
      _id: saved._id,
      shareType: saved.shareType,
      status: saved.status,
      expiresAt: saved.expiresAt,
      rules: saved.rules,
      hasPasscode: Boolean(saved.passcodeHash),
      updatedAt: saved.updatedAt,
    });
  } catch (error) {
    console.error('updateShare error:', error.message);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Revoke an active share immediately
 */
exports.revokeShare = async (req, res) => {
  try {
    const { shareId } = req.params;
    const share = await ProfileShare.findById(shareId);
    if (!share) {
      return res.status(404).json({ message: 'Profile share not found' });
    }

    share.status = 'revoked';
    await share.save();

    res.json({ message: 'Share revoked successfully', status: 'revoked' });
  } catch (error) {
    console.error('revokeShare error:', error.message);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Public resolver endpoint for unauthenticated link viewers
 * GET /api/shared/:token
 */
exports.resolveSharedLink = async (req, res) => {
  try {
    const { token } = req.params;

    const share = await ProfileShare.findOne({ token }).populate('profile');
    if (!share) {
      return res.status(404).json({ message: 'Shared profile link not found or invalid' });
    }

    if (share.status !== 'active') {
      return res.status(410).json({ message: 'This share link has been revoked' });
    }

    if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
      share.status = 'expired';
      await share.save().catch(() => {});
      return res.status(410).json({ message: 'This share link has expired' });
    }

    // Check passcode if protected
    if (share.passcodeHash) {
      const candidate = req.headers['x-share-passcode'] || req.query.passcode;
      if (!candidate) {
        return res.status(401).json({ requiresPasscode: true, message: 'Passcode required to view this profile.' });
      }

      const isMatch = await share.checkPasscode(candidate);
      if (!isMatch) {
        return res.status(401).json({ requiresPasscode: true, message: 'Incorrect passcode entered.' });
      }
    }

    // Record audit log
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    share.accessCount = (share.accessCount || 0) + 1;
    share.lastAccessedAt = new Date();
    share.accessLog.push({
      at: new Date(),
      ip: String(clientIp),
      userId: null,
    });
    // Cap access log length to prevent unbounded growth
    if (share.accessLog.length > 500) {
      share.accessLog = share.accessLog.slice(-500);
    }
    await share.save().catch(() => {});

    // Issue short-lived scoped JWT
    const scopedToken = jwt.sign(
      {
        isShareToken: true,
        shareId: share._id,
        profileId: share.profile._id,
      },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({
      token: scopedToken,
      profile: {
        _id: share.profile._id,
        name: share.profile.name,
        code: share.profile.code,
        color: share.profile.color,
        logoUrl: share.profile.logoUrl,
      },
      rules: share.rules,
      watermark: share.rules.watermarkLabel,
    });
  } catch (error) {
    console.error('resolveSharedLink error:', error.message);
    res.status(500).json({ message: error.message });
  }
};

/**
 * Send share link via email using configured mailer
 */
exports.sendShareEmail = async (req, res) => {
  try {
    const { profileId, shareId } = req.params;
    const { recipientEmail, customSubject, customMessage, includePasscode, passcode, smtpConfigId } = req.body;

    if (!recipientEmail || !recipientEmail.trim()) {
      return res.status(400).json({ message: 'Recipient email is required.' });
    }

    const share = await ProfileShare.findById(shareId).populate('profile');
    if (!share || String(share.profile._id) !== profileId) {
      return res.status(404).json({ message: 'Share link not found.' });
    }

    if (share.status === 'revoked') {
      return res.status(400).json({ message: 'Cannot share a revoked link.' });
    }

    const profile = share.profile;
    const senderName = req.user?.username || req.user?.name || 'A team member';
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const shareUrl = `${clientUrl}/shared/${share.token}`;

    const tenantFilter = req.user?.companyId ? { companyId: req.user.companyId } : { user: req.user?._id };
    const settings = await Settings.findOne(tenantFilter);

    const subject = customSubject?.trim() || `Workspace Access: ${profile.name}`;
    const accessLevelText = share.rules?.accessLevel === 'CAN_EDIT' ? 'Full Edit Access' : 'View Only';
    const expirationText = share.expiresAt ? new Date(share.expiresAt).toLocaleDateString() : 'Never expires';

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px; background-color: #ffffff; color: #1e293b;">
        <div style="border-bottom: 1px solid #f1f5f9; padding-bottom: 16px; margin-bottom: 20px;">
          <h2 style="margin: 0; color: #0f172a; font-size: 20px;">${senderName} shared a workspace with you</h2>
        </div>
        
        <p style="font-size: 14px; line-height: 1.6; color: #475569;">
          You have been granted secure access to the <strong>${profile.name}</strong> workspace.
        </p>

        ${customMessage ? `
          <div style="margin: 16px 0; padding: 14px 18px; background-color: #f8fafc; border-left: 4px solid #3b82f6; border-radius: 6px; font-size: 13px; color: #334155; line-height: 1.5;">
            <em>"${customMessage}"</em>
          </div>
        ` : ''}

        <div style="margin: 20px 0; padding: 16px; background-color: #f1f5f9; border-radius: 12px; font-size: 13px;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 6px 0; color: #64748b; font-weight: 500;">Workspace:</td>
              <td style="padding: 6px 0; font-weight: 600; color: #0f172a;">${profile.name}</td>
            </tr>
            <tr>
              <td style="padding: 6px 0; color: #64748b; font-weight: 500;">Access Level:</td>
              <td style="padding: 6px 0; font-weight: 600; color: #0f172a;">${accessLevelText}</td>
            </tr>
            <tr>
              <td style="padding: 6px 0; color: #64748b; font-weight: 500;">Expiration:</td>
              <td style="padding: 6px 0; font-weight: 600; color: #0f172a;">${expirationText}</td>
            </tr>
            ${includePasscode && passcode ? `
            <tr>
              <td style="padding: 6px 0; color: #64748b; font-weight: 500;">Passcode:</td>
              <td style="padding: 6px 0; font-family: monospace; font-weight: 700; color: #d97706;">${passcode}</td>
            </tr>
            ` : ''}
          </table>
        </div>

        <div style="text-align: center; margin: 30px 0;">
          <a href="${shareUrl}" style="background-color: #2563eb; color: #ffffff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; display: inline-block;">
            Open Shared Workspace
          </a>
        </div>

        <p style="font-size: 12px; color: #94a3b8; word-break: break-all; margin-top: 24px; border-top: 1px solid #f1f5f9; padding-top: 16px;">
          Direct link: <a href="${shareUrl}" style="color: #2563eb;">${shareUrl}</a>
        </p>
      </div>
    `;

    await mailService.sendMail({
      to: recipientEmail.trim(),
      subject,
      html,
      settings,
      overrideConfig: smtpConfigId ? { configId: smtpConfigId } : undefined,
    });

    let senderIdentifier = '';
    if (smtpConfigId && Array.isArray(settings?.smtpConfigs)) {
      const match = settings.smtpConfigs.find(
        (c) => (c._id && c._id.toString() === smtpConfigId.toString()) || c.title === smtpConfigId
      );
      if (match) {
        senderIdentifier = match.fromEmail || match.auth?.user || match.title;
      }
    } else if (settings?.smtp?.fromEmail || settings?.smtp?.auth?.user) {
      senderIdentifier = settings.smtp.fromEmail || settings.smtp.auth?.user;
    }

    const viaText = senderIdentifier ? ` via ${senderIdentifier}` : '';

    return res.json({
      success: true,
      message: `Share link successfully emailed to ${recipientEmail.trim()}${viaText}!`,
    });
  } catch (error) {
    console.error('sendShareEmail error:', error);
    return res.status(500).json({ message: error.message || 'Failed to send share email.' });
  }
};
