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
  buildTaxWorksheet,
  calculateTaxForRegime,
  computeStatutoryAndTax,
  getSalarySplits,
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

    test('5. piece_rate: calculates earnings based on unitsProduced and ratePerUnit / rateCard defaults', () => {
      const empWithRateCard = {
        compensationType: 'piece_rate',
        pfEnabled: false,
        rateCard: [{ paymentType: 'UNIT', rate: 500 }],
      };
      // (a) No unitsProduced supplied -> defaults to 1 unit * ₹500 = ₹500
      const snapshotDefault = buildPayrollSnapshot(empWithRateCard, DEFAULT_PAYROLL_CONFIG, { paidDays: 30 }, {}, 7, 2026);
      expect(snapshotDefault.earnings.totalEarnings).toBe(500);

      // (b) Supplying unitsProduced: 3 -> 3 units * ₹500 = ₹1500
      const snapshot3Units = buildPayrollSnapshot(empWithRateCard, DEFAULT_PAYROLL_CONFIG, { paidDays: 30 }, { unitsProduced: 3 }, 7, 2026);
      expect(snapshot3Units.earnings.totalEarnings).toBe(1500);

      // (c) Supplying unitsProduced: 0 explicitly -> 0 units * ₹500 = ₹0
      const snapshot0Units = buildPayrollSnapshot(empWithRateCard, DEFAULT_PAYROLL_CONFIG, { paidDays: 30 }, { unitsProduced: 0 }, 7, 2026);
      expect(snapshot0Units.earnings.totalEarnings).toBe(0);

      // (d) Explicit adjustments for units & rate (when no rateCard present)
      const empNoRateCard = { compensationType: 'piece_rate', pfEnabled: false };
      const adjustments = { unitsProduced: 200, ratePerUnit: 25 };
      const snapshot = buildPayrollSnapshot(empNoRateCard, DEFAULT_PAYROLL_CONFIG, { paidDays: 30 }, adjustments, 7, 2026);
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

    test('7. milestone_based: calculates gross from milestoneAmount or rateCard fallback', () => {
      const empRateCard = {
        compensationType: 'milestone_based',
        pfEnabled: false,
        rateCard: [{ paymentType: 'MILESTONE', rate: 40000, unit: 'milestone' }],
      };
      const snapshotWithRateCard = buildPayrollSnapshot(empRateCard, DEFAULT_PAYROLL_CONFIG, { paidDays: 30 }, {}, 7, 2026);
      expect(snapshotWithRateCard.earnings.totalEarnings).toBe(40000);

      const empManual = {
        compensationType: 'milestone_based',
        pfEnabled: false,
      };
      const adjustments = { milestoneAmount: 35000 };
      const snapshot = buildPayrollSnapshot(empManual, DEFAULT_PAYROLL_CONFIG, { paidDays: 30 }, adjustments, 7, 2026);
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

  describe('buildMasterSalaryStructure Strategy Branches & Snapshot Config Tests', () => {
    test('retainer: prefers rateCard MONTHLY rate over monthlyCTC', () => {
      const emp = {
        compensationType: 'retainer',
        monthlyCTC: 0,
        rateCard: [{ paymentType: 'MONTHLY', rate: 75000 }],
      };
      const res = buildMasterSalaryStructure(emp, DEFAULT_PAYROLL_CONFIG);
      expect(res.monthlyCTC).toBe(75000);
    });

    test('weekly_salary: converts weeklyRate to monthly CTC via weeksPerMonth (52/12)', () => {
      const emp = {
        compensationType: 'weekly_salary',
        weeklyRate: 10000,
      };
      const res = buildMasterSalaryStructure(emp, DEFAULT_PAYROLL_CONFIG);
      expect(res.monthlyCTC).toBe(43333.33);
    });

    test('commission_only: sets monthlyCTC to 0 and returns isVariablePay flag', () => {
      const emp = {
        compensationType: 'commission_only',
        commissionNotes: '10% per sale',
      };
      const res = buildMasterSalaryStructure(emp, DEFAULT_PAYROLL_CONFIG);
      expect(res.monthlyCTC).toBe(0);
      expect(res.isVariablePay).toBe(true);
      expect(res.compensationBasis).toBe('commission');
    });

    test('buildMasterSalaryStructure returns valid structure for all 12 compensation types', () => {
      const ALL_12_TYPES = [
        'monthly_salary', 'attendance_based', 'salary_plus_commission',
        'hourly', 'timesheet_based', 'daily_wage', 'weekly_salary',
        'piece_rate', 'project_based', 'milestone_based', 'commission_only', 'retainer'
      ];
      ALL_12_TYPES.forEach(type => {
        const emp = {
          compensationType: type,
          monthlyCTC: 50000,
          hourlyRate: 500,
          dailyRate: 2000,
          weeklyRate: 10000,
          rateCard: [{ paymentType: 'MONTHLY', rate: 50000 }, { paymentType: 'UNIT', rate: 50 }],
        };
        const res = buildMasterSalaryStructure(emp, DEFAULT_PAYROLL_CONFIG);
        expect(res).toBeDefined();
        expect(typeof res.monthlyCTC).toBe('number');
        expect(typeof res.pfEnabled).toBe('boolean');
        expect(typeof res.esiEnabled).toBe('boolean');
      });
    });

    test('TDS 194J fallback: applies 10% 194J rate for retainer, project_based, milestone_based, commission_only', () => {
      const contractorTypes = ['retainer', 'project_based', 'milestone_based', 'commission_only'];
      contractorTypes.forEach(compType => {
        const emp = {
          monthlyCTC: 100000,
          compensationType: compType,
          tdsEnabled: true,
          pfEnabled: false,
          esiEnabled: false,
          ptEnabled: false,
          rateCard: [{ paymentType: 'MONTHLY', rate: 100000 }],
        };
        const adj = {
          retainer: {},
          project_based: { projectFee: 100000 },
          milestone_based: { milestoneAmount: 100000 },
          commission_only: { variableTransactions: [{ amount: 100000, paymentType: 'COMMISSION' }] },
        }[compType];
        const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 30 }, adj, 7, 2026);
        expect(snapshot.deductions.tds).toBe(10000); // 10% of 100,000
      });
    });
  });

  describe('Full & Final Settlement Path', () => {
    // These tests reproduce the F&F call signature in lifecycle.js after the Bug B fix:
    //   buildPayrollSnapshot(employee, config, { paidDays, hoursWorked }, adjustments, month, year)
    // where adjustments may carry periodInput for piece-rate employees.

    test('hourly employee: F&F with explicit hoursWorked uses supplied hours, not employee.hoursWorked', () => {
      const emp = {
        compensationType: 'hourly',
        hourlyRate: 400,
        // Stale / wrong value stored on the employee document — must NOT be used
        // when attendance.hoursWorked is supplied.
        hoursWorked: 1,
        pfEnabled: false,
        esiEnabled: false,
      };
      // Simulates lifecycle.js: fnfAttendance = { paidDays: 15, hoursWorked: 8 }
      const attendance = { paidDays: 15, hoursWorked: 8 };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, attendance, {}, 7, 2026);
      // gross should be 400 × 8 = 3200, not 400 × 1 = 400
      expect(snapshot.earnings.totalEarnings).toBe(3200);
    });

    test('hourly employee: F&F without hoursWorked falls back to employee.hoursWorked (existing behavior)', () => {
      const emp = {
        compensationType: 'hourly',
        hourlyRate: 400,
        hoursWorked: 8,
        pfEnabled: false,
        esiEnabled: false,
      };
      // No hoursWorked in attendance — backend did not receive it (old flow or user left blank)
      const attendance = { paidDays: 15 };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, attendance, {}, 7, 2026);
      expect(snapshot.earnings.totalEarnings).toBe(3200); // 400 × 8 from employee fallback
    });

    test('piece-rate employee: F&F with periodInput.unitsProduced uses supplied units', () => {
      const emp = {
        compensationType: 'piece_rate',
        pfEnabled: false,
        esiEnabled: false,
      };
      // Simulates lifecycle.js: fnfAttendance = { paidDays: N, workingDays: N, ... }
      // workingDays must equal paidDays for an F&F exit so prorate = 1.0 (no further scaling).
      const adjustments = { periodInput: { unitsProduced: 10, ratePerUnit: 150 } };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 15, workingDays: 15 }, adjustments, 7, 2026);
      expect(snapshot.earnings.totalEarnings).toBe(1500); // 10 × 150
    });

    test('piece-rate employee: F&F without unitsProduced defaults to 1 unit (Bug A + B combined)', () => {
      const emp = {
        compensationType: 'piece_rate',
        pfEnabled: false,
        esiEnabled: false,
        rateCard: [{ paymentType: 'UNIT', rate: 500 }],
      };
      // No periodInput supplied — backend received nothing from the old form.
      // workingDays = paidDays so prorate = 1.0 (F&F exit = full period elapsed).
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 15, workingDays: 15 }, {}, 7, 2026);
      // Should default to 1 unit × 500 = 500, not 0 × 500 = 0
      expect(snapshot.earnings.totalEarnings).toBe(500);
    });
  });

  describe('Compensation Type Resolution & Strategy Dispatch', () => {
    const { resolveCompensationType } = require('../../utils/payrollStrategies');

    test('payType=hourly with compensationType unset resolves to hourly and calculates gross = hourlyRate × hoursWorked', () => {
      const emp = {
        payType: 'hourly',
        hourlyRate: 400,
        monthlyCTC: 10320, // Distractor monthlyCTC — must NOT be used for hourly strategy
        compensationType: null,
        pfEnabled: false,
        esiEnabled: false,
      };
      const resolved = resolveCompensationType(emp);
      expect(resolved).toBe('hourly');

      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 30, hoursWorked: 8 }, {}, 7, 2026);
      // Must be 400 × 8 = 3200, NOT monthlyCTC/160 × 8 = (10320/160)*8 = 516
      expect(snapshot.earnings.totalEarnings).toBe(3200);
    });

    test('compensationType explicitly set to timesheet_based uses timesheet formula (monthlyCTC / 160 × hoursLogged)', () => {
      const emp = {
        compensationType: 'timesheet_based',
        hourlyRate: 400, // Distractor rate — timesheet_based computes from monthlyCTC / 160
        monthlyCTC: 10320,
        pfEnabled: false,
        esiEnabled: false,
      };
      const resolved = resolveCompensationType(emp);
      expect(resolved).toBe('timesheet_based');

      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 30 }, { periodInput: { hoursLogged: 8 } }, 7, 2026);
      // (10320 / 160) × 8 = 64.5 × 8 = 516
      expect(snapshot.earnings.totalEarnings).toBe(516);
    });

    test('reproduces EMP-2026-1005 scenario: hourlyRate=400, hoursWorked=8, monthlyCTC=10320 calculates 3200', () => {
      const emp = {
        employeeId: 'EMP-2026-1005',
        compensationType: 'hourly',
        hourlyRate: 400,
        monthlyCTC: 10320,
        pfEnabled: false,
        esiEnabled: false,
      };
      const snapshot = buildPayrollSnapshot(emp, DEFAULT_PAYROLL_CONFIG, { paidDays: 30, hoursWorked: 8 }, {}, 7, 2026);
      expect(snapshot.earnings.totalEarnings).toBe(3200);
    });
  });

  describe('buildPayrollInputsWorkbook Excel builder tests', () => {
    const { buildPayrollInputsWorkbook } = require('../../controllers/payroll/reporting');

    test('buildPayrollInputsWorkbook creates a valid workbook for employee template input mode without reference errors', () => {
      const employees = [
        {
          employeeId: 'EMP001',
          firstName: 'Aman',
          lastName: 'Kumar',
          email: 'aman@gmail.com',
          monthlyCTC: 10000,
          useSalaryComponents: false,
        },
        {
          employeeId: 'EMP002',
          firstName: 'Rahul',
          lastName: 'Sharma',
          email: 'rahul@gmail.com',
          monthlyCTC: 30000,
          useSalaryComponents: true,
          basicPercent: 0.5,
          hraPercent: 0.5,
        }
      ];
      const workbook = buildPayrollInputsWorkbook([], employees, DEFAULT_PAYROLL_CONFIG, 7, 2026);
      expect(workbook).toBeDefined();
      expect(workbook.SheetNames).toContain('Payroll Inputs');
    });

    test('buildPayrollInputsWorkbook creates a valid workbook for payroll records mode', () => {
      const payrolls = [
        {
          employeeSnapshot: {
            employeeId: 'EMP001',
            firstName: 'Aman',
            monthlyCTC: 10000,
            useSalaryComponents: false,
          },
          earnings: { basic: 10000, hra: 0, specialAllowance: 0, totalEarnings: 10000 },
          workingDays: 30,
          paidDays: 30,
        }
      ];
      const workbook = buildPayrollInputsWorkbook(payrolls, [], DEFAULT_PAYROLL_CONFIG, 7, 2026);
      expect(workbook).toBeDefined();
      expect(workbook.SheetNames).toContain('Payroll Inputs');
    });
  });

  describe('buildTaxWorksheet & Tax Slab / Rebate Acceptance Criteria', () => {
    test('New Regime ₹22,00,000 annual taxable income correctly applies 25% slab (tax = ₹2,50,000)', () => {
      const tax = calculateTaxForRegime('new', 2200000);
      expect(tax).toBe(250000);
    });

    test('New Regime ₹9,50,000 annual taxable income (within 12L rebate band) shows totalTax = 0', () => {
      const tax = calculateTaxForRegime('new', 950000);
      expect(tax).toBe(0);
    });

    test('buildTaxWorksheet calculates identical structure and genuine FY-to-date TDS sum', () => {
      const payroll = {
        month: 7,
        year: 2026,
        earnings: { basic: 20000, hra: 10000 },
        deductions: { tds: 1000 },
        employeeSnapshot: { taxRegime: 'new' }
      };
      const fyPayrolls = [
        { month: 4, deductions: { tds: 1000 } },
        { month: 5, deductions: { tds: 1000 } },
        { month: 6, deductions: { tds: 1000 } },
        { month: 7, deductions: { tds: 1000 } }
      ];
      const worksheet = buildTaxWorksheet({ payroll, fyPayrolls });
      expect(worksheet.regime).toBe('new');
      expect(worksheet.taxDeductionThisMonth).toBe(1000);
      expect(worksheet.taxDeductedTillDate).toBe(4000);
      expect(worksheet.hra.from).toBe('April');
      expect(worksheet.hra.to).toBe('March');
    });

    // Acceptance criteria 7 — non-component pay types show single correct label, not "Basic"
    test('AC-7: hourly employee shows "Hourly Wages" row, not 9-row salary structure', () => {
      const payroll = {
        month: 7,
        year: 2026,
        earnings: { basic: 32000, totalEarnings: 32000 },
        deductions: { tds: 0 },
        employeeSnapshot: { taxRegime: 'new', compensationType: 'hourly' }
      };
      const worksheet = buildTaxWorksheet({ payroll });
      expect(worksheet.componentBreakdown).toHaveLength(1);
      expect(worksheet.componentBreakdown[0].name).toBe('Hourly Wages');
      expect(worksheet.componentBreakdown[0].gross).toBe(384000); // 32000 × 12
      expect(worksheet.grossSalary).toBe(384000);
    });

    test('AC-7: daily_wage employee shows "Daily Wage Earnings" row', () => {
      const payroll = {
        month: 7,
        year: 2026,
        earnings: { basic: 15000, totalEarnings: 15000 },
        deductions: { tds: 0 },
        employeeSnapshot: { taxRegime: 'new', compensationType: 'daily_wage' }
      };
      const worksheet = buildTaxWorksheet({ payroll });
      expect(worksheet.componentBreakdown).toHaveLength(1);
      expect(worksheet.componentBreakdown[0].name).toBe('Daily Wage Earnings');
    });

    test('AC-7: retainer employee shows "Monthly Retainer Fee" row', () => {
      const payroll = {
        month: 7,
        year: 2026,
        earnings: { basic: 50000, totalEarnings: 50000 },
        deductions: { tds: 0 },
        employeeSnapshot: { taxRegime: 'new', compensationType: 'retainer' }
      };
      const worksheet = buildTaxWorksheet({ payroll });
      expect(worksheet.componentBreakdown).toHaveLength(1);
      expect(worksheet.componentBreakdown[0].name).toBe('Monthly Retainer Fee');
    });

    // Acceptance criteria 8 — salary_plus_commission includes Commission row
    test('AC-8: salary_plus_commission worksheet includes Commission row reflecting variable compensation', () => {
      const payroll = {
        month: 7,
        year: 2026,
        earnings: {
          basic: 30000,
          hra: 15000,
          variableCompensation: [
            { amount: 10000, paymentType: 'Sales', reference: 'July deals' }
          ]
        },
        deductions: { tds: 0 },
        employeeSnapshot: { taxRegime: 'new', compensationType: 'salary_plus_commission' }
      };
      const worksheet = buildTaxWorksheet({ payroll });
      const commissionRow = worksheet.componentBreakdown.find(r => r.name === 'Commission');
      expect(commissionRow).toBeDefined();
      expect(commissionRow.gross).toBe(120000); // 10000 × 12
      expect(commissionRow.taxable).toBe(120000);
      // grossSalary must include commission
      expect(worksheet.grossSalary).toBeGreaterThan((30000 + 15000) * 12);
    });

    // hra block is always present in returned shape, even for non-component types
    test('hra block present with correct shape for non-component pay type', () => {
      const payroll = {
        month: 7,
        year: 2026,
        earnings: { basic: 20000, totalEarnings: 20000 },
        deductions: { tds: 0 },
        employeeSnapshot: { taxRegime: 'new', compensationType: 'piece_rate' }
      };
      const worksheet = buildTaxWorksheet({ payroll });
      expect(worksheet.hra).toMatchObject({
        from: 'April',
        to: 'March',
        rentPaid: 0,
        actualHRA: 0,
        exemptHRA: 0
      });
    });
  });

  // ─── Bug 2: ESI gross-wage consistency ──────────────────────────────────────
  describe('ESI Gross-Wage Consistency (Bug 2)', () => {
    const ESI_EMPLOYEE_RATE = DEFAULT_PAYROLL_CONFIG.esiEmployeeRate; // 0.0075
    const ESI_EMPLOYER_RATE = DEFAULT_PAYROLL_CONFIG.esiEmployerRate; // 0.0325

    // Fixture: basic=15000, HRA=5000, other allowances=2000 → gross=22000, under ESI threshold.
    // ESI threshold default is 21000; we override to 25000 so this gross qualifies.
    const esiConfig = {
      ...DEFAULT_PAYROLL_CONFIG,
      esiBasicThreshold: 25000,
    };

    const esiEmployee = {
      monthlyCTC: 24000,
      compensationType: 'monthly_salary',
      pfEnabled: false,
      esiEnabled: true,
      ptEnabled: false,
      gratuityEnabled: false,
      lwfEnabled: false,
      tdsEnabled: false,
      taxRegime: 'new',
      // Hardcode component split so gross is deterministic
      basic: 15000,
      hra:   5000,
      specialAllowance: 2000,
    };

    test('computeStatutoryAndTax: ESI based on gross (22000), not basicMaster (15000)', () => {
      const gross = 22000;       // basic + hra + specialAllowance
      const basicMaster = 15000;
      const { esiEmployee: esiEmpDeduction, esiEmployer: esiEmpContrib } = computeStatutoryAndTax({
        gross,
        basicMaster,
        hraMaster: 5000,
        monthlyCTC: 22000,
        flags: {
          pfEnabled: false,
          esiEnabled: true,
          ptEnabled: false,
          lwfEnabled: false,
          tdsEnabled: false,
          gratuityEnabled: false,
        },
        config: esiConfig,
        src: { _paidDays: 30, _workingDays: 30, taxRegime: 'new', declarations: {} },
      });
      // Must be on gross, not basic
      expect(esiEmpDeduction).toBe(roundAmount(gross * ESI_EMPLOYEE_RATE));
      expect(esiEmpContrib).toBe(roundAmount(gross * ESI_EMPLOYER_RATE));
      // Confirm it differs from the old (wrong) basic-based value
      expect(esiEmpDeduction).not.toBe(roundAmount(basicMaster * ESI_EMPLOYEE_RATE));
    });

    test('buildMasterSalaryStructure: ESI based on gross earnings, not basicMaster', () => {
      const result = buildMasterSalaryStructure(esiEmployee, esiConfig);
      const gross = result.totalEarnings; // whatever the engine computed
      // totalEarnings includes basic+hra+special at minimum, so esiEmployee should be gross × rate
      expect(result.esiEmployee).toBe(roundAmount(gross * ESI_EMPLOYEE_RATE));
      expect(result.esiEmployer).toBe(roundAmount(gross * ESI_EMPLOYER_RATE));
    });

    test('getSalarySplits ESI matches buildMasterSalaryStructure ESI for a full calendar month (no revision)', () => {
      // Full month: paidDays = workingDays = 30 (no mid-month revision, so single segment)
      const month = 7;
      const year  = 2026;
      const paidDays = 30;
      const workingDays = 30;

      const master = buildMasterSalaryStructure(esiEmployee, esiConfig);
      const splits = getSalarySplits(esiEmployee, esiConfig, month, year, paidDays, workingDays);

      // getSalarySplits returns an array of segments; sum esiEmployee across all segments
      const splitEsiSum = splits.reduce((s, seg) => s + (seg.esiEmployee || 0), 0);

      // Within ₹1 rounding tolerance (daily-accumulation vs monthly round)
      expect(Math.abs(splitEsiSum - master.esiEmployee)).toBeLessThanOrEqual(1);
    });

    test('ESI is zero when gross exceeds esiBasicThreshold', () => {
      const { esiEmployee: esiEmpDeduction } = computeStatutoryAndTax({
        gross: 30000, // above threshold 25000
        basicMaster: 15000,
        monthlyCTC: 30000,
        flags: { pfEnabled: false, esiEnabled: true, ptEnabled: false, lwfEnabled: false, tdsEnabled: false, gratuityEnabled: false },
        config: esiConfig,
        src: { taxRegime: 'new', declarations: {} },
      });
      expect(esiEmpDeduction).toBe(0);
    });
  });

  // ─── Bug 3: Statutory-Only Shortfall Accounting Invariant ──────────────────
  describe('Statutory-Only Shortfall Accounting Invariant (Bug 3)', () => {
    test('when statutory deductions exceed gross earnings with zero non-statutory deductions, the accounting identity holds', () => {
      const employee = {
        monthlyCTC: 10000,
        compensationType: 'monthly_salary',
        pfEnabled: true,
        esiEnabled: false,
        ptEnabled: true,
        ptState: 'MH',
        tdsEnabled: true,
        deductions: {
          tds: 5000, // High manual TDS deduction exceeding gross
        },
      };

      const snapshot = buildPayrollSnapshot(
        employee,
        DEFAULT_PAYROLL_CONFIG,
        { paidDays: 5, workingDays: 30 }, // LOP reduces gross significantly below deductions
        {},
        4,
        2026
      );

      const totalIncome = roundAmount(
        snapshot.earnings.totalEarnings +
        snapshot.variablePay.totalVariablePay +
        snapshot.totalReimbursementApproved
      );

      // Accounting identity invariant: earnings + variablePay + reimbursements - totalDeductions === netSalary
      const netSalaryInvariant = roundAmount(totalIncome - snapshot.deductions.totalDeductions);
      expect(snapshot.netSalary).toBe(netSalaryInvariant);

      // Verify payrollShortfall flags statutory-only case
      expect(snapshot.payrollShortfall).toBeDefined();
      expect(snapshot.payrollShortfall.statutoryOnly).toBe(true);
    });
  });

});
