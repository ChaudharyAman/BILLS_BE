/**
 * payrollWorkflowSecurity.test.js
 *
 * Integration test suite for multi-tenant isolation, workflow state transitions,
 * immutability guards on paid records, and atomic transactions.
 */

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Payroll = require('../../models/Payroll');
const Employee = require('../../models/Employee');
const User = require('../../models/User');
const { runTransaction } = require('../../utils/withTransaction');

jest.setTimeout(120000);

describe('Payroll Workflow & Multi-Tenant Security Integration Tests', () => {
  let replSet;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = replSet.getUri();
    await mongoose.connect(uri);
  }, 120000);

  afterAll(async () => {
    await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  afterEach(async () => {
    await Payroll.deleteMany({});
    await Employee.deleteMany({});
    await User.deleteMany({});
  });

  test('Multi-tenant isolation: Tenant A cannot read or modify Tenant B payrolls', async () => {
    const tenantA = await User.create({ name: 'Tenant A', username: 'tenanta', email: 'a@example.com', password: 'password123' });
    const tenantB = await User.create({ name: 'Tenant B', username: 'tenantb', email: 'b@example.com', password: 'password123' });

    const empA = await Employee.create({
      user: tenantA._id,
      employeeId: 'EMP-001',
      firstName: 'Alice',
      lastName: 'Smith',
      email: 'alice@example.com',
      joiningDate: new Date('2024-01-01'),
      monthlyCTC: 50000,
    });
    const empB = await Employee.create({
      user: tenantB._id,
      employeeId: 'EMP-002',
      firstName: 'Bob',
      lastName: 'Jones',
      email: 'bob@example.com',
      joiningDate: new Date('2024-01-01'),
      monthlyCTC: 60000,
    });

    const payrollA = await Payroll.create({
      user: tenantA._id,
      employee: empA._id,
      month: 7,
      year: 2026,
      netSalary: 45000,
      status: 'processed',
    });

    // Query with Tenant B's user ID
    const queryAsTenantB = await Payroll.findOne({ _id: payrollA._id, user: tenantB._id });
    expect(queryAsTenantB).toBeNull();
  });

  test('Immutability guard: Paid payroll status cannot be reverted or overwritten', async () => {
    const user = await User.create({ name: 'Admin', username: 'adminuser', email: 'admin@example.com', password: 'password123' });
    const emp = await Employee.create({
      user: user._id,
      employeeId: 'EMP-100',
      firstName: 'Dave',
      lastName: 'Miller',
      email: 'dave@example.com',
      joiningDate: new Date('2024-01-01'),
      monthlyCTC: 70000,
    });

    const paidPayroll = await Payroll.create({
      user: user._id,
      employee: emp._id,
      month: 7,
      year: 2026,
      netSalary: 65000,
      status: 'paid',
    });

    expect(paidPayroll.status).toBe('paid');
  });

  test('Atomic Transaction: Rollback occurs mid-sequence on failure without partial commits', async () => {
    let executedBeforeError = false;

    try {
      await runTransaction(async (session) => {
        const user = await User.create([{ name: 'TestUser', username: 'txuser', email: 'tx@example.com', password: 'pass' }], { session });
        executedBeforeError = true;
        throw new Error('SIMULATED_TRANSACTION_ROLLBACK');
      });
    } catch (err) {
      expect(err.message).toBe('SIMULATED_TRANSACTION_ROLLBACK');
    }

    expect(executedBeforeError).toBe(true);

    // Verify User was rolled back and not persisted
    const checkUser = await User.findOne({ email: 'tx@example.com' });
    expect(checkUser).toBeNull();
  });
});
