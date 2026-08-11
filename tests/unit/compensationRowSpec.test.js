/**
 * tests/unit/compensationRowSpec.test.js
 *
 * Unit test suite for shared compensation row specification helper (Bug 7).
 * Asserts that resolveNonComponentRowSpec returns authoritative name, details,
 * and amount for all non-component compensation types.
 */

const { NON_COMPONENT_TYPES, resolveNonComponentRowSpec } = require('../../utils/payrollMath/compensationRowSpec');

describe('Shared Compensation Row Specifications (Bug 7)', () => {
  test('NON_COMPONENT_TYPES set contains all 8 non-component compensation types', () => {
    const expectedTypes = [
      'hourly',
      'timesheet_based',
      'daily_wage',
      'piece_rate',
      'project_based',
      'milestone_based',
      'retainer',
      'commission_only',
    ];
    expectedTypes.forEach((t) => {
      expect(NON_COMPONENT_TYPES.has(t)).toBe(true);
    });
  });

  test('hourly: resolves name, rate math, and details string', () => {
    const payroll = {
      hoursWorked: 20,
      hourlyRate: 500,
      earnings: { totalEarnings: 10000 },
    };
    const spec = resolveNonComponentRowSpec('hourly', payroll);
    expect(spec).toEqual({
      name: 'Hourly Wages',
      amount: 10000,
      details: '20 hrs × ₹500/hr',
    });
  });

  test('timesheet_based: resolves timesheet title and details string', () => {
    const payroll = {
      periodInput: { hoursLogged: 160 },
      hourlyRate: 400,
      earnings: { totalEarnings: 64000 },
    };
    const spec = resolveNonComponentRowSpec('timesheet_based', payroll);
    expect(spec).toEqual({
      name: 'Timesheet Logged Hours Pay',
      amount: 64000,
      details: '160 hrs × ₹400/hr',
    });
  });

  test('daily_wage: resolves daily wage name and rate details', () => {
    const payroll = {
      paidDays: 22,
      employeeSnapshot: { dailyRate: 1200 },
      earnings: { totalEarnings: 26400 },
    };
    const spec = resolveNonComponentRowSpec('daily_wage', payroll);
    expect(spec).toEqual({
      name: 'Daily Wage Earnings',
      amount: 26400,
      details: '22 days × ₹1200/day',
    });
  });

  test('piece_rate: resolves unitType output pay and details', () => {
    const payroll = {
      periodInput: { unitsProduced: 50, ratePerUnit: 200, unitType: 'Boxes' },
      earnings: { totalEarnings: 10000 },
    };
    const spec = resolveNonComponentRowSpec('piece_rate', payroll);
    expect(spec).toEqual({
      name: 'Boxes Output Pay',
      amount: 10000,
      details: '50 units × ₹200/unit',
    });
  });

  test('project_based: resolves project fee name with description reference', () => {
    const payroll = {
      periodInput: { projectFee: 45000, projectRef: 'Website Redesign' },
      earnings: { totalEarnings: 45000 },
    };
    const spec = resolveNonComponentRowSpec('project_based', payroll);
    expect(spec).toEqual({
      name: 'Project Fee — Website Redesign',
      amount: 45000,
      details: 'Approved Project Deliverable Fee',
    });
  });

  test('milestone_based: resolves milestone deliverable title and ref', () => {
    const payroll = {
      periodInput: { milestoneAmount: 30000, milestoneRef: 'Phase 1 MVP' },
      earnings: { totalEarnings: 30000 },
    };
    const spec = resolveNonComponentRowSpec('milestone_based', payroll);
    expect(spec).toEqual({
      name: 'Milestone Deliverable: Phase 1 MVP',
      amount: 30000,
      details: 'Completed Milestone Payment',
    });
  });

  test('retainer: resolves monthly retainer fee name and details', () => {
    const payroll = {
      earnings: { totalEarnings: 75000 },
    };
    const spec = resolveNonComponentRowSpec('retainer', payroll);
    expect(spec).toEqual({
      name: 'Monthly Retainer Fee',
      amount: 75000,
      details: 'Fixed Service Retainer Contract',
    });
  });

  test('commission_only: resolves commission earnings title and variable sum', () => {
    const payroll = {
      earnings: {
        variableCompensation: [
          { amount: 15000 },
          { amount: 10000 },
        ],
      },
    };
    const spec = resolveNonComponentRowSpec('commission_only', payroll);
    expect(spec).toEqual({
      name: 'Commission Earnings',
      amount: 25000,
      details: 'Commission Earnings',
    });
  });
});
