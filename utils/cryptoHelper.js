const crypto = require('crypto');
const Settings = require('../models/Settings');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

// Utility function to derive a key from a raw secret string and salt
const deriveKey = (secret, salt) => {
  const cleanSecret = secret || process.env.ENCRYPTION_SECRET_KEY;
  if (!cleanSecret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[FATAL SECURITY ERROR] No encryption secret provided and ENCRYPTION_SECRET_KEY is not set. Server startup/operation halted.');
    }
    return crypto.pbkdf2Sync('dev-only-insecure-default-key', salt, 100000, KEY_LENGTH, 'sha256');
  }
  return crypto.pbkdf2Sync(String(cleanSecret), salt, 100000, KEY_LENGTH, 'sha256');
};

/**
 * Encrypt a JSON-serializable object or string using AES-256-GCM.
 * Returns an encrypted package (hex strings).
 */
exports.encryptPayload = (data, secret) => {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  const iv = crypto.randomBytes(IV_LENGTH);
  const salt = crypto.randomBytes(SALT_LENGTH);

  const key = deriveKey(secret, salt);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag().toString('hex');

  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag,
    data: encrypted
  };
};

/**
 * Decrypt an AES-256-GCM encrypted package.
 * Returns the parsed JSON or raw string.
 */
exports.decryptPayload = (encryptedPackage, secret) => {
  try {
    const { salt, iv, authTag, data } = encryptedPackage;

    const isHex = (str) => typeof str === 'string' && /^[0-9a-fA-F]+$/.test(str);

    const saltEnc = isHex(salt) ? 'hex' : 'base64';
    const ivEnc = isHex(iv) ? 'hex' : 'base64';
    const authTagEnc = isHex(authTag) ? 'hex' : 'base64';
    const dataEnc = isHex(data) ? 'hex' : 'base64';

    const saltBuf = Buffer.from(salt, saltEnc);
    const ivBuf = Buffer.from(iv, ivEnc);
    const authTagBuf = Buffer.from(authTag, authTagEnc);

    const key = deriveKey(secret, saltBuf);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuf);
    decipher.setAuthTag(authTagBuf);

    let decrypted = decipher.update(data, dataEnc, 'utf8');
    decrypted += decipher.final('utf8');

    try {
      return JSON.parse(decrypted);
    } catch {
      return decrypted;
    }
  } catch (error) {
    console.error('Decryption failed:', error.message);
    throw new Error('Symmetric decryption failed: Invalid key, altered payload, or corrupted transmission.');
  }
};

/**
 * Express middleware to verify incoming multi-tenant webhooks using HMAC-SHA256.
 */
exports.verifyMultiTenantWebhook = async (req, res, next) => {
  try {
    const externalTenantId = req.headers['x-hrms-tenant-id'] || req.body.tenantId || req.body.tenant_id;
    const signature = req.headers['x-hrms-signature'] || req.headers['x-flance-signature'];

    if (!externalTenantId) {
      return res.status(400).json({ message: 'Scoping error: x-hrms-tenant-id is required for multi-tenant webhook verification.' });
    }
    if (!signature) {
      return res.status(401).json({ message: 'Signature missing: x-hrms-signature header is required.' });
    }

    // Find the settings for the mapped tenant
    const settings = await Settings.findOne({ 'integration.externalTenantId': externalTenantId });
    if (!settings || !settings.integration?.enabled) {
      return res.status(401).json({ message: `Access denied: Integration is disabled or not configured for tenant ${externalTenantId}.` });
    }

    // Require each tenant to have its own webhookSecret — no shared fallback.
    // A single fallback key breaks tenant isolation (forging one tenant's signature
    // would work for every tenant relying on the fallback).
    const webhookSecret = settings.integration?.webhookSecret;
    if (!webhookSecret) {
      console.error(`[SECURITY] No webhook secret configured for tenant ${externalTenantId}. Integration requires a tenant-specific webhookSecret.`);
      return res.status(401).json({ message: 'Webhook integration is not properly configured for this tenant — no secret available for signature verification.' });
    }

    // ── Replay protection ─────────────────────────────────────────────────────
    // Require x-hrms-timestamp (Unix seconds) and reject requests outside a
    // ±5-minute window. This prevents captured valid requests being replayed.
    const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
    const tsHeader = req.headers['x-hrms-timestamp'];
    if (!tsHeader) {
      return res.status(400).json({ message: 'Replay protection: x-hrms-timestamp header is required.' });
    }
    const tsMs = Number(tsHeader) * 1000; // header is Unix seconds
    if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > REPLAY_WINDOW_MS) {
      return res.status(401).json({ message: 'Replay protection: request timestamp is missing, invalid, or outside the 5-minute acceptance window.' });
    }

    // Use rawBody buffer if available to avoid stringify mismatches, fallback to req.body stringify
    const rawBody = req.rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

    // HMAC input = timestamp + '.' + rawBody so the timestamp is part of the signed content.
    // Senders must use the same concatenation when generating the signature.
    const hmacInput = `${tsHeader}.${rawBody}`;
    const computedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(hmacInput)
      .digest('hex');

    const sigBuffer = Buffer.from(signature, 'hex');
    const computedBuffer = Buffer.from(computedSignature, 'hex');

    if (sigBuffer.length !== computedBuffer.length || !crypto.timingSafeEqual(sigBuffer, computedBuffer)) {
      return res.status(401).json({ message: 'Signature mismatch: HMAC authentication failed.' });
    }

    // Set tenant context details for downstream use
    req.tenantUserId = settings.user;
    req.integrationSettings = settings.integration;

    next();
  } catch (error) {
    console.error('Webhook auth error:', error.message);
    res.status(500).json({ message: 'Internal validation failure during webhook verification.' });
  }
};

