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
    const ts = String(Math.floor(Date.now() / 1000));
    const computedWithDefault = crypto.createHmac('sha256', 'default-webhook-secret').update(`${ts}.${rawBody}`).digest('hex');

    const req = {
      headers: {
        'x-hrms-tenant-id': 'tenant_no_secret_123',
        'x-hrms-signature': computedWithDefault,
        'x-hrms-timestamp': ts,
      },
      body: { event: 'employee.created' },
      rawBody,
    };

    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
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
    const ts = String(Math.floor(Date.now() / 1000));
    const validSignature = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');

    const req = {
      headers: {
        'x-hrms-tenant-id': 'tenant_with_secret',
        'x-hrms-signature': validSignature,
        'x-hrms-timestamp': ts,
      },
      body: { event: 'employee.updated' },
      rawBody,
    };

    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
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

  test('Rejects webhook when SHARED_WEBHOOK_SECRET fallback is set but tenant has no own secret (fallback removed)', async () => {
    process.env.SHARED_WEBHOOK_SECRET = 'global-shared-secret-777';
    const rawBody = JSON.stringify({ event: 'attendance.synced' });
    const ts = String(Math.floor(Date.now() / 1000));
    // Signature computed with the shared secret — must now be rejected
    const validSignature = crypto.createHmac('sha256', 'global-shared-secret-777').update(`${ts}.${rawBody}`).digest('hex');

    const req = {
      headers: {
        'x-hrms-tenant-id': 'tenant_shared_env',
        'x-hrms-signature': validSignature,
        'x-hrms-timestamp': ts,
      },
      body: { event: 'attendance.synced' },
      rawBody,
    };

    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    // Tenant has no own webhookSecret
    Settings.findOne.mockResolvedValue({
      user: 'user_789',
      integration: { enabled: true, externalTenantId: 'tenant_shared_env' },
    });

    await verifyMultiTenantWebhook(req, res, next);

    // Must be rejected — fallback no longer accepted
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('Startup check warns once per tenant without a secret (not conditional on SHARED_WEBHOOK_SECRET)', async () => {
    delete process.env.SHARED_WEBHOOK_SECRET;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    Settings.find = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { _id: 'id1', integration: { externalTenantId: 'tenant_A' } },
          { _id: 'id2', integration: { externalTenantId: 'tenant_B' } },
        ]),
      }),
    });

    await checkWebhookSecretStartup();

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/tenant_A/));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/tenant_B/));

    warnSpy.mockRestore();
  });

  // ── Replay protection tests ──────────────────────────────────────────────────

  function makeValidReq(secret, rawBody, ts) {
    const sig = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
    return {
      headers: { 'x-hrms-tenant-id': 'tenant_rt', 'x-hrms-signature': sig, 'x-hrms-timestamp': ts },
      body: JSON.parse(rawBody),
      rawBody,
    };
  }

  function mockTenant(secret) {
    Settings.findOne.mockResolvedValue({
      user: 'user_rt',
      integration: { enabled: true, externalTenantId: 'tenant_rt', webhookSecret: secret },
    });
  }

  test('Replay protection: rejects request when x-hrms-timestamp header is missing', async () => {
    const secret = 'replay-test-secret-xyz';
    const rawBody = JSON.stringify({ event: 'test' });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');

    const req = {
      headers: { 'x-hrms-tenant-id': 'tenant_rt', 'x-hrms-signature': sig }, // no timestamp
      body: JSON.parse(rawBody),
      rawBody,
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    mockTenant(secret);

    await verifyMultiTenantWebhook(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/x-hrms-timestamp/i) }));
  });

  test('Replay protection: rejects request with timestamp older than 5 minutes', async () => {
    const secret = 'replay-test-secret-xyz';
    const rawBody = JSON.stringify({ event: 'test' });
    const staleTs = String(Math.floor((Date.now() - 6 * 60 * 1000) / 1000)); // 6 minutes ago
    mockTenant(secret);

    await verifyMultiTenantWebhook(makeValidReq(secret, rawBody, staleTs), { status: jest.fn().mockReturnThis(), json: jest.fn() }, jest.fn());
    // Re-mock for clean assertion
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    mockTenant(secret);
    await verifyMultiTenantWebhook(makeValidReq(secret, rawBody, staleTs), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/5-minute acceptance window/i) }));
  });

  test('Replay protection: rejects request with a future timestamp beyond 5 minutes', async () => {
    const secret = 'replay-test-secret-xyz';
    const rawBody = JSON.stringify({ event: 'test' });
    const futureTs = String(Math.floor((Date.now() + 6 * 60 * 1000) / 1000)); // 6 minutes ahead
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    mockTenant(secret);

    await verifyMultiTenantWebhook(makeValidReq(secret, rawBody, futureTs), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('Replay protection: accepts request with current timestamp and correct signature', async () => {
    const secret = 'replay-test-secret-xyz';
    const rawBody = JSON.stringify({ event: 'test' });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    mockTenant(secret);

    await verifyMultiTenantWebhook(makeValidReq(secret, rawBody, ts), res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
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
    // SHARED_WEBHOOK_SECRET is no longer checked by verifyProductionSecretAudit
    // because the shared-secret fallback has been removed. This is intentional:
    // webhook security is now enforced per-tenant via Settings.integration.webhookSecret.
    // The startup audit for that is done by checkWebhookSecretStartup(), not here.
    // This test is retained as documentation of the deliberate removal.
    process.env.NODE_ENV = 'production';
    process.env.ENCRYPTION_SECRET_KEY = 'strong-production-encryption-secret-key-999';
    process.env.SHARED_WEBHOOK_SECRET = 'default-webhook-secret'; // no longer audited

    expect(() => verifyProductionSecretAudit()).not.toThrow();
  });

  test('Passes in production mode when strong, valid secrets are provided', () => {
    process.env.NODE_ENV = 'production';
    process.env.ENCRYPTION_SECRET_KEY = 'strong-production-encryption-secret-key-999';
    // SHARED_WEBHOOK_SECRET is no longer audited here; tenant secrets are per-Settings document

    expect(() => verifyProductionSecretAudit()).not.toThrow();
  });
});
