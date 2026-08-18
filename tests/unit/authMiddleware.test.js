/**
 * tests/unit/authMiddleware.test.js
 *
 * Security test suite for authentication middleware (Bug 6 guard).
 * Asserts that JWT tokens passed in URL query strings are rejected.
 */

const jwt = require('jsonwebtoken');
const { protect } = require('../../middleware/authMiddleware');
const User = require('../../models/User');

jest.mock('../../models/User');
jest.mock('../../utils/subscriptionLifecycle', () => ({
  syncExpiredSubscription: jest.fn().mockResolvedValue(true),
}));

describe('Auth Middleware Security Tests (Bug 6 Guard)', () => {
  const secret = 'test_jwt_secret_key_123';
  const originalSecret = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = secret;
  });

  afterAll(() => {
    process.env.JWT_SECRET = originalSecret;
  });

  test('rejects request when token is passed as ?token=<jwt> query parameter and no Authorization header is present', async () => {
    const validToken = jwt.sign({ id: '507f1f77bcf86cd799439011' }, secret);

    const req = {
      headers: {},
      query: { token: validToken },
      cookies: {},
    };

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    const next = jest.fn();

    await protect(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Not authorized, no token' });
    expect(next).not.toHaveBeenCalled();
  });

  test('accepts request when valid Bearer token is provided in Authorization header', async () => {
    const userId = '507f1f77bcf86cd799439011';
    const validToken = jwt.sign({ id: userId }, secret);

    const mockUser = {
      _id: userId,
      isActive: true,
      subscription: { plan: 'free' },
    };

    User.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        populate: jest.fn().mockResolvedValue(mockUser),
      }),
    });

    const req = {
      headers: {
        authorization: `Bearer ${validToken}`,
      },
      query: {},
      cookies: {},
    };

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    const next = jest.fn();

    await protect(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toEqual(mockUser);
  });
});
