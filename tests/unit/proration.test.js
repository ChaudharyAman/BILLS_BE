// proration.test.js - Unit tests for Bug 1, Bug 2, Bug 3 proration/strategy fixes
'use strict';

const { getEmployeeParamsForDate, getSegmentLops } = require('../../utils/payrollMath/proration');
const { getSalarySplits, DEFAULT_PAYROLL_CONFIG }  = require('../../utils/payrollMath');
const { listCompensationTypes, resolveStrategy }    = require('../../utils/payrollStrategies/index');

// ---- Bug 1: getEmployeeParamsForDate CTC resolution ----

describe('getEmployeeParamsForDate CTC resolution Bug1', () => {

  test('AC1: no salaryRevisions returns the employee object unchanged', () => {
    const emp = { monthlyCTC: 50000, compensationType: 'monthly_salary', salaryRevisions: [] };
    expect(getEmployeeParamsForDate(emp, '2026-07-10')).toBe(emp);
  });

  describe('AC2: single revision on July 15 previousCTC=50000 newCTC=60000', () => {
    const emp = {
      monthlyCTC: 60000,
      compensationType: 'monthly_salary',
      pfEnabled: true, esiEnabled: false, ptEnabled: false,
      salaryRevisions: [
        { effectiveDate: new Date('2026-07-15'), previousCTC: 50000, newCTC: 60000 },
      ],
    };

    test('day 1 before revision uses previousCTC 50000', () => {
      expect(getEmployeeParamsForDate(emp, '2026-07-01').monthlyCTC).toBe(50000);
    });
    test('day 14 before revision uses previousCTC 50000', () => {
      expect(getEmployeeParamsForDate(emp, '2026-07-14').monthlyCTC).toBe(50000);
    });
    test('day 15 on effectiveDate returns employee with monthlyCTC 60000', () => {
      const p = getEmployeeParamsForDate(emp, '2026-07-15');
      expect(p).toBe(emp);
      expect(p.monthlyCTC).toBe(60000);
    });
    test('day 31 after effectiveDate returns employee with monthlyCTC 60000', () => {
      const p = getEmployeeParamsForDate(emp, '2026-07-31');
      expect(p).toBe(emp);
      expect(p.monthlyCTC).toBe(60000);
    });
    test('getSalarySplits pre-revision segment has lower gross than post-revision', () => {
      const splits = getSalarySplits(emp, DEFAULT_PAYROLL_CONFIG, 7, 2026, 31, 31, {});
      expect(splits.length).toBe(2);
      // getSalarySplits returns {startDate, endDate, daysCount, monthlyCTC, totalEarnings, ...}
      // Segment 0: days 1-14 (pre-revision, 14 days), Segment 1: days 15-31 (post-revision, 17 days)
      const pre  = splits.find(s => new Date(s.startDate).getUTCDate() === 1);
      const post = splits.find(s => new Date(s.startDate).getUTCDate() === 15);
      expect(pre).toBeDefined();
      expect(post).toBeDefined();
      expect(pre.totalEarnings).toBeLessThan(post.totalEarnings);
      expect(pre.monthlyCTC).toBe(50000);
    });
  });

  describe('AC3: two revisions - date between N and N+1 uses revision N newCTC', () => {
    const emp = {
      monthlyCTC: 80000,
      compensationType: 'monthly_salary',
      salaryRevisions: [
        { effectiveDate: new Date('2026-07-01'), previousCTC: 50000, newCTC: 60000 },
        { effectiveDate: new Date('2026-07-16'), previousCTC: 60000, newCTC: 80000 },
      ],
    };
    test('day 10 between rev0 and rev1 uses rev0.newCTC 60000', () => {
      expect(getEmployeeParamsForDate(emp, '2026-07-10').monthlyCTC).toBe(60000);
    });
    test('day 20 on/after rev1 returns employee 80000', () => {
      const p = getEmployeeParamsForDate(emp, '2026-07-20');
      expect(p).toBe(emp);
      expect(p.monthlyCTC).toBe(80000);
    });
    test('2026-06-30 before all revisions uses rev0.previousCTC 50000', () => {
      expect(getEmployeeParamsForDate(emp, '2026-06-30').monthlyCTC).toBe(50000);
    });
  });
});

// ---- Bug 2: weekly_salary label sanity ----

describe('weekly_salary label Bug2', () => {
  test('listCompensationTypes weekly_salary label is Weekly Rate (paid monthly)', () => {
    const wk = listCompensationTypes().find(t => t.key === 'weekly_salary');
    expect(wk).toBeDefined();
    expect(wk.label).toBe('Weekly Rate (paid monthly)');
    expect(wk.label).not.toBe('Weekly Salary');
  });
  test('weekly_salary resolves to the same strategy object as monthly_salary', () => {
    expect(resolveStrategy('weekly_salary')).toBe(resolveStrategy('monthly_salary'));
  });
});

// ---- Bug 3: custom LOP getSegmentLops ----

describe('getSegmentLops custom LOP Bug3', () => {
  const segs = [
    { startDay: 1,  endDay: 15, daysCount: 15 },
    { startDay: 16, endDay: 31, daysCount: 16 },
  ];

  test('correctly-summed [3,2] distributes without modification', () => {
    const r = getSegmentLops(5, 26, 31, 'custom', segs, [3, 2]);
    expect(r[0]).toBe(3);
    expect(r[1]).toBe(2);
  });
  test('mismatched [4,0] does not throw in utility (worker-layer validates)', () => {
    expect(() => getSegmentLops(5, 26, 31, 'custom', segs, [4, 0])).not.toThrow();
  });
  test('value exceeding segment working-day cap is clamped down', () => {
    const r = getSegmentLops(5, 26, 31, 'custom', segs, [20, 0]);
    expect(r[0]).toBeLessThanOrEqual((15/31)*26 + 0.01);
  });
});
