const cloudinary = require('../config/cloudinary');
const fs = require('fs');
const Settings = require('../models/Settings');

// Placeholder shown to the frontend in place of real secret values
const SECRET_MASK = '••••••••';

// Mask secret integration fields so they are never sent to the client
const maskIntegrationSecrets = (settingsDoc) => {
  const obj = settingsDoc.toObject ? settingsDoc.toObject() : { ...settingsDoc };
  if (obj.integration) {
    if (obj.integration.apiKey)           obj.integration.apiKey           = SECRET_MASK;
    if (obj.integration.encryptionSecret) obj.integration.encryptionSecret = SECRET_MASK;
    if (obj.integration.webhookSecret)    obj.integration.webhookSecret    = SECRET_MASK;
  }
  return obj;
};

// Get Settings (Create default if not exists)
exports.getSettings = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
        return res.status(401).json({ message: 'Not authorized' });
    }
    let settings = await Settings.findOne({ user: req.user._id }).populate('user', 'username email phone');
    if (!settings) {
      settings = new Settings({ user: req.user._id });
      await settings.save();
      // Re-fetch to populate after creation
      settings = await Settings.findById(settings._id).populate('user', 'username email phone');
    }
    // Return masked secrets — these are write-only fields
    res.json(maskIntegrationSecrets(settings));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Update Settings
