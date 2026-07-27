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
