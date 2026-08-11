/**
 * tests/unit/taxWorksheet.test.js
 *
 * Focused unit tests for buildTaxWorksheet() — Chapter VI-A declarations,
 * old/new regime, compensationType branching.
 */

'use strict';

const { buildTaxWorksheet } = require('../../utils/payrollMath/taxWorksheet');
const { calculateTaxForRegime } = require('../../utils/payrollMath/tax');

// Helper: build a minimal monthly-salary payroll fixture with optional overrides.
function makePayroll({ earnings = {}, declarations = {}, regime = 'old', tds = 0, compType = 'monthly_salary' } = {}) {
  return {
    month: 7,
    year: 2026,
    earnings: {
      basic: 50000,
      hra: 20000,
      flexiAmount: 10000,
      ...earnings
    },
    deductions: { tds },
    employeeSnapshot: {
      taxRegime: regime,
      compensationType: compType,
      declarations
    }
  };
}

// ─── Old Regime: with declarations ───────────────────────────────────────────

describe('buildTaxWorksheet — old regime Chapter VI-A deductions', () => {
  test('taxableIncome matches calculateTaxDetails logic when declarations are present', () => {
    const declarations = {
      section80C:    150000, // should be capped at 150000
      section80D:    30000,  // capped at 25000
      section80CCD1B: 50000,
      section24b:    200000,
      rentPaidMonthly: 10000,
      isMetroCity: false
    };
    const payroll = makePayroll({ regime: 'old', declarations });

    const ws = buildTaxWorksheet({ payroll });

    // Caps same as tax.js
    const cappedSec80C     = 150000;
    const cappedSec80D     = 25000;
    const cappedSec80CCD1B = 50000;
    const cappedSec24b     = 200000;
    const chapterVIA       = cappedSec80C + cappedSec80D + cappedSec80CCD1B + cappedSec24b;

    // Reproduced manual calculation
    const basic    = 50000, hra = 20000, flexi = 10000;
    const gross    = (basic + hra + flexi) * 12; // 960000
    const stdDed   = 50000;
    const rentPaid = 10000 * 12;         // 120000
    const basic10  = basic * 12 * 0.1;  // 60000
    const hraAnnual = hra * 12;          // 240000
    const cap40    = basic * 12 * 0.40;  // 240000
    const exemptHra = Math.round(Math.max(0, Math.min(hraAnnual, rentPaid - basic10, cap40)));

    const expectedTaxable = Math.max(0, gross - exemptHra - stdDed - chapterVIA);

    expect(ws.taxableIncome).toBe(expectedTaxable);
    expect(ws.chapterVIADeductions.section80C).toBe(cappedSec80C);
    expect(ws.chapterVIADeductions.section80D).toBe(cappedSec80D);
    expect(ws.chapterVIADeductions.section80CCD1B).toBe(cappedSec80CCD1B);
    expect(ws.chapterVIADeductions.section24b).toBe(cappedSec24b);
    expect(ws.chapterVIADeductions.total).toBe(chapterVIA);

    const expectedTotalTax = calculateTaxForRegime('old', expectedTaxable);
    const expectedCess     = Math.round(expectedTotalTax * 0.04 * 100) / 100;
    const expectedNetTax   = Math.round((expectedTotalTax + expectedCess) * 100) / 100;
    expect(ws.totalTax).toBe(expectedTotalTax);
    expect(ws.netTax).toBe(expectedNetTax);
  });

  test('80C capped at 150000 even when declaration exceeds cap', () => {
    const ws = buildTaxWorksheet({
      payroll: makePayroll({ regime: 'old', declarations: { section80C: 200000 } })
    });
    expect(ws.chapterVIADeductions.section80C).toBe(150000);
  });

  test('80D capped at 25000', () => {
    const ws = buildTaxWorksheet({
      payroll: makePayroll({ regime: 'old', declarations: { section80D: 50000 } })
    });
    expect(ws.chapterVIADeductions.section80D).toBe(25000);
  });

  test('80CCD1B capped at 50000', () => {
    const ws = buildTaxWorksheet({
      payroll: makePayroll({ regime: 'old', declarations: { section80CCD1B: 80000 } })
    });
    expect(ws.chapterVIADeductions.section80CCD1B).toBe(50000);
  });

  test('24b capped at 200000', () => {
    const ws = buildTaxWorksheet({
      payroll: makePayroll({ regime: 'old', declarations: { section24b: 300000 } })
    });
    expect(ws.chapterVIADeductions.section24b).toBe(200000);
  });

  test('taxableIncome decreases vs no declarations when declarations are present', () => {
    const payrollNoDecl = makePayroll({ regime: 'old' });
    const payrollWithDecl = makePayroll({
      regime: 'old',
      declarations: { section80C: 100000, section80D: 20000 }
    });
    const wsNone = buildTaxWorksheet({ payroll: payrollNoDecl });
    const wsWith = buildTaxWorksheet({ payroll: payrollWithDecl });
    expect(wsWith.taxableIncome).toBeLessThan(wsNone.taxableIncome);
    expect(wsWith.totalTax).toBeLessThanOrEqual(wsNone.totalTax);
    expect(wsWith.netTax).toBeLessThanOrEqual(wsNone.netTax);
  });
});

