const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../../models/User');
const AccessRole = require('../../models/AccessRole');
const AdminAuditLog = require('../../models/AdminAuditLog');
const {
  updateUserPlan,
  deleteUser,
  getCompanies,
  updateTeamMember,
} = require('../../controllers/adminController');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();
  await mongoose.connect(uri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
  await AccessRole.deleteMany({});
  await AdminAuditLog.deleteMany({});
});

describe('Admin Controller Guards & Audit Logging', () => {
  test('Self-demotion of superadmin is forbidden', async () => {
    const adminUser = await User.create({
      username: 'superadmin1',
      email: 'admin1@example.com',
      password: 'Password123!',
      role: 'superadmin',
      isOwner: true,
    });

    const req = {
      params: { id: adminUser._id },
      body: { role: 'user' },
      user: adminUser,
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await updateUserPlan(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Self-demotion is forbidden') })
    );
  });

  test('Demoting or deactivating the last active superadmin is forbidden', async () => {
    const adminUser = await User.create({
      username: 'superadmin1',
      email: 'admin1@example.com',
      password: 'Password123!',
      role: 'superadmin',
      isOwner: true,
    });

    const otherAdmin = await User.create({
      username: 'superadmin2',
      email: 'admin2@example.com',
      password: 'Password123!',
      role: 'superadmin',
      isOwner: true,
    });

    const req = {
      params: { id: adminUser._id },
      body: { role: 'user' },
      user: otherAdmin,
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await updateUserPlan(req, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ role: 'user' }));

    // Now otherAdmin is the last superadmin. Try deactivating them.
    const reqDeactivate = {
      params: { id: otherAdmin._id },
      body: { isActive: false },
      user: adminUser,
    };
    const resDeactivate = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await updateUserPlan(reqDeactivate, resDeactivate);
    expect(resDeactivate.status).toHaveBeenCalledWith(400);
    expect(resDeactivate.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('last remaining active Super Admin') })
    );
  });

  test('Delete user with active team members requires force=true', async () => {
    const adminUser = await User.create({
      username: 'superadmin1',
      email: 'admin1@example.com',
      password: 'Password123!',
      role: 'superadmin',
    });

    const owner = await User.create({
      username: 'owner1',
      email: 'owner1@example.com',
      password: 'Password123!',
      role: 'user',
      isOwner: true,
    });
    owner.companyId = owner._id;
    await owner.save();

    await User.create({
      username: 'member1',
      email: 'member1@example.com',
      password: 'Password123!',
      role: 'user',
      companyId: owner._id,
      isOwner: false,
    });

    const reqWithoutForce = {
      params: { id: owner._id },
      query: {},
      user: adminUser,
    };
    const resWithoutForce = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await deleteUser(reqWithoutForce, resWithoutForce);

    expect(resWithoutForce.status).toHaveBeenCalledWith(400);
    expect(resWithoutForce.json).toHaveBeenCalledWith(
      expect.objectContaining({ requiresForce: true, teamMemberCount: 1 })
    );

    // Now delete with force=true
    const reqWithForce = {
      params: { id: owner._id },
      query: { force: 'true' },
      user: adminUser,
    };
    const resWithForce = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await deleteUser(reqWithForce, resWithForce);

    expect(resWithForce.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('deleted successfully') })
    );

    const remainingMembers = await User.countDocuments({ companyId: owner._id });
    expect(remainingMembers).toBe(0);

    const logs = await AdminAuditLog.find({ action: 'DELETE_USER' });
    expect(logs.length).toBe(1);
  });
});
