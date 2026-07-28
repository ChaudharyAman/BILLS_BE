/**
 * tests/unit/salaryRevisionHelper.test.js
 *
 * Unit tests for salaryRevisionHelper and historical payroll correctness via getEmployeeParamsForDate().
 */

const { appendSalaryRevisionIfChanged } = require('../../utils/salaryRevisionHelper');
const { getEmployeeParamsForDate } = require('../../utils/payrollMath/proration');

describe('Salary Revision Helper & Historical Payroll Protection', () => {
  let mockEmployee;

  beforeEach(() => {
    mockEmployee = {
      _id: 'emp123',
      employeeId: 'EMP001',
      joiningDate: new Date('2025-01-01'),
      monthlyCTC: 50000,
      hourlyRate: 0,
      dailyRate: 0,
      payType: 'salaried',
      employmentType: 'full-time',
      useSalaryComponents: true,
      pfEnabled: true,
      esiEnabled: true,
      ptEnabled: true,
      lwfEnabled: true,
      gratuityEnabled: true,
      salaryRevisions: [],
    };
  });

  test('bootstraps initial revision and appends new revision when monthlyCTC changes', async () => {
    const updateData = { monthlyCTC: 75000 };
    const effectiveDate = new Date('2026-06-01');

    const result = await appendSalaryRevisionIfChanged({
      employee: mockEmployee,
      updateData,
      effectiveDate,
      reason: 'Annual Performance Appraisal',
      revisedBy: 'user123',
    });

    expect(result).not.toBeNull();
    // Since mockEmployee started with empty salaryRevisions[], it should now have 2 entries: initial bootstrap + new revision
    expect(mockEmployee.salaryRevisions.length).toBe(2);

    const initialBootstrap = mockEmployee.salaryRevisions[0];
    expect(initialBootstrap.reason).toBe('Initial Salary Setup');
    expect(initialBootstrap.monthlyCTC).toBe(50000);

    const newRevision = mockEmployee.salaryRevisions[1];
    expect(newRevision.reason).toBe('Annual Performance Appraisal');
    expect(newRevision.previousCTC).toBe(50000);
    expect(newRevision.newCTC).toBe(75000);
    expect(newRevision.monthlyCTC).toBe(75000);
    expect(newRevision.effectiveDate).toEqual(effectiveDate);
  });

  test('no-op when no pay-related fields change', async () => {
    const updateData = { designation: 'Senior Software Engineer', location: 'Bengaluru' };

    const result = await appendSalaryRevisionIfChanged({
      employee: mockEmployee,
      updateData,
      reason: 'Designation update',
    });

    expect(result).toBeNull();
    expect(mockEmployee.salaryRevisions.length).toBe(0);
  });

  test('detects hourlyRate changes for hourly employees', async () => {
    mockEmployee.payType = 'hourly';
    mockEmployee.compensationType = 'hourly';
    mockEmployee.monthlyCTC = 0;
    mockEmployee.hourlyRate = 400;

    const updateData = { hourlyRate: 600 };
    const result = await appendSalaryRevisionIfChanged({
      employee: mockEmployee,
      updateData,
      reason: 'Hourly rate revision',
      revisedBy: 'System (HRMS Sync)',
    });

    expect(result).not.toBeNull();
    expect(mockEmployee.salaryRevisions.length).toBe(2);
    expect(result.previousHourlyRate).toBe(400);
    expect(result.newHourlyRate).toBe(600);
  });

  test('detects rateCard changes', async () => {
    mockEmployee.rateCard = [{ paymentType: 'PROJECT', rate: 10000, unit: 'project' }];
    const updateData = { rateCard: [{ paymentType: 'PROJECT', rate: 15000, unit: 'project' }] };

    const result = await appendSalaryRevisionIfChanged({
      employee: mockEmployee,
      updateData,
      reason: 'Rate card update',
    });

    expect(result).not.toBeNull();
    expect(mockEmployee.salaryRevisions.length).toBe(2);
  });

  test('getEmployeeParamsForDate() returns OLD CTC for past dates after CTC update', async () => {
    const updateDate = new Date('2026-06-01');

    // 1. Update employee CTC from 50,000 to 80,000 effective on updateDate
    await appendSalaryRevisionIfChanged({
      employee: mockEmployee,
      updateData: { monthlyCTC: 80000 },
      effectiveDate: updateDate,
      reason: 'Mid-year revision',
    });
    mockEmployee.monthlyCTC = 80000;

    // 2. Query parameters for a past date (March 2025: '2025-03-15')
    const pastParams = getEmployeeParamsForDate(mockEmployee, '2025-03-15');
    expect(pastParams.monthlyCTC).toBe(50000);

    // 3. Query parameters for current date (July 2026: '2026-07-01')
    const currentParams = getEmployeeParamsForDate(mockEmployee, '2026-07-01');
    expect(currentParams.monthlyCTC).toBe(80000);
  });
});

