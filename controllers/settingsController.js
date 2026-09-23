const cloudinary = require('../config/cloudinary');
const fs = require('fs');
const Settings = require('../models/Settings');
const { getTenantFilter, attachTenant } = require('../utils/tenantHelper');
const { encryptPIIField, decryptPIIField } = require('../utils/cryptoHelper');
const { verifySmtp, sendMail } = require('../utils/mailService');

// Placeholder shown to the frontend in place of real secret values
const SECRET_MASK = '••••••••';

// Mask secret integration and SMTP fields so they are never sent to the client
const maskIntegrationSecrets = (settingsDoc) => {
  const obj = settingsDoc.toObject ? settingsDoc.toObject() : { ...settingsDoc };
  if (obj.integration) {
    if (obj.integration.apiKey)           obj.integration.apiKey           = SECRET_MASK;
    if (obj.integration.encryptionSecret) obj.integration.encryptionSecret = SECRET_MASK;
    if (obj.integration.webhookSecret)    obj.integration.webhookSecret    = SECRET_MASK;
  }
  if (obj.smtp?.auth?.pass) {
    obj.smtp.auth.pass = SECRET_MASK;
  }
  return obj;
};

// Get Settings (Create default if not exists)
exports.getSettings = async (req, res) => {
  try {
    const companyId = req.companyId || req.user?._id;
    if (!companyId) {
        return res.status(401).json({ message: 'Not authorized' });
    }
    const tenantFilter = getTenantFilter(req);
    let settings = await Settings.findOne(tenantFilter).populate('user', 'username email phone avatar');
    if (!settings && req.activeProfileId && companyId) {
      settings = await Settings.findOne({ user: companyId }).populate('user', 'username email phone avatar');
    }
    if (!settings) {
      settings = new Settings(attachTenant(req, {
        user: companyId,
        companyName: req.activeProfile?.name || undefined,
      }));
      await settings.save();
      // Re-fetch to populate after creation
      settings = await Settings.findById(settings._id).populate('user', 'username email phone avatar');
    }

    const isShareMode = Boolean(req.isSharedAccess || req.isSharedViewOnly || req.profileAccessSource === 'share' || req.isShareToken);
    if (isShareMode) {
      const sanitized = settings.toObject ? settings.toObject() : { ...settings };
      // Completely strip sensitive credentials so they are never exposed in share sessions
      delete sanitized.smtp;
      delete sanitized.integration;
      delete sanitized.publicSubmissions;
      if (sanitized.user && typeof sanitized.user === 'object') {
        delete sanitized.user.email;
        delete sanitized.user.phone;
      }

      // Fallback branding from activeProfile if not configured on Settings
      if (!sanitized.companyName && req.activeProfile?.name) {
        sanitized.companyName = req.activeProfile.name;
      }
      if (!sanitized.logoUrl && req.activeProfile?.logoUrl) {
        sanitized.logoUrl = req.activeProfile.logoUrl;
      }

      return res.json(sanitized);
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
    const companyId = req.companyId || req.user?._id;
    if (!companyId) {
        return res.status(401).json({ message: 'Not authorized' });
    }
    const tenantFilter = getTenantFilter(req);
    let settings = await Settings.findOne(tenantFilter);

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
      defaultCurrency, timezone, dateFormat, integration, smtp,
      signatureEnabled, showSignatureOnInvoices, showSignatureOnQuotes, showSignatureOnPurchaseOrders, showLogoOnDocuments,
      logoUrl, signatureUrl
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

    // Process custom SMTP settings with password encryption / preservation
    let safeSmtp = undefined;
    if (smtp !== undefined) {
      try {
        const parsedSmtp = typeof smtp === 'string' ? JSON.parse(smtp) : smtp;
        safeSmtp = { ...parsedSmtp };
        if (safeSmtp.auth) {
          safeSmtp.auth = { ...safeSmtp.auth };
          const existingPass = settings?.smtp?.auth?.pass;
          if (safeSmtp.auth.pass === SECRET_MASK || !safeSmtp.auth.pass) {
            safeSmtp.auth.pass = existingPass || '';
          } else {
            let passToSave = String(safeSmtp.auth.pass).trim();
            if (/gmail|google/i.test(safeSmtp.host || '') || /^[a-zA-Z\s]{16,24}$/.test(passToSave)) {
              const noSpace = passToSave.replace(/\s+/g, '');
              if (noSpace.length === 16) passToSave = noSpace;
            }
            safeSmtp.auth.pass = encryptPIIField(passToSave);
          }
          if (safeSmtp.auth.user) {
            safeSmtp.auth.user = String(safeSmtp.auth.user).trim();
          }
        }
      } catch (e) {
        console.warn('Failed to parse smtp payload:', e.message);
      }
    }

    const settingsUpdate = {
      companyName, contactName, website, email, phone, gstin, pan,
      address, defaultTerms, defaultNotes, bankDetails,
      invoicePrefix, proformaPrefix, quotePrefix, receiptPrefix, expensePrefix, purchaseOrderPrefix,
      defaultCurrency, timezone, dateFormat,
      signatureEnabled: signatureEnabled !== undefined ? (signatureEnabled === true || signatureEnabled === 'true') : undefined,
      showSignatureOnInvoices: showSignatureOnInvoices !== undefined ? (showSignatureOnInvoices === true || showSignatureOnInvoices === 'true') : undefined,
      showSignatureOnQuotes: showSignatureOnQuotes !== undefined ? (showSignatureOnQuotes === true || showSignatureOnQuotes === 'true') : undefined,
      showSignatureOnPurchaseOrders: showSignatureOnPurchaseOrders !== undefined ? (showSignatureOnPurchaseOrders === true || showSignatureOnPurchaseOrders === 'true') : undefined,
      showLogoOnDocuments: showLogoOnDocuments !== undefined ? (showLogoOnDocuments === true || showLogoOnDocuments === 'true') : undefined,
    };

    if (logoUrl === '') settingsUpdate.logoUrl = '';
    if (signatureUrl === '') settingsUpdate.signatureUrl = '';

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
        if (loginEmail) userUpdate.email = loginEmail;

        const checkingQuery = [];
        if (username) checkingQuery.push({ username });
        if (loginEmail) checkingQuery.push({ email: loginEmail });
        
        // Check for duplicates if changing
        if (checkingQuery.length > 0) {
             const User = require('../models/User'); // Lazy load to avoid circular dependency if any
             
             // Check if username/email is taken by another user
             const existingUser = await User.findOne({ 
                 $or: checkingQuery,
                 _id: { $ne: req.user._id } // Exclude current logged in user
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
      const settingsData = attachTenant(req, { ...settingsUpdate, user: companyId });
      if (newLogoUrl) settingsData.logoUrl = newLogoUrl;
      if (newSignatureUrl) settingsData.signatureUrl = newSignatureUrl;
      if (safeIntegration !== undefined) settingsData.integration = safeIntegration;
      if (safeSmtp !== undefined) settingsData.smtp = safeSmtp;
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
      if (safeSmtp !== undefined) {
        if (!settings.smtp) {
          settings.smtp = {};
        }
        Object.assign(settings.smtp, safeSmtp);
      }
    }

    // Enforce: integration.enabled requires a tenant-specific webhookSecret.
    // Without it, incoming webhooks cannot be verified and tenant isolation breaks.
    if (settings.integration?.enabled) {
      const hasSecret = settings.integration.webhookSecret && settings.integration.webhookSecret !== SECRET_MASK;
      if (!hasSecret) {
        return res.status(400).json({
          message: 'Integration cannot be enabled without a webhookSecret. Please configure a webhook secret before enabling the integration.',
        });
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
    if (req.isSharedAccess || req.isSharedViewOnly || req.profileAccessSource === 'share' || req.isShareToken) {
      return res.status(403).json({ message: 'Forbidden: Public submissions configuration is not accessible in shared mode.' });
    }
    const companyId = req.companyId || req.user._id;
    const tenantFilter = getTenantFilter(req);
    let settings = await Settings.findOne(tenantFilter);
    if (!settings) {
      settings = new Settings(attachTenant(req, { user: companyId }));
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
    const companyId = req.companyId || req.user._id;
    const tenantFilter = getTenantFilter(req);
    let settings = await Settings.findOne(tenantFilter);
    if (!settings) {
      settings = new Settings(attachTenant(req, { user: companyId }));
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
          user:    companyId,
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
    const companyId = req.companyId || req.user._id;
    const tenantFilter = getTenantFilter(req);
    let settings = await Settings.findOne(tenantFilter);
    if (!settings) {
      settings = new Settings(attachTenant(req, { user: companyId }));
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
        user:    companyId,
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

/**
 * POST /api/settings/smtp/test
 * Test SMTP credentials and send a test verification email.
 */
exports.testSmtpConnection = async (req, res) => {
  try {
    const companyId = req.companyId || req.user?._id;
    if (!companyId) {
      return res.status(401).json({ message: 'Not authorized' });
    }

    const { testRecipient, host, port, secure, user, pass, fromEmail, fromName, replyTo } = req.body;
    const recipient = (testRecipient || req.user?.email || '').trim();

    if (!recipient) {
      return res.status(400).json({ message: 'Recipient email address is required for sending the test email.' });
    }

    let overrideConfig = null;

    if (host) {
      let resolvedPass = pass;
      // If pass is masked or empty, read existing stored password from settings
      if (!resolvedPass || resolvedPass === SECRET_MASK) {
        const tenantFilter = getTenantFilter(req);
        const settings = await Settings.findOne(tenantFilter);
        if (settings?.smtp?.auth?.pass) {
          resolvedPass = decryptPIIField(settings.smtp.auth.pass);
        }
      }

      overrideConfig = {
        host: host.trim(),
        port: Number(port) || 587,
        secure: secure === true || secure === 'true' || Number(port) === 465,
        user: (user || '').trim(),
        pass: resolvedPass || '',
        fromEmail: (fromEmail || user || req.user?.email || '').trim(),
        fromName: fromName || 'Flance Mailer',
        replyTo: replyTo ? replyTo.trim() : undefined,
      };
    }

    const tenantFilter = getTenantFilter(req);
    const settings = await Settings.findOne(tenantFilter);

    // Verify SMTP connection
    await verifySmtp(overrideConfig || settings?.smtp);

    // Send styled verification email
    const subject = `[Flance] SMTP Test Verification - ${new Date().toLocaleTimeString()}`;
    const testHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <div style="display: inline-block; padding: 8px 16px; background: #ecfdf5; border-radius: 9999px; color: #059669; font-weight: 600; font-size: 13px;">
            ✓ SMTP Connected Successfully
          </div>
          <h2 style="color: #0f172a; margin-top: 16px; margin-bottom: 8px; font-size: 20px;">Your Email Server is Working!</h2>
          <p style="color: #64748b; font-size: 14px; line-height: 1.5; margin: 0;">
            This confirmation email was successfully delivered using your custom SMTP configuration in <strong>Flance</strong>.
          </p>
        </div>

        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; margin-bottom: 24px;">
          <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px;">
            Connection Details
          </div>
          <table style="width: 100%; font-size: 13px; color: #334155; border-collapse: collapse;">
            <tr><td style="padding: 4px 0; color: #64748b; width: 35%;">SMTP Host:</td><td style="padding: 4px 0; font-weight: 600;">${overrideConfig?.host || settings?.smtp?.host || 'Default'}</td></tr>
            <tr><td style="padding: 4px 0; color: #64748b;">Port & Encryption:</td><td style="padding: 4px 0; font-weight: 600;">${overrideConfig?.port || settings?.smtp?.port || 587} (${(overrideConfig?.secure || settings?.smtp?.secure) ? 'SSL/TLS' : 'STARTTLS'})</td></tr>
            <tr><td style="padding: 4px 0; color: #64748b;">Sender:</td><td style="padding: 4px 0; font-weight: 600;">${overrideConfig?.fromEmail || settings?.smtp?.fromEmail || 'Default'}</td></tr>
            <tr><td style="padding: 4px 0; color: #64748b;">Delivered At:</td><td style="padding: 4px 0; font-weight: 600;">${new Date().toUTCString()}</td></tr>
          </table>
        </div>

        <p style="font-size: 12px; color: #94a3b8; text-align: center; margin: 0;">
          © ${new Date().getFullYear()} Flance. All rights reserved.
        </p>
      </div>
    `;

    const info = await sendMail({
      to: recipient,
      subject,
      html: testHtml,
      text: `Flance SMTP Test Email\n\nYour SMTP server is working correctly!\nHost: ${overrideConfig?.host || settings?.smtp?.host}\nTimestamp: ${new Date().toISOString()}`,
      settings,
      overrideConfig,
    });

    return res.json({
      success: true,
      message: `Test email successfully sent to ${recipient}!`,
      messageId: info.messageId,
    });
  } catch (err) {
    console.error('SMTP test error:', err);
    const { formatSmtpError } = require('../utils/mailService');
    const friendlyMessage = typeof formatSmtpError === 'function' ? formatSmtpError(err) : err.message;
    return res.status(400).json({
      success: false,
      message: friendlyMessage || 'Failed to connect to SMTP server. Please verify your host, port, and credentials.',
    });
  }
};