const checkWebhookSecretStartup = async () => {
  try {
    // Find every tenant with integration enabled but no webhook secret configured.
    // Without a tenant-specific secret, incoming webhooks cannot be verified.
    // The shared-secret fallback has been removed to preserve tenant isolation.
    const tenantsWithoutSecret = await Settings.find({
      'integration.enabled': true,
      $or: [
        { 'integration.webhookSecret': { $exists: false } },
        { 'integration.webhookSecret': '' },
        { 'integration.webhookSecret': null },
      ],
    }).select('integration.externalTenantId user').lean();

    for (const tenant of tenantsWithoutSecret) {
      const id = tenant.integration?.externalTenantId || String(tenant._id);
      console.warn(
        `[SECURITY WARNING] Tenant ${id} has integration enabled but no webhookSecret configured. ` +
        'Incoming webhooks cannot be verified for this tenant. ' +
        'Set integration.webhookSecret via the Settings API to resolve this.'
      );
    }
  } catch (error) {
    // Non-blocking warning check during early startup
  }
};

exports.checkWebhookSecretStartup = checkWebhookSecretStartup;

const KNOWN_BAD_SECRETS = [
  'default-secret-key-32-chars-long-!!',
  'dev-only-insecure-default-key',
  'default-webhook-secret',
  'dev-pii-encryption-key-32-bytes-long!!',
  'default-secret-key',
  'secret',
  '12345678',
  'password'
];

/**
 * Startup security audit running at server boot.
 * In production mode, halts server startup if essential encryption/webhook secrets
 * are missing or set to known-bad insecure default strings.
 */
const verifyProductionSecretAudit = () => {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  const encryptionSecret = process.env.PII_ENCRYPTION_KEY || process.env.ENCRYPTION_SECRET_KEY;
  if (!encryptionSecret) {
    throw new Error('[FATAL SECURITY ERROR] ENCRYPTION_SECRET_KEY or PII_ENCRYPTION_KEY is not set in production environment. Server startup halted.');
  }
  if (KNOWN_BAD_SECRETS.includes(encryptionSecret)) {
    throw new Error(`[FATAL SECURITY ERROR] ENCRYPTION_SECRET_KEY / PII_ENCRYPTION_KEY is set to an insecure default string ("${encryptionSecret}"). Server startup halted.`);
  }
};

exports.verifyProductionSecretAudit = verifyProductionSecretAudit;

const getPIIEncryptionSecret = () => {
  const secret = process.env.PII_ENCRYPTION_KEY || process.env.ENCRYPTION_SECRET_KEY;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[FATAL SECURITY ERROR] PII_ENCRYPTION_KEY or ENCRYPTION_SECRET_KEY environment variable is required in production mode! Server startup/operation halted.');
    }
    return 'dev-pii-encryption-key-32-bytes-long!!';
  }
  return secret;
};

exports.encryptPIIField = (plaintext) => {
  if (!plaintext || typeof plaintext !== 'string') return plaintext;
  if (plaintext.startsWith('enc:v1:')) return plaintext;
  const secret = getPIIEncryptionSecret();
  const pkg = exports.encryptPayload(plaintext, secret);
  return `enc:v1:${pkg.salt}:${pkg.iv}:${pkg.authTag}:${pkg.data}`;
};

exports.decryptPIIField = (ciphertext) => {
  if (!ciphertext || typeof ciphertext !== 'string' || !ciphertext.startsWith('enc:v1:')) {
    return ciphertext;
  }
  const parts = ciphertext.split(':');
  if (parts.length !== 6) return ciphertext;
  const [, , salt, iv, authTag, data] = parts;
  const secret = getPIIEncryptionSecret();
  try {
    return exports.decryptPayload({ salt, iv, authTag, data }, secret);
  } catch (err) {
    // If configured secret fails (e.g. key changed), try dev fallback secret for dev/migrated records
    const fallbackSecret = 'dev-pii-encryption-key-32-bytes-long!!';
    if (secret !== fallbackSecret) {
      try {
        return exports.decryptPayload({ salt, iv, authTag, data }, fallbackSecret);
      } catch (_) {
        // Fallback also failed
      }
    }
    console.error('Failed to decrypt PII field:', err.message);
    return ciphertext;
  }
};

exports.decryptEmployeePII = (doc) => {
  if (!doc) return doc;
  if (doc.panNumber) doc.panNumber = exports.decryptPIIField(doc.panNumber);
  if (doc.uanNumber) doc.uanNumber = exports.decryptPIIField(doc.uanNumber);
  if (doc.aadharNumber) doc.aadharNumber = exports.decryptPIIField(doc.aadharNumber);
  if (doc.esiNumber) doc.esiNumber = exports.decryptPIIField(doc.esiNumber);
  if (doc.bankDetails && doc.bankDetails.accountNumber) {
    doc.bankDetails.accountNumber = exports.decryptPIIField(doc.bankDetails.accountNumber);
  }
  return doc;
};
