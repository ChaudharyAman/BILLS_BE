const crypto = require('crypto');
const Settings = require('../models/Settings');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

// Utility function to derive a key from a raw secret string and salt
const deriveKey = (secret, salt) => {
  const cleanSecret = String(secret || process.env.ENCRYPTION_SECRET_KEY || 'default-secret-key-32-chars-long-!!');
  return crypto.pbkdf2Sync(cleanSecret, salt, 100000, KEY_LENGTH, 'sha256');
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

    const saltBuf = Buffer.from(salt, 'hex');
    const ivBuf = Buffer.from(iv, 'hex');
    const authTagBuf = Buffer.from(authTag, 'hex');

    const key = deriveKey(secret, saltBuf);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuf);
    decipher.setAuthTag(authTagBuf);

    let decrypted = decipher.update(data, 'hex', 'utf8');
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

    const webhookSecret = settings.integration.webhookSecret || process.env.SHARED_WEBHOOK_SECRET || 'default-webhook-secret';
    
    // Stringify req.body or use raw body if available.
    // If payload is encrypted, req.body itself contains the encrypted package (salt, iv, authTag, data).
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    const computedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
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