exports.updateSettings = async (req, res) => {
  try {
    if (!req.user || !req.user._id) {
        return res.status(401).json({ message: 'Not authorized' });
    }
    let settings = await Settings.findOne({ user: req.user._id });

    // Handle file uploads (Logo & Signature)
    let newLogoUrl = undefined;
    let newSignatureUrl = undefined;

    if (req.files) {
        // Logo Upload
        if (req.files.logo) {
            try {
                const result = await cloudinary.uploader.upload(req.files.logo[0].path, {
                    folder: 'flance_logos',
                    allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
                });
                newLogoUrl = result.secure_url;
                fs.unlinkSync(req.files.logo[0].path);
            } catch (error) {
                console.error('Logo Upload Error:', error);
                if (fs.existsSync(req.files.logo[0].path)) fs.unlinkSync(req.files.logo[0].path);
            }
        }

        // Signature Upload
        if (req.files.signature) {
            try {
                const result = await cloudinary.uploader.upload(req.files.signature[0].path, {
                    folder: 'flance_signatures',
                    allowed_formats: ['jpg', 'png', 'jpeg', 'webp'],
                });
                newSignatureUrl = result.secure_url;
                fs.unlinkSync(req.files.signature[0].path);
            } catch (error) {
                console.error('Signature Upload Error:', error);
                if (fs.existsSync(req.files.signature[0].path)) fs.unlinkSync(req.files.signature[0].path);
            }
        }
    }

    const { 
      username, loginEmail,
      companyName, contactName, website, email, phone, gstin, pan,
      address, defaultTerms, defaultNotes, bankDetails,
      invoicePrefix, proformaPrefix, quotePrefix, receiptPrefix, expensePrefix, purchaseOrderPrefix,
      defaultCurrency, timezone, dateFormat, integration
    } = req.body;

    // Strip write-only secret placeholders so they are not overwritten with the mask value
    let safeIntegration = integration;
    if (integration && typeof integration === 'object') {
      safeIntegration = { ...integration };
      const secretFields = ['apiKey', 'encryptionSecret', 'webhookSecret'];
      for (const field of secretFields) {
        if (safeIntegration[field] === SECRET_MASK || safeIntegration[field] === '') {
          delete safeIntegration[field]; // leave DB value unchanged
        }
      }
    }

    const settingsUpdate = {
      companyName, contactName, website, email, phone, gstin, pan,
      address, defaultTerms, defaultNotes, bankDetails,
      invoicePrefix, proformaPrefix, quotePrefix, receiptPrefix, expensePrefix, purchaseOrderPrefix,
      defaultCurrency, timezone, dateFormat
    };

    // Remove undefined fields and invalid "[object Object]" strings (common in multipart/form-data submissions)
    Object.keys(settingsUpdate).forEach(key => {
      if (settingsUpdate[key] === undefined || settingsUpdate[key] === '[object Object]') {
        delete settingsUpdate[key];
      }
    });

    // Update User model if username/loginEmail provided
    if (username || loginEmail) {
        const userUpdate = {};
        if (username) userUpdate.username = username;
        if (loginEmail) userUpdate.email = loginEmail.toLowerCase();
        
        // Check for duplicates if changing
        if (Object.keys(userUpdate).length > 0) {
             const User = require('../models/User'); // Lazy load to avoid circular dependency if any
             
             // Check if username/email is taken by another user
             const checkingQuery = [];
             if (username) checkingQuery.push({ username });
             if (loginEmail) checkingQuery.push({ email: loginEmail.toLowerCase() });

             const existingUser = await User.findOne({ 
                 $or: checkingQuery,
                 _id: { $ne: req.user._id } // Exclude current user
             });
             
             if (existingUser) {
                 console.error('Update Settings: Username/Email taken', { 
                     username, 
                     email: loginEmail, 
                     existingId: existingUser._id 
                 });
                 if (req.files) {
                    if (req.files.logo && fs.existsSync(req.files.logo[0].path)) fs.unlinkSync(req.files.logo[0].path);
                    if (req.files.signature && fs.existsSync(req.files.signature[0].path)) fs.unlinkSync(req.files.signature[0].path);
                 }
                 return res.status(400).json({ message: 'Username or Email already taken' });
             }

             await User.findByIdAndUpdate(req.user._id, userUpdate);
        }
    }

    if (!settings) {
      // Create new if not exists
      const settingsData = { ...settingsUpdate, user: req.user._id };
      if (newLogoUrl) settingsData.logoUrl = newLogoUrl;
      if (newSignatureUrl) settingsData.signatureUrl = newSignatureUrl;
      if (safeIntegration !== undefined) settingsData.integration = safeIntegration;
      settings = new Settings(settingsData);
    } else {
      // Update existing
      if (newLogoUrl) settingsUpdate.logoUrl = newLogoUrl;
      if (newSignatureUrl) settingsUpdate.signatureUrl = newSignatureUrl;
      Object.assign(settings, settingsUpdate);
      if (safeIntegration !== undefined) {
        if (!settings.integration) {
          settings.integration = {};
        }
        // Assign fields to the existing integration subdocument to preserve omitted secrets
        Object.assign(settings.integration, safeIntegration);
      }
    }
    
    await settings.save();
    // Return populated settings with secrets masked
    const populatedSettings = await Settings.findById(settings._id).populate('user', 'username email phone');
    res.json(maskIntegrationSecrets(populatedSettings));
  } catch (error) {
    // Cleanup local files if error
    if (req.files) {
        if (req.files.logo && fs.existsSync(req.files.logo[0].path)) fs.unlinkSync(req.files.logo[0].path);
        if (req.files.signature && fs.existsSync(req.files.signature[0].path)) fs.unlinkSync(req.files.signature[0].path);
    }
    console.error('Update Settings Error:', error);
    res.status(400).json({ message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Public Submission Portal Settings
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const AuditLog = require('../models/AuditLog');

function generatePublicToken() {
  return crypto.randomBytes(32).toString('hex'); // 64-char hex, never derived from User _id
}

function buildPortalLink(token) {
  const appUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  return `${appUrl}/submit/${token}`;
}

/**
 * GET /api/settings/public-submissions
 * Returns the public portal config.
 * The token itself is NOT returned — only a ready-to-share link (which contains it).
 */
exports.getPublicSubmissionsConfig = async (req, res) => {
  try {
    let settings = await Settings.findOne({ user: req.user._id });
    if (!settings) {
      settings = new Settings({ user: req.user._id });
      await settings.save();
    }

    const ps = settings.publicSubmissions || {};
    return res.json({
      enabled:              ps.enabled              || false,
      hasToken:             !!ps.token,
      token:                ps.token                || null,
      portalLink:           ps.token ? buildPortalLink(ps.token) : null,
      companyDisplayName:   ps.companyDisplayName   || '',
      allowedCategories:    ps.allowedCategories    || ['invoice', 'expense', 'income', 'purchaseorder'],
      instructionsText:     ps.instructionsText      || '',
      maxSubmissionsPerDay: ps.maxSubmissionsPerDay  || 100,
    });
  } catch (error) {
    console.error('getPublicSubmissionsConfig error:', error.message);
    return res.status(500).json({ message: error.message });
  }
};

/**
 * PATCH /api/settings/public-submissions
 * Update portal config. Generates a token on first enable if none exists.
 */
exports.updatePublicSubmissionsConfig = async (req, res) => {
  try {
    let settings = await Settings.findOne({ user: req.user._id });
    if (!settings) {
      settings = new Settings({ user: req.user._id });
    }

    if (!settings.publicSubmissions) settings.publicSubmissions = {};

    const {
      enabled, companyDisplayName, allowedCategories,
      instructionsText, maxSubmissionsPerDay,
    } = req.body;

    const wasEnabled = settings.publicSubmissions.enabled;

    if (enabled !== undefined) settings.publicSubmissions.enabled = !!enabled;

    // Generate token the first time the portal is enabled
    if (settings.publicSubmissions.enabled && !settings.publicSubmissions.token) {
      settings.publicSubmissions.token = generatePublicToken();
    }

    if (companyDisplayName !== undefined) {
      settings.publicSubmissions.companyDisplayName = String(companyDisplayName).slice(0, 200);
    }
    if (Array.isArray(allowedCategories)) {
      const valid = ['invoice', 'expense', 'income', 'purchaseorder'];
      settings.publicSubmissions.allowedCategories = allowedCategories.filter((c) => valid.includes(c));
    }
    if (instructionsText !== undefined) {
      settings.publicSubmissions.instructionsText = String(instructionsText).slice(0, 2000);
    }
    if (maxSubmissionsPerDay !== undefined) {
      const cap = Number(maxSubmissionsPerDay);
      if (cap >= 1 && cap <= 10000) settings.publicSubmissions.maxSubmissionsPerDay = cap;
    }

    settings.markModified('publicSubmissions');
    await settings.save();

    // Audit: log if enabled/disabled changed
    const nowEnabled = settings.publicSubmissions.enabled;
    if (wasEnabled !== nowEnabled) {
      try {
        await AuditLog.create({
          user:    req.user._id,
          actor:   req.user._id,
          action:  nowEnabled ? 'PUBLIC_PORTAL_ENABLED' : 'PUBLIC_PORTAL_DISABLED',
          changes: {},
        });
      } catch (_) {}
    }

    const ps = settings.publicSubmissions;
    return res.json({
      enabled:              ps.enabled,
      hasToken:             !!ps.token,
      token:                ps.token,
      portalLink:           ps.token ? buildPortalLink(ps.token) : null,
      companyDisplayName:   ps.companyDisplayName,
      allowedCategories:    ps.allowedCategories,
      instructionsText:     ps.instructionsText,
      maxSubmissionsPerDay: ps.maxSubmissionsPerDay,
    });
  } catch (error) {
    console.error('updatePublicSubmissionsConfig error:', error.message);
    return res.status(500).json({ message: error.message });
  }
};

/**
 * POST /api/settings/public-submissions/regenerate-token
 * Generates a brand-new token, immediately invalidating the old shareable link.
 * No grace period — the old link 404s the moment this completes.
 */
exports.regeneratePublicToken = async (req, res) => {
  try {
    let settings = await Settings.findOne({ user: req.user._id });
    if (!settings) {
      settings = new Settings({ user: req.user._id });
    }
    if (!settings.publicSubmissions) settings.publicSubmissions = {};

    const oldToken = settings.publicSubmissions.token;
    const newToken = generatePublicToken();

    settings.publicSubmissions.token   = newToken;
    settings.publicSubmissions.enabled = true; // Auto-enable when regenerating

    settings.markModified('publicSubmissions');
    await settings.save();

    try {
      await AuditLog.create({
        user:    req.user._id,
        actor:   req.user._id,
        action:  'PUBLIC_TOKEN_REGENERATED',
        changes: { hadPreviousToken: !!oldToken },
      });
    } catch (_) {}

    const ps = settings.publicSubmissions;
    return res.json({
      enabled:              true,
      hasToken:             true,
      token:                newToken,
      portalLink:           buildPortalLink(newToken),
      message:              'Token regenerated. The old link is now inactive.',
      companyDisplayName:   ps.companyDisplayName,
      allowedCategories:    ps.allowedCategories,
      instructionsText:     ps.instructionsText,
      maxSubmissionsPerDay: ps.maxSubmissionsPerDay,
    });
  } catch (error) {
    console.error('regeneratePublicToken error:', error.message);
    return res.status(500).json({ message: error.message });
  }
};

