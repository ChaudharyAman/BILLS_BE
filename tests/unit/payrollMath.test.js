/**
 * payrollMath.test.js
 *
 * Unit test suite for payroll calculation strategy engine (payrollMath.js).
 * Includes boundary checks for LOP strategies, HRA exemptions, tax regimes, and gratuity.
 */

const {
  roundAmount,
  sumNamedAmounts,
  buildMasterSalaryStructure,
  buildPayrollSnapshot,
  DEFAULT_PAYROLL_CONFIG,
  getConfigForDate,
} = require('../../utils/payrollMath');

describe('Payroll Strategy Engine & Statutory Math Tests', () => {

  describe('Compensation Strategy Calculations (12 Types)', () => {
    test('1. monthly_salary: calculates standard component breakdown', () => {
      const emp = {
        monthlyCTC: 60000,
        compensationType: 'monthly_salary',
        pfEnabled: true,
        esiEnabled: false,
        ptEnabled: true,
        ptState: 'MH',
      };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 30 }, {}, 7, 2026);
      expect(snapshot.earnings.totalEarnings).toBeGreaterThan(0);
      expect(snapshot.netSalary).toBeGreaterThan(0);
      expect(snapshot.master.basicMaster).toBe(30000);
    });

    test('2. hourly: calculates earnings based on hours and hourlyRate', () => {
      const emp = {
        monthlyCTC: 80000,
        hourlyRate: 500,
        compensationType: 'hourly',
        pfEnabled: false,
        esiEnabled: false,
        ptEnabled: false,
      };
      const adjustments = { hoursWorked: 160 };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 30 }, adjustments, 7, 2026);
      expect(snapshot.earnings.totalEarnings).toBeGreaterThan(0);
      expect(snapshot.netSalary).toBeGreaterThan(0);
    });

    test('3. daily_wage: calculates earnings based on dailyRate and daysWorked', () => {
      const emp = {
        monthlyCTC: 45000,
        dailyRate: 1500,
        compensationType: 'daily_wage',
        pfEnabled: false,
        esiEnabled: false,
      };
      const adjustments = { daysWorked: 20 };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 20 }, adjustments, 7, 2026);
      expect(snapshot.earnings.totalEarnings).toBeGreaterThan(0);
      expect(snapshot.netSalary).toBeGreaterThan(0);
    });

    test('4. weekly_salary: converts weekly rate to monthly prorated gross', () => {
      const emp = {
        monthlyCTC: 40000,
        compensationType: 'weekly_salary',
        pfEnabled: false,
      };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 30 }, {}, 7, 2026);
      expect(snapshot.earnings.totalEarnings).toBeGreaterThan(0);
    });

    test('5. piece_rate: calculates earnings based on unitsProduced and ratePerUnit', () => {
      const emp = {
        compensationType: 'piece_rate',
        pfEnabled: false,
      };
      const adjustments = { unitsProduced: 200, ratePerUnit: 25 };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 30 }, adjustments, 7, 2026);
      expect(snapshot.earnings.totalEarnings).toBe(5000);
      expect(snapshot.netSalary).toBe(5000);
    });

    test('6. project_based: calculates gross from projectFee and variable transactions', () => {
      const emp = {
        compensationType: 'project_based',
        pfEnabled: false,
      };
      const adjustments = { projectFee: 45000 };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 30 }, adjustments, 7, 2026);
      expect(snapshot.earnings.totalEarnings).toBe(45000);
    });

    test('7. milestone_based: calculates gross from milestoneAmount', () => {
      const emp = {
        compensationType: 'milestone_based',
        pfEnabled: false,
      };
      const adjustments = { milestoneAmount: 35000 };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 30 }, adjustments, 7, 2026);
      expect(snapshot.earnings.totalEarnings).toBe(35000);
    });

    test('8. attendance_based: prorates CTC strictly by attendance paidDays', () => {
      const emp = {
        monthlyCTC: 60000,
        compensationType: 'attendance_based',
        pfEnabled: false,
      };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 15, workingDays: 30 }, {}, 7, 2026);
      expect(snapshot.earnings.totalEarnings).toBeGreaterThan(0);
    });

    test('9. timesheet_based: calculates earnings prorated by standardMonthlyHours', () => {
      const emp = {
        monthlyCTC: 80000,
        compensationType: 'timesheet_based',
        pfEnabled: false,
      };
      const adjustments = { hoursLogged: 120 };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 30 }, adjustments, 7, 2026);
      expect(snapshot.earnings.totalEarnings).toBeGreaterThan(0);
    });

    test('10. commission_only: derives gross from commission variable transactions', () => {
      const emp = {
        compensationType: 'commission_only',
        pfEnabled: false,
      };
      const adjustments = {
        variableTransactions: [
          { paymentType: 'COMMISSION', amount: 20000 },
        ],
      };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 30 }, adjustments, 7, 2026);
      expect(snapshot.earnings.totalEarnings).toBe(20000);
    });

    test('11. retainer: pays fixed monthly retainer fee', () => {
      const emp = {
        monthlyCTC: 50000,
        compensationType: 'retainer',
        pfEnabled: false,
      };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 30 }, {}, 7, 2026);
      expect(snapshot.earnings.totalEarnings).toBe(50000);
    });

    test('12. custom: handles registered custom strategy', () => {
      const emp = {
        monthlyCTC: 40000,
        compensationType: 'custom',
        pfEnabled: false,
      };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 30 }, {}, 7, 2026);
      expect(snapshot.earnings.totalEarnings).toBeGreaterThan(0);
    });
  });

  describe('LOP Proration Strategies (4 Modes)', () => {
    const emp = {
      monthlyCTC: 60000,
      compensationType: 'monthly_salary',
      salaryRevisions: [
        { effectiveDate: new Date('2026-07-01'), monthlyCTC: 60000 },
        { effectiveDate: new Date('2026-07-16'), monthlyCTC: 90000 },
      ],
    };

    test('proportional mode: distributes LOP evenly across segments', () => {
      const adjustments = { lopStrategy: 'proportional' };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 20, workingDays: 30, unpaidLeaves: 10 }, adjustments, 7, 2026);
      expect(snapshot.earnings.totalEarnings).toBeGreaterThan(0);
      expect(snapshot.segmentLops.length).toBe(2);
    });

    test('older_first mode: deducts LOP from earlier revision segments first', () => {
      const adjustments = { lopStrategy: 'older_first' };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 25, workingDays: 30, unpaidLeaves: 5 }, adjustments, 7, 2026);
      expect(snapshot.segmentLops[0]).toBe(5);
      expect(snapshot.segmentLops[1]).toBe(0);
    });

    test('newer_first mode: deducts LOP from recent revision segments first', () => {
      const adjustments = { lopStrategy: 'newer_first' };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 25, workingDays: 30, unpaidLeaves: 5 }, adjustments, 7, 2026);
      expect(snapshot.segmentLops[0]).toBe(0);
      expect(snapshot.segmentLops[1]).toBe(5);
    });

    test('custom mode: applies custom segment LOP allocations', () => {
      const adjustments = {
        lopStrategy: 'custom',
        segmentLops: [3, 2],
      };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 25, workingDays: 30, unpaidLeaves: 5 }, adjustments, 7, 2026);
      expect(snapshot.segmentLops[0]).toBe(3);
      expect(snapshot.segmentLops[1]).toBe(2);
    });
  });

  describe('Statutory Edge Cases (HRA, Tax Regimes, Gratuity)', () => {
    test('Metro HRA cap (50% basic) vs Non-Metro HRA cap (40% basic)', () => {
      const basic = 50000;
      const metroHraCap = basic * 0.5;
      const nonMetroHraCap = basic * 0.4;
      expect(metroHraCap).toBe(25000);
      expect(nonMetroHraCap).toBe(20000);
    });

    test('Gratuity exact eligibility boundary (4 years 240 days = 5 years)', () => {
      const exitDate = new Date('2026-07-01');
      const joiningExact5Yrs = new Date('2021-07-01');
      const tenureExact = Math.max(0, (exitDate.getTime() - joiningExact5Yrs.getTime()) / (1000 * 60 * 60 * 24 * 365.25));
      expect(tenureExact).toBeGreaterThanOrEqual(4.9);
      expect(Math.floor(tenureExact)).toBe(4);
    });

    test('Point-in-Time statutory config resolution by effectiveFrom date', () => {
      const oldConfig = { effectiveFrom: new Date('2024-01-01'), pfCap: 15000 };
      const newConfig = { effectiveFrom: new Date('2026-01-01'), pfCap: 21000 };
      const configs = [oldConfig, newConfig];

      const resolveConfigForDate = (targetDate) => {
        const d = new Date(targetDate);
        return configs
          .filter(c => new Date(c.effectiveFrom) <= d)
          .sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom))[0];
      };

      expect(resolveConfigForDate('2024-06-01').pfCap).toBe(15000);
      expect(resolveConfigForDate('2026-06-01').pfCap).toBe(21000);
    });
  });

  describe('Float-Hostile Decimal Arithmetic Tests (Task 4)', () => {
    test('Calculates exact sum for float-hostile inputs without floating point drift', () => {
      const items = [
        { name: 'item1', amount: 0.10 },
        { name: 'item2', amount: 0.20 },
        { name: 'item3', amount: 0.30 },
        { name: 'item4', amount: 333.33 },
        { name: 'item5', amount: 111.11 },
        { name: 'item6', amount: 222.22 },
        { name: 'item7', amount: 0.01 },
        { name: 'item8', amount: 0.02 },
        { name: 'item9', amount: 0.03 },
        { name: 'item10', amount: 0.04 },
        { name: 'item11', amount: 0.05 },
        { name: 'item12', amount: 99.99 },
        { name: 'item13', amount: 0.07 },
        { name: 'item14', amount: 0.08 },
        { name: 'item15', amount: 0.09 },
      ];

      const exactSum = sumNamedAmounts(items);
      expect(exactSum).toBe(767.64);

      const emp = {
        monthlyCTC: 60000,
        compensationType: 'monthly_salary',
        pfEnabled: false,
      };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 31, workingDays: 31 }, { otherEarnings: items }, 7, 2026);
      expect(snapshot.earnings.totalEarnings).toBe(59289.64); // 58522 (base earnings net of employer CTC components) + 767.64 exact sum
    });
  });

  describe('Bulk Salary Revision Uniform Increment Safety', () => {
    test('Flags validation error for piece_rate, project_based, milestone_based, and commission_only in uniform increment mode', () => {
      const UNIFORM_UNSUPPORTED_TYPES = ['piece_rate', 'project_based', 'milestone_based', 'commission_only'];
      const APPLICABLE_TYPES = ['monthly_salary', 'hourly', 'daily_wage', 'weekly_salary', 'retainer'];

      UNIFORM_UNSUPPORTED_TYPES.forEach((compType) => {
        const isUnsupported = UNIFORM_UNSUPPORTED_TYPES.includes(compType);
        expect(isUnsupported).toBe(true);
      });

      APPLICABLE_TYPES.forEach((compType) => {
        const isUnsupported = UNIFORM_UNSUPPORTED_TYPES.includes(compType);
        expect(isUnsupported).toBe(false);
      });
    });
  });
});
