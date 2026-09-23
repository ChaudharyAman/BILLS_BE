const dns = require('dns');
const nodemailer = require('nodemailer');
const { decryptPIIField } = require('./cryptoHelper');

// Force IPv4 first in Node's DNS resolver to prevent ENETUNREACH on systems without IPv6 WAN routing
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

/**
 * Sanitize SMTP credentials.
 * Automatically trims username and password.
 * If the host is Gmail or password matches a 16-character pattern with spaces (e.g. "abcd efgh ijkl mnop"),
 * removes spaces so that Google SMTP authentication does not fail.
 */
function sanitizeSmtpCredentials(user, pass, host = '') {
  const cleanUser = user ? String(user).trim() : '';
  let cleanPass = pass ? String(pass).trim() : '';
  if (/gmail|google/i.test(host) || /^[a-zA-Z\s]{16,24}$/.test(cleanPass)) {
    const noSpaces = cleanPass.replace(/\s+/g, '');
    if (noSpaces.length === 16) {
      cleanPass = noSpaces;
    }
  }
  return { user: cleanUser, pass: cleanPass };
}

/**
 * Format SMTP errors into clear, actionable messages.
 */
function formatSmtpError(err) {
  const msg = err?.message || String(err || '');
  if (/535|5\.7\.8|badcredentials|authentication failed|invalid login/i.test(msg)) {
    return 'Invalid SMTP Login (535 5.7.8 Authentication Failed). The mail server rejected your username or password. If you are using Gmail, standard account passwords are NOT supported. You MUST generate and use a 16-character Google App Password (Google Account > Security > 2-Step Verification > App Passwords).';
  }
  return msg;
}

/**
 * Build a Nodemailer transporter.
 * Prioritizes custom SMTP settings from user/tenant Settings if enabled.
 * Otherwise falls back to environment variables.
 *
 * @param {Object} [settings] - Settings mongoose doc or plain object
 * @param {Object} [overrideConfig] - Optional direct SMTP options (for testing connections)
 * @returns {{ transporter: Object, fromEmail: string, fromName: string, isCustom: boolean, replyTo: string|undefined }}
 */
function resolveMailTransport(settings = null, overrideConfig = null) {
  // 1. Direct override (e.g., testing unsaved form values in Settings)
  if (overrideConfig && overrideConfig.host) {
    const port = Number(overrideConfig.port) || 587;
    const secure = overrideConfig.secure === true || overrideConfig.secure === 'true' || port === 465;
    const { user, pass } = sanitizeSmtpCredentials(overrideConfig.user, overrideConfig.pass, overrideConfig.host);
    const auth = user ? { user, pass } : undefined;

    const transportOptions = {
      host: overrideConfig.host.trim(),
      port,
      secure,
      auth,
      tls: { rejectUnauthorized: false },
      family: 4, // Force IPv4 to eliminate ENETUNREACH on networks without IPv6 routes
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    };

    return {
      transporter: nodemailer.createTransport(transportOptions),
      fromEmail: (overrideConfig.fromEmail || user || 'no-reply@mybillflow.com').trim(),
      fromName: overrideConfig.fromName || 'Flance Notifications',
      replyTo: overrideConfig.replyTo || undefined,
      isCustom: true,
    };
  }

  // 2. Custom SMTP configured and enabled in Settings
  const smtp = settings?.smtp;
  if (smtp && smtp.enabled && smtp.host) {
    const port = Number(smtp.port) || 587;
    const secure = smtp.secure === true || port === 465;
    let rawPass = smtp.auth?.pass || '';
    if (rawPass) {
      rawPass = decryptPIIField(rawPass);
    }

    const { user, pass } = sanitizeSmtpCredentials(smtp.auth?.user, rawPass, smtp.host);
    const auth = user ? { user, pass } : undefined;

    const transportOptions = {
      host: smtp.host.trim(),
      port,
      secure,
      auth,
      tls: { rejectUnauthorized: false },
      family: 4, // Force IPv4 to eliminate ENETUNREACH on networks without IPv6 routes
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    };

    const fromEmail = (smtp.fromEmail || user || settings.email || 'no-reply@mybillflow.com').trim();
    const fromName = smtp.fromName || settings.companyName || 'Flance';

    return {
      transporter: nodemailer.createTransport(transportOptions),
      fromEmail,
      fromName,
      replyTo: smtp.replyTo || undefined,
      isCustom: true,
    };
  }

  // 3. Fallback to system environment variables
  const envHost = process.env.SMTP_HOST || process.env.EMAIL_HOST || 'smtp.gmail.com';
  const envPort = Number(process.env.SMTP_PORT || process.env.EMAIL_PORT) || 587;
  const envUser = process.env.SMTP_USER || process.env.EMAIL_USER || '';
  const envPass = process.env.SMTP_PASS || process.env.EMAIL_PASS || '';
  const envSecure = process.env.SMTP_SECURE === 'true' || envPort === 465;

  const { user: cleanEnvUser, pass: cleanEnvPass } = sanitizeSmtpCredentials(envUser, envPass, envHost);

  const envOptions = {
    host: envHost,
    port: envPort,
    secure: envSecure,
    tls: { rejectUnauthorized: false },
    family: 4, // Force IPv4 to eliminate ENETUNREACH on networks without IPv6 routes
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  };

  if (cleanEnvUser) {
    envOptions.auth = {
      user: cleanEnvUser,
      pass: cleanEnvPass,
    };
  }

  return {
    transporter: nodemailer.createTransport(envOptions),
    fromEmail: (process.env.SMTP_FROM || cleanEnvUser || 'no-reply@mybillflow.com').trim(),
    fromName: process.env.SMTP_FROM_NAME || 'Flance Notifications',
    replyTo: process.env.SMTP_REPLY_TO || undefined,
    isCustom: false,
  };
}

/**
 * Verify SMTP connection and credentials.
 * @param {Object} smtpConfig - { host, port, secure, user, pass }
 */
async function verifySmtp(smtpConfig) {
  try {
    const { transporter } = resolveMailTransport(null, smtpConfig);
    return await transporter.verify();
  } catch (err) {
    const formatted = formatSmtpError(err);
    const enhancedErr = new Error(formatted);
    enhancedErr.originalError = err;
    throw enhancedErr;
  }
}

/**
 * Send an email using resolved transporter.
 * @param {Object} options - { to, subject, html, text, attachments, settings, overrideConfig }
 */
async function sendMail(options) {
  const { to, subject, html, text, attachments, settings, overrideConfig } = options;

  if (!to) {
    throw new Error('Recipient (to) email is required');
  }

  const { transporter, fromEmail, fromName, replyTo } = resolveMailTransport(settings, overrideConfig);

  const mailOptions = {
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject,
    html: html || undefined,
    text: text || undefined,
    attachments: attachments || undefined,
    replyTo: replyTo || undefined,
  };

  try {
    return await transporter.sendMail(mailOptions);
  } catch (err) {
    const formatted = formatSmtpError(err);
    const enhancedErr = new Error(formatted);
    enhancedErr.originalError = err;
    throw enhancedErr;
  }
}

module.exports = {
  resolveMailTransport,
  verifySmtp,
  sendMail,
  sanitizeSmtpCredentials,
  formatSmtpError,
};