// ─── Non-component compensation type regression tests ────────────────────────
describe('daily_wage / non-component type revision logic', () => {
  function makeDailyWageEmployee(overrides = {}) {
    return {
      _id: 'emp-dw-01',
      employeeId: 'EMP-DW-01',
      joiningDate: new Date('2025-03-01'),
      compensationType: 'daily_wage',
      payType: 'salaried',
      monthlyCTC: 0,
      hourlyRate: 0,
      dailyRate: 500,
      weeklyRate: 0,
      projectFee: 0,
      milestoneAmount: 0,
      commissionNotes: '',
      rateCard: [],
      employmentType: 'full-time',
      useSalaryComponents: false,
      pfEnabled: false,
      esiEnabled: false,
      ptEnabled: false,
      lwfEnabled: false,
      gratuityEnabled: false,
      salaryRevisions: [],
      ...overrides,
    };
  }

  test('dailyRate change creates revision with dailyRate populated and CTC/statutory correctly zeroed', async () => {
    const employee = makeDailyWageEmployee();
    const updateData = { dailyRate: 650 };

    const result = await appendSalaryRevisionIfChanged({
      employee,
      updateData,
      effectiveDate: new Date('2026-07-01'),
      reason: 'Daily rate hike',
      revisedBy: 'admin',
    });

    expect(result).not.toBeNull();
    // Bootstrap + new revision
    expect(employee.salaryRevisions.length).toBe(2);

    // ── Bootstrap entry assertions ──
    const bootstrap = employee.salaryRevisions[0];
    expect(bootstrap.compensationType).toBe('daily_wage');
    expect(bootstrap.dailyRate).toBe(500);      // captured from original employee
    expect(bootstrap.monthlyCTC).toBe(0);       // must NOT be defaulted to old value
    expect(bootstrap.pfEnabled).toBe(false);    // non-component type: must stay false
    expect(bootstrap.esiEnabled).toBe(false);
    expect(bootstrap.gratuityEnabled).toBe(false);
    expect(bootstrap.useSalaryComponents).toBe(false);

    // ── New revision entry assertions ──
    expect(result.compensationType).toBe('daily_wage');
    expect(result.dailyRate).toBe(650);         // updated value snapshotted
    expect(result.monthlyCTC).toBe(0);          // non-component: must be 0, not newCTC
    expect(result.pfEnabled).toBe(false);
    expect(result.esiEnabled).toBe(false);
    expect(result.gratuityEnabled).toBe(false);
    expect(result.useSalaryComponents).toBe(false);
    // CTC history fields must be zeroed for non-component types
    expect(result.previousCTC).toBe(0);
    expect(result.newCTC).toBe(0);
  });

  test('weeklyRate change triggers a revision entry', async () => {
    const employee = makeDailyWageEmployee({ compensationType: 'weekly_salary', weeklyRate: 3000 });
    const result = await appendSalaryRevisionIfChanged({
      employee,
      updateData: { weeklyRate: 3500 },
      reason: 'Weekly rate hike',
    });

    expect(result).not.toBeNull();
    expect(result.weeklyRate).toBe(3500);
  });

  test('projectFee change triggers a revision entry for project_based employee', async () => {
    const employee = makeDailyWageEmployee({ compensationType: 'project_based', projectFee: 20000, dailyRate: 0 });
    const result = await appendSalaryRevisionIfChanged({
      employee,
      updateData: { projectFee: 25000 },
      reason: 'Project fee renegotiated',
    });

    expect(result).not.toBeNull();
    expect(result.projectFee).toBe(25000);
    expect(result.monthlyCTC).toBe(0);
  });

  test('milestoneAmount change triggers a revision entry for milestone_based employee', async () => {
    const employee = makeDailyWageEmployee({ compensationType: 'milestone_based', milestoneAmount: 50000, dailyRate: 0 });
    const result = await appendSalaryRevisionIfChanged({
      employee,
      updateData: { milestoneAmount: 60000 },
      reason: 'Milestone payout increase',
    });

    expect(result).not.toBeNull();
    expect(result.milestoneAmount).toBe(60000);
  });

  test('non-pay field change on daily_wage employee produces no revision', async () => {
    const employee = makeDailyWageEmployee();
    const result = await appendSalaryRevisionIfChanged({
      employee,
      updateData: { designation: 'Site Worker' },
    });

    expect(result).toBeNull();
    expect(employee.salaryRevisions.length).toBe(0);
  });
});

