/**
 * tests/unit/googleAuth.test.js
 *
 * Unit tests for Google OAuth authentication controller (googleLogin).
 */

const axios = require('axios');
const jwt = require('jsonwebtoken');
const { googleLogin } = require('../../controllers/authController');
const User = require('../../models/User');

jest.mock('axios');
jest.mock('../../models/User');
jest.mock('../../utils/subscriptionLifecycle', () => ({
  syncExpiredSubscription: jest.fn().mockResolvedValue(true),
}));

describe('Google OAuth Controller Tests', () => {
  const secret = 'test_jwt_secret_google_auth';
  const clientId = '725664292682-ck24ngvdki7hs66qrvnm79lis1ov5e07.apps.googleusercontent.com';
  const originalSecret = process.env.JWT_SECRET;
  const originalClientId = process.env.GOOGLE_CLIENT_ID;

  beforeAll(() => {
    process.env.JWT_SECRET = secret;
    process.env.GOOGLE_CLIENT_ID = clientId;
  });

  afterAll(() => {
    process.env.JWT_SECRET = originalSecret;
    process.env.GOOGLE_CLIENT_ID = originalClientId;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const mockResponse = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    res.cookie = jest.fn().mockReturnValue(res);
    return res;
  };

  test('rejects request with 400 when credential token is missing', async () => {
    const req = { body: {}, get: () => '' };
    const res = mockResponse();

    await googleLogin(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringMatching(/credential/i),
    }));
  });

  test('rejects request with 401 when Google token verification fails', async () => {
    axios.get.mockRejectedValue(new Error('Invalid token'));

    const req = { body: { credential: 'bad_token' }, get: () => '' };
    const res = mockResponse();

    await googleLogin(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringMatching(/invalid or expired/i),
    }));
  });

  test('rejects request with 401 when token audience does not match configured client ID', async () => {
    axios.get.mockResolvedValue({
      data: {
        aud: 'wrong-audience.apps.googleusercontent.com',
        iss: 'https://accounts.google.com',
        email: 'user@example.com',
        email_verified: 'true',
      },
    });

    const req = { body: { credential: 'valid_token_wrong_aud' }, get: () => '' };
    const res = mockResponse();

    await googleLogin(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringMatching(/audience does not match/i),
    }));
  });

  test('authenticates existing user successfully and returns JWT', async () => {
    const existingUser = {
      _id: '507f1f77bcf86cd799439011',
      username: 'johndoe',
      email: 'john@example.com',
      avatar: 'https://lh3.googleusercontent.com/photo.jpg',
      role: 'user',
      isOwner: true,
      companyId: null,
      isActive: true,
      status: 'active',
      subscription: { plan: 'free', status: 'active' },
      save: jest.fn().mockResolvedValue(true),
    };

    axios.get.mockResolvedValue({
      data: {
        aud: clientId,
        iss: 'https://accounts.google.com',
        email: 'john@example.com',
        email_verified: 'true',
        name: 'John Doe',
        picture: 'https://lh3.googleusercontent.com/photo.jpg',
      },
    });

    User.findOne.mockResolvedValue(existingUser);

    const req = { body: { credential: 'good_token' }, get: () => 'http://localhost:5173' };
    const res = mockResponse();

    await googleLogin(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      token: expect.any(String),
      user: expect.objectContaining({
        email: 'john@example.com',
        username: 'johndoe',
      }),
    }));
    expect(res.cookie).toHaveBeenCalled();
  });

  test('auto-provisions new user when email does not exist yet', async () => {
    const newUser = {
      _id: '507f1f77bcf86cd799439099',
      username: 'alice',
      email: 'alice@example.com',
      avatar: 'https://lh3.googleusercontent.com/alice.jpg',
      role: 'user',
      isOwner: true,
      companyId: null,
      status: 'active',
      subscription: { plan: 'free', status: 'active' },
    };

    axios.get.mockResolvedValue({
      data: {
        aud: clientId,
        iss: 'accounts.google.com',
        email: 'alice@example.com',
        email_verified: 'true',
        name: 'Alice Smith',
        picture: 'https://lh3.googleusercontent.com/alice.jpg',
      },
    });

    // First findOne for email check -> null, then for username check -> null
    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValue(newUser);

    const req = { body: { credential: 'new_user_token' }, get: () => 'http://localhost:5173' };
    const res = mockResponse();

    await googleLogin(req, res);

    expect(User.create).toHaveBeenCalledWith(expect.objectContaining({
      email: 'alice@example.com',
      isOwner: true,
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      token: expect.any(String),
      user: expect.objectContaining({
        email: 'alice@example.com',
      }),
    }));
  });
});
