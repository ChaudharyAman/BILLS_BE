const request = require('supertest');
const mongoose = require('mongoose');
const { app } = require('../../index');
const User = require('../../models/User');
const RefreshToken = require('../../models/RefreshToken');

describe('Short-Lived Access Token & Refresh Token Integration', () => {
  let testUser;
  const testPassword = 'Password123!';
  const testEmail = `test_token_${Date.now()}@example.com`;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/mybill');
    }
    // Create test user
    testUser = await User.create({
      username: `testuser_${Date.now()}`,
      email: testEmail,
      password: testPassword,
      role: 'user',
      isOwner: true,
      status: 'active',
    });
  });

  beforeEach(async () => {
    if (testUser) {
      await RefreshToken.deleteMany({ user: testUser._id });
    }
  });

  afterAll(async () => {
    if (testUser) {
      await User.deleteOne({ _id: testUser._id });
      await RefreshToken.deleteMany({ user: testUser._id });
    }
    await mongoose.disconnect();
  });

  it('1. Logs in and receives 15-minute access token and 7-day refresh token cookies', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: testEmail, password: testPassword });

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();

    const cookies = res.headers['set-cookie'] || [];
    const tokenCookie = cookies.find((c) => c.startsWith('token='));
    const refreshCookie = cookies.find((c) => c.startsWith('refreshToken='));

    expect(tokenCookie).toBeDefined();
    expect(refreshCookie).toBeDefined();

    // Verify cookie attributes
    expect(tokenCookie.toLowerCase()).toContain('httponly');
    expect(refreshCookie.toLowerCase()).toContain('httponly');
    expect(refreshCookie.toLowerCase()).toContain('path=/api/auth');

    // Verify server-side session document created in DB
    const sessions = await RefreshToken.find({ user: testUser._id, isRevoked: false });
    expect(sessions.length).toBe(1);
    expect(sessions[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('2. Refreshes token silently, rotates refresh token, and preserves validity', async () => {
    // Login to get cookies
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: testEmail, password: testPassword });

    const rawCookies = loginRes.headers['set-cookie'];
    const refreshTokenCookieStr = rawCookies.find((c) => c.startsWith('refreshToken=')).split(';')[0];

    // Call /api/auth/refresh
    const refreshRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', [refreshTokenCookieStr]);

    expect(refreshRes.status).toBe(200);
    const newCookies = refreshRes.headers['set-cookie'] || [];
    const newTokenCookie = newCookies.find((c) => c.startsWith('token='));
    const newRefreshCookie = newCookies.find((c) => c.startsWith('refreshToken='));

    expect(newTokenCookie).toBeDefined();
    expect(newRefreshCookie).toBeDefined();

    // Verify the previous session is marked isRevoked: true and has replacedByTokenHash
    const oldSessions = await RefreshToken.find({ user: testUser._id, isRevoked: true });
    expect(oldSessions.length).toBeGreaterThanOrEqual(1);
    const latestOldSession = oldSessions[oldSessions.length - 1];
    expect(latestOldSession.replacedByTokenHash).toBeDefined();

    // Verify a new active session exists
    const activeSessions = await RefreshToken.find({ user: testUser._id, isRevoked: false });
    expect(activeSessions.length).toBe(1);
  });

  it('3. Detects token reuse: Reusing an old/revoked refresh token revokes all user sessions', async () => {
    // Login
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: testEmail, password: testPassword });

    const rawCookies = loginRes.headers['set-cookie'];
    const firstRefreshCookieStr = rawCookies.find((c) => c.startsWith('refreshToken=')).split(';')[0];

    // Legitimate refresh (rotates token)
    const legitRefreshRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', [firstRefreshCookieStr]);
    expect(legitRefreshRes.status).toBe(200);

    // Attacker or replay attack: Tries to refresh again using firstRefreshCookieStr!
    const replayRes = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', [firstRefreshCookieStr]);

    expect(replayRes.status).toBe(401);
    expect(replayRes.body.message).toMatch(/compromised/i);

    // Breach containment check: ALL active sessions for this user should now be revoked
    const activeSessions = await RefreshToken.find({ user: testUser._id, isRevoked: false });
    expect(activeSessions.length).toBe(0);
  });

  it('4. Logs out and revokes refresh token on the server', async () => {
    // Login
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ username: testEmail, password: testPassword });

    const rawCookies = loginRes.headers['set-cookie'];
    const refreshCookieStr = rawCookies.find((c) => c.startsWith('refreshToken=')).split(';')[0];

    // Logout
    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', [refreshCookieStr]);

    expect(logoutRes.status).toBe(200);

    // Cookies should be cleared (maxAge: 0 or expires in past)
    const logoutCookies = logoutRes.headers['set-cookie'] || [];
    expect(logoutCookies.some((c) => c.includes('Max-Age=0') || c.includes('expires='))).toBe(true);

    // Session in DB should now be revoked
    const activeSessions = await RefreshToken.find({ user: testUser._id, isRevoked: false });
    expect(activeSessions.length).toBe(0);
  });

  it('5. Retrieves active sessions list with device, location, and isCurrent flag', async () => {
    // Login with Chrome User-Agent and Delhi location header
    const chromeLoginRes = await request(app)
      .post('/api/auth/login')
      .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
      .set('X-Client-Location', 'Delhi, India')
      .send({ username: testEmail, password: testPassword });

    const chromeCookies = chromeLoginRes.headers['set-cookie'];
    const chromeTokenCookie = chromeCookies.find((c) => c.startsWith('token=')).split(';')[0];
    const chromeRefreshCookie = chromeCookies.find((c) => c.startsWith('refreshToken=')).split(';')[0];

    // Login with Edge User-Agent and Mumbai location header
    const edgeLoginRes = await request(app)
      .post('/api/auth/login')
      .set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0')
      .set('X-Client-Location', 'Mumbai, India')
      .send({ username: testEmail, password: testPassword });

    // Request active sessions from the first (Chrome) device
    const sessionsRes = await request(app)
      .get('/api/auth/sessions')
      .set('Cookie', [chromeTokenCookie, chromeRefreshCookie]);

    expect(sessionsRes.status).toBe(200);
    expect(sessionsRes.body.sessions).toBeDefined();
    expect(sessionsRes.body.sessions.length).toBe(2);

    const chromeSession = sessionsRes.body.sessions.find((s) => s.browser === 'Chrome');
    const edgeSession = sessionsRes.body.sessions.find((s) => s.browser === 'Edge');

    expect(chromeSession).toBeDefined();
    expect(chromeSession.isCurrent).toBe(true);
    expect(chromeSession.city).toBe('Delhi');

    expect(edgeSession).toBeDefined();
    expect(edgeSession.isCurrent).toBe(false);
    expect(edgeSession.city).toBe('Mumbai');
  });

  it('6. Revokes a specific session by ID', async () => {
    // Login on Device A
    const loginA = await request(app)
      .post('/api/auth/login')
      .send({ username: testEmail, password: testPassword });
    const cookiesA = loginA.headers['set-cookie'];
    const tokenCookieA = cookiesA.find((c) => c.startsWith('token=')).split(';')[0];
    const refreshCookieA = cookiesA.find((c) => c.startsWith('refreshToken=')).split(';')[0];

    // Login on Device B
    const loginB = await request(app)
      .post('/api/auth/login')
      .send({ username: testEmail, password: testPassword });

    // Fetch sessions from Device A
    const listRes = await request(app)
      .get('/api/auth/sessions')
      .set('Cookie', [tokenCookieA, refreshCookieA]);

    const sessionB = listRes.body.sessions.find((s) => !s.isCurrent);
    expect(sessionB).toBeDefined();

    // Revoke Session B from Device A
    const revokeRes = await request(app)
      .delete(`/api/auth/sessions/${sessionB._id}`)
      .set('Cookie', [tokenCookieA, refreshCookieA]);

    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.message).toMatch(/revoked/i);

    // Verify Session B is marked isRevoked in DB
    const sessionBInDb = await RefreshToken.findById(sessionB._id);
    expect(sessionBInDb.isRevoked).toBe(true);

    // Verify only 1 active session remains
    const remainingActive = await RefreshToken.find({ user: testUser._id, isRevoked: false });
    expect(remainingActive.length).toBe(1);
  });

  it('7. Revokes all other sessions except current session', async () => {
    // Login Session 1
    const login1 = await request(app)
      .post('/api/auth/login')
      .send({ username: testEmail, password: testPassword });
    const cookies1 = login1.headers['set-cookie'];
    const tokenCookie1 = cookies1.find((c) => c.startsWith('token=')).split(';')[0];
    const refreshCookie1 = cookies1.find((c) => c.startsWith('refreshToken=')).split(';')[0];

    // Login Session 2
    await request(app)
      .post('/api/auth/login')
      .send({ username: testEmail, password: testPassword });

    // Login Session 3
    await request(app)
      .post('/api/auth/login')
      .send({ username: testEmail, password: testPassword });

    const beforeCount = await RefreshToken.countDocuments({ user: testUser._id, isRevoked: false });
    expect(beforeCount).toBe(3);

    // Revoke all other sessions from Session 1
    const revokeOthersRes = await request(app)
      .post('/api/auth/sessions/revoke-others')
      .set('Cookie', [tokenCookie1, refreshCookie1]);

    expect(revokeOthersRes.status).toBe(200);
    expect(revokeOthersRes.body.revokedCount).toBe(2);

    // Only Session 1 remains active
    const afterCount = await RefreshToken.countDocuments({ user: testUser._id, isRevoked: false });
    expect(afterCount).toBe(1);
  });
});