// ─── Round-trip schema persistence test ──────────────────────────────────────
// Guards against a regression of the strict sub-schema fix (part c):
// if dailyRate/weeklyRate/projectFee/milestoneAmount/commissionNotes are ever
// removed from the salaryRevisions inline sub-schema, Mongoose strict mode will
// silently drop them on save and this test will catch it.
describe('salaryRevisions sub-schema round-trip persistence (Mongoose + MongoMemoryServer)', () => {
  const mongoose = require('mongoose');
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const Employee = require('../../models/Employee');

  let mongod;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  }, 60000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  afterEach(async () => {
    await Employee.deleteMany({});
  });

  test('dailyRate and non-component rate fields survive a Mongoose save/reload cycle', async () => {
    const fakeUserId = new mongoose.Types.ObjectId();
    const emp = await Employee.create({
      user: fakeUserId,
      employeeId: 'EMP-SCHEMA-RT-01',
      firstName: 'Schema',
      lastName: 'RoundTrip',
      email: 'schema.rt@test.local',
      joiningDate: new Date('2025-01-01'),
      compensationType: 'daily_wage',
      dailyRate: 0,
      monthlyCTC: 0,
      salaryRevisions: [],
    });

    // Run the helper against the live Mongoose document
    await appendSalaryRevisionIfChanged({
      employee: emp,
      updateData: {
        dailyRate:       750,
        weeklyRate:      3750,
        projectFee:      15000,
        milestoneAmount: 40000,
        commissionNotes: 'Q3 target bonus',
      },
      effectiveDate: new Date('2026-07-01'),
      reason: 'Schema persistence test',
    });

    // Persist via Mongoose — strict sub-schema drops undeclared fields silently here
    await emp.save();

    // Reload from MongoDB and verify the fields actually survived
    const reloaded = await Employee.findById(emp._id).lean();
    expect(reloaded.salaryRevisions).toHaveLength(2); // bootstrap + new

    const rev = reloaded.salaryRevisions[1];
    expect(rev.dailyRate).toBe(750);
    expect(rev.weeklyRate).toBe(3750);
    expect(rev.projectFee).toBe(15000);
    expect(rev.milestoneAmount).toBe(40000);
    expect(rev.commissionNotes).toBe('Q3 target bonus');
    // Non-component type: these must be zeroed/false after round-trip
    expect(rev.monthlyCTC).toBe(0);
    expect(rev.pfEnabled).toBe(false);
  });
});
