/**
 * tests/unit/webhookSecret.test.js
 *
 * Unit tests verifying webhook secret enforcement and fallback removal in verifyMultiTenantWebhook.
 */

const crypto = require('crypto');
const { verifyMultiTenantWebhook, checkWebhookSecretStartup } = require('../../utils/cryptoHelper');
const Settings = require('../../models/Settings');

jest.mock('../../models/Settings');

describe('Multi-Tenant Webhook Secret Security & Fallback Removal', () => {
  const originalEnv = process.env.SHARED_WEBHOOK_SECRET;

  beforeEach(() => {
    delete process.env.SHARED_WEBHOOK_SECRET;
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (originalEnv) {
      process.env.SHARED_WEBHOOK_SECRET = originalEnv;
    } else {
      delete process.env.SHARED_WEBHOOK_SECRET;
    }
  });

  test('Rejects webhook with 401 when no secret is configured in settings or env', async () => {
    const rawBody = JSON.stringify({ event: 'employee.created' });
    const computedWithDefault = crypto.createHmac('sha256', 'default-webhook-secret').update(rawBody).digest('hex');

    const req = {
      headers: {
        'x-hrms-tenant-id': 'tenant_no_secret_123',
        'x-hrms-signature': computedWithDefault,
      },
      body: { event: 'employee.created' },
      rawBody,
    };

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    const next = jest.fn();

    Settings.findOne.mockResolvedValue({
      user: 'user_123',
      integration: {
        enabled: true,
        externalTenantId: 'tenant_no_secret_123',
        // webhookSecret is undefined
      },
    });

    await verifyMultiTenantWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/Webhook integration is not properly configured/i),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  test('Verifies signature successfully when tenant-specific webhookSecret is set', async () => {
    const secret = 'custom-tenant-secret-key-999';
    const rawBody = JSON.stringify({ event: 'employee.updated' });
    const validSignature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    const req = {
      headers: {
        'x-hrms-tenant-id': 'tenant_with_secret',
        'x-hrms-signature': validSignature,
      },
      body: { event: 'employee.updated' },
      rawBody,
    };

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    const next = jest.fn();

    Settings.findOne.mockResolvedValue({
      user: 'user_456',
      integration: {
        enabled: true,
        externalTenantId: 'tenant_with_secret',
        webhookSecret: secret,
      },
    });

    await verifyMultiTenantWebhook(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('Verifies signature successfully using SHARED_WEBHOOK_SECRET fallback', async () => {
    process.env.SHARED_WEBHOOK_SECRET = 'global-shared-secret-777';
    const rawBody = JSON.stringify({ event: 'attendance.synced' });
    const validSignature = crypto.createHmac('sha256', 'global-shared-secret-777').update(rawBody).digest('hex');

    const req = {
      headers: {
        'x-hrms-tenant-id': 'tenant_shared_env',
        'x-hrms-signature': validSignature,
      },
      body: { event: 'attendance.synced' },
      rawBody,
    };

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    const next = jest.fn();

    Settings.findOne.mockResolvedValue({
      user: 'user_789',
      integration: {
        enabled: true,
        externalTenantId: 'tenant_shared_env',
      },
    });

    await verifyMultiTenantWebhook(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('Triggers startup warning check when SHARED_WEBHOOK_SECRET is missing and active integration exists', async () => {
    delete process.env.SHARED_WEBHOOK_SECRET;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    Settings.findOne.mockResolvedValue({
      integration: { enabled: true }
    });

    await checkWebhookSecretStartup();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/SHARED_WEBHOOK_SECRET environment variable is unset/i)
    );

    warnSpy.mockRestore();
  });
});

describe('deriveKey Security Fallback & Key Derivation', () => {
  const { encryptPayload, decryptPayload } = require('../../utils/cryptoHelper');
  const originalEnvNode = process.env.NODE_ENV;
  const originalSecretKey = process.env.ENCRYPTION_SECRET_KEY;

  afterEach(() => {
    process.env.NODE_ENV = originalEnvNode;
    if (originalSecretKey !== undefined) {
      process.env.ENCRYPTION_SECRET_KEY = originalSecretKey;
    } else {
      delete process.env.ENCRYPTION_SECRET_KEY;
    }
  });

  test('Throws fatal security error in production if no secret and no ENCRYPTION_SECRET_KEY provided', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ENCRYPTION_SECRET_KEY;

    expect(() => {
      encryptPayload({ data: 'test' });
    }).toThrow(/\[FATAL SECURITY ERROR\] No encryption secret provided/i);
  });

  test('Uses dev fallback key outside production if no secret and no ENCRYPTION_SECRET_KEY provided', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ENCRYPTION_SECRET_KEY;

    const payload = { foo: 'bar' };
    const encrypted = encryptPayload(payload);
    expect(encrypted).toHaveProperty('data');

    const decrypted = decryptPayload(encrypted);
    expect(decrypted).toEqual(payload);
  });

  test('Encrypts and decrypts payload successfully when secret or ENCRYPTION_SECRET_KEY is provided', () => {
    process.env.ENCRYPTION_SECRET_KEY = 'my-explicit-secret-key-123';

    const payload = { secretField: 'top_secret' };
    const encrypted = encryptPayload(payload);
    const decrypted = decryptPayload(encrypted);
    expect(decrypted).toEqual(payload);
  });
});

describe('verifyProductionSecretAudit Startup Checks', () => {
  const { verifyProductionSecretAudit } = require('../../utils/cryptoHelper');
  const originalEnvNode = process.env.NODE_ENV;
  const originalSecretKey = process.env.ENCRYPTION_SECRET_KEY;
  const originalPiiKey = process.env.PII_ENCRYPTION_KEY;
  const originalSharedWebhook = process.env.SHARED_WEBHOOK_SECRET;

  afterEach(() => {
    process.env.NODE_ENV = originalEnvNode;
    if (originalSecretKey !== undefined) process.env.ENCRYPTION_SECRET_KEY = originalSecretKey; else delete process.env.ENCRYPTION_SECRET_KEY;
    if (originalPiiKey !== undefined) process.env.PII_ENCRYPTION_KEY = originalPiiKey; else delete process.env.PII_ENCRYPTION_KEY;
    if (originalSharedWebhook !== undefined) process.env.SHARED_WEBHOOK_SECRET = originalSharedWebhook; else delete process.env.SHARED_WEBHOOK_SECRET;
  });

  test('Passes silently outside production mode even if secrets are unset', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.ENCRYPTION_SECRET_KEY;
    delete process.env.PII_ENCRYPTION_KEY;

    expect(() => verifyProductionSecretAudit()).not.toThrow();
  });

  test('Throws in production mode if encryption secret is missing', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ENCRYPTION_SECRET_KEY;
    delete process.env.PII_ENCRYPTION_KEY;

    expect(() => verifyProductionSecretAudit()).toThrow(/\[FATAL SECURITY ERROR\] ENCRYPTION_SECRET_KEY or PII_ENCRYPTION_KEY is not set/i);
  });

  test('Throws in production mode if encryption secret is set to a known-bad default string', () => {
    process.env.NODE_ENV = 'production';
    process.env.ENCRYPTION_SECRET_KEY = 'default-secret-key-32-chars-long-!!';

    expect(() => verifyProductionSecretAudit()).toThrow(/insecure default string/i);
  });

  test('Throws in production mode if SHARED_WEBHOOK_SECRET is set to a known-bad default string', () => {
    process.env.NODE_ENV = 'production';
    process.env.ENCRYPTION_SECRET_KEY = 'strong-production-encryption-secret-key-999';
    process.env.SHARED_WEBHOOK_SECRET = 'default-webhook-secret';

    expect(() => verifyProductionSecretAudit()).toThrow(/SHARED_WEBHOOK_SECRET is set to an insecure default string/i);
  });

  test('Passes in production mode when strong, valid secrets are provided', () => {
    process.env.NODE_ENV = 'production';
    process.env.ENCRYPTION_SECRET_KEY = 'strong-production-encryption-secret-key-999';
    process.env.SHARED_WEBHOOK_SECRET = 'strong-production-webhook-secret-888';

    expect(() => verifyProductionSecretAudit()).not.toThrow();
  });
});