// ─── Old Regime: no declarations (regression guard) ──────────────────────────

describe('buildTaxWorksheet — old regime no declarations', () => {
  test('chapterVIADeductions.total is 0 when no declarations set', () => {
    const ws = buildTaxWorksheet({ payroll: makePayroll({ regime: 'old' }) });
    expect(ws.chapterVIADeductions.total).toBe(0);
    expect(ws.chapterVIADeductions.section80C).toBe(0);
  });

  test('taxableIncome equals grossSalary - exemptHra - standardDeduction when no Chapter VI-A', () => {
    const payroll = makePayroll({ regime: 'old' });
    const ws = buildTaxWorksheet({ payroll });
    const expected = Math.max(0, ws.grossSalary - ws.hra.exemptHRA - ws.standardDeduction);
    expect(ws.taxableIncome).toBe(expected);
  });
});

// ─── New Regime: byte-identical to before (no regression) ────────────────────

describe('buildTaxWorksheet — new regime unchanged', () => {
  test('chapterVIADeductions.total is always 0 for new regime regardless of declarations', () => {
    const ws = buildTaxWorksheet({
      payroll: makePayroll({
        regime: 'new',
        declarations: { section80C: 150000, section80D: 25000, section24b: 200000 }
      })
    });
    expect(ws.chapterVIADeductions.total).toBe(0);
    expect(ws.chapterVIADeductions.section80C).toBe(0);
  });

  test('new regime taxableIncome ignores Chapter VI-A, only standard deduction applied', () => {
    const payroll = makePayroll({
      regime: 'new',
      declarations: { section80C: 150000 }
    });
    const ws = buildTaxWorksheet({ payroll });
    // New regime standard deduction = 75000, exemptHra = 0 (new regime)
    const expected = Math.max(0, ws.grossSalary - 0 - 75000);
    expect(ws.taxableIncome).toBe(expected);
    expect(ws.standardDeduction).toBe(75000);
  });

  test('new regime ₹22L taxable still applies 25% slab (no regression)', () => {
    // Use a gross that yields a taxable income firmly in the 25% slab (20L-24L).
    // Monthly basic = 200000 → annual gross = 2400000 → taxable = 2400000 - 75000 = 2325000
    // Tax on 2325000: slab up to 24L pays 300000; 2325000 > 2400000 is false, so:
    // (2325000 - 2000000) * 0.25 + 200000 = 81250 + 200000 = 281250
    const payroll = {
      month: 7, year: 2026,
      earnings: { basic: 200000 },
      deductions: { tds: 0 },
      employeeSnapshot: { taxRegime: 'new', compensationType: 'monthly_salary' }
    };
    const ws = buildTaxWorksheet({ payroll });
    // Assert using calculateTaxForRegime so the test does not restate the
    // slab arithmetic manually, keeping it resilient to future rounding fixes.
    const expected = calculateTaxForRegime('new', ws.taxableIncome);
    expect(ws.totalTax).toBe(expected);
    // Confirm taxable income is in the 25% band (20L–24L)
    expect(ws.taxableIncome).toBeGreaterThan(2000000);
    expect(ws.taxableIncome).toBeLessThanOrEqual(2400000);
  });

  test('new regime ₹9.5L taxable shows totalTax = 0 (marginal relief, no regression)', () => {
    // Monthly basic = 90000 → annual gross = 1080000 → taxable = 1080000 - 75000 = 1005000
    // 1005000 < 1200000 → marginal relief zeros the tax.
    const payroll = {
      month: 7, year: 2026,
      earnings: { basic: 90000 },
      deductions: { tds: 0 },
      employeeSnapshot: { taxRegime: 'new', compensationType: 'monthly_salary' }
    };
    const ws = buildTaxWorksheet({ payroll });
    expect(ws.taxableIncome).toBeLessThanOrEqual(1200000);
    expect(ws.totalTax).toBe(0);
  });
});
