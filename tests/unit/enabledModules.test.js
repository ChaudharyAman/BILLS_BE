/**
 * tests/unit/enabledModules.test.js
 *
 * Unit tests for the Organization-level Enabled Modules system:
 * 1. Default system modules fallback
 * 2. protect & authorize middleware scoping permissions to enabledModules
 * 3. Blocking disabled modules with 403 Forbidden
 * 4. Super Admin bypass
 * 5. updateUserPlan updating enabledModules & modulePermissions
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../../models/User');
const AccessRole = require('../../models/AccessRole');
const AdminAuditLog = require('../../models/AdminAuditLog');
const { protect, authorize } = require('../../middleware/authMiddleware');
const { updateUserPlan } = require('../../controllers/adminController');
const { createAccessRole } = require('../../controllers/teamMemberController');
const jwt = require('jsonwebtoken');

let mongoServer;
const JWT_SECRET = 'test_secret_for_enabled_modules_123';

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
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

describe('Enabled Modules System', () => {
  test('User model defaults enabledModules to undefined, allowing full access', async () => {
    const owner = await User.create({
      username: 'owner_default',
      email: 'owner_default@example.com',
      password: 'Password123!',
      role: 'user',
      isOwner: true,
    });

    expect(owner.enabledModules).toBeUndefined();
  });

  test('authorize middleware blocks request when module is disabled in ownerUser.enabledModules', async () => {
    const owner = await User.create({
      username: 'owner_restricted',
      email: 'owner_res@example.com',
      password: 'Password123!',
      role: 'user',
      isOwner: true,
      enabledModules: ['invoices', 'expenses'], // payroll is omitted
    });

    const req = {
      user: owner,
      ownerUser: owner,
      permissions: { payroll: { view: true } },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    const authMiddleware = authorize('payroll', 'view');
    await authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("The 'payroll' module is disabled for your organization"),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  test('authorize middleware permits request when module is enabled', async () => {
    const owner = await User.create({
      username: 'owner_allowed',
      email: 'owner_allow@example.com',
      password: 'Password123!',
      role: 'user',
      isOwner: true,
      enabledModules: ['invoices', 'expenses'],
    });

    const req = {
      user: owner,
      ownerUser: owner,
      permissions: { invoices: { view: true } },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    const authMiddleware = authorize('invoices', 'view');
    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('Super Admin bypasses enabledModules restrictions', async () => {
    const admin = await User.create({
      username: 'superadmin_test',
      email: 'admin_test@example.com',
      password: 'Password123!',
      role: 'superadmin',
      isOwner: true,
    });

    const req = {
      user: admin,
      ownerUser: {
        ...admin.toObject(),
        enabledModules: ['invoices'], // disabled payroll
      },
      permissions: {},
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    const authMiddleware = authorize('payroll', 'view');
    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('updateUserPlan updates enabledModules and logs audit record', async () => {
    const admin = await User.create({
      username: 'superadmin_updater',
      email: 'updater@example.com',
      password: 'Password123!',
      role: 'superadmin',
      isOwner: true,
    });

    const owner = await User.create({
      username: 'company_to_update',
      email: 'co_update@example.com',
      password: 'Password123!',
      role: 'user',
      isOwner: true,
    });

    const req = {
      params: { id: owner._id.toString() },
      body: {
        enabledModules: ['invoices', 'expenses', 'assets'],
      },
      user: admin,
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await updateUserPlan(req, res);

    expect(res.json).toHaveBeenCalled();
    const updatedUser = await User.findById(owner._id);
    expect(updatedUser.enabledModules).toEqual(['invoices', 'expenses', 'assets']);

    const auditLog = await AdminAuditLog.findOne({
      targetId: owner._id,
      action: 'UPDATE_USER_MODULES',
    });
    expect(auditLog).toBeDefined();
    expect(auditLog.metadata.enabledModules).toEqual(['invoices', 'expenses', 'assets']);
  });

  test('createAccessRole strips permissions for disabled modules when creating a custom role', async () => {
    const owner = await User.create({
      username: 'owner_for_roles',
      email: 'owner_roles@example.com',
      password: 'Password123!',
      role: 'user',
      isOwner: true,
      enabledModules: ['invoices', 'expenses'], // payroll, loans disabled
    });

    const req = {
      companyId: owner._id,
      ownerUser: owner,
      body: {
        name: 'Accountant Role',
        description: 'Testing disabled module scoping',
        permissions: {
          invoices: { view: true, create: true, edit: false, delete: false, approve: false },
          payroll: { view: true, create: true, edit: true, delete: true, approve: true }, // Should be stripped!
        },
      },
    };

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await createAccessRole(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    const createdRole = res.json.mock.calls[0][0];
    expect(createdRole).toBeDefined();

    // Invoices should remain enabled
    const invoicePerms = createdRole.permissions.get('invoices');
    expect(invoicePerms.view).toBe(true);
    expect(invoicePerms.create).toBe(true);

    // Payroll must be stripped (all false) because it is not enabled for the company
    const payrollPerms = createdRole.permissions.get('payroll');
    expect(payrollPerms.view).toBe(false);
    expect(payrollPerms.create).toBe(false);
    expect(payrollPerms.edit).toBe(false);
    expect(payrollPerms.delete).toBe(false);
  });
});

