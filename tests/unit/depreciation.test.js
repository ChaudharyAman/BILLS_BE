/**
 * tests/unit/depreciation.test.js
 *
 * Unit tests for fixed asset depreciation engine (straight-line, declining-balance,
 * partial year prorations, and salvage value caps).
 */

const {
  straightLine,
  decliningBalance,
  computeAssetDepreciation,
  computePeriodDepreciation,
  getYearsElapsed,
} = require('../../utils/depreciation');

describe('Fixed Asset Depreciation Engine Tests', () => {
  test('Straight-Line: exactly depreciates annual allocation up to useful life', () => {
    const asset = {
      purchaseValue: 100000,
      salvageValue: 10000,
      usefulLife: 5,
      purchaseDate: new Date('2024-01-01T00:00:00.000Z'),
      depreciationMethod: 'straight-line',
    };

    // 1 year elapsed: (100000 - 10000) / 5 = 18000
    const asOf1Yr = new Date('2025-01-01T00:00:00.000Z');
    const res1 = computeAssetDepreciation(asset, asOf1Yr);
    expect(Math.round(res1.accumulatedDepreciation)).toBe(18000);
    expect(Math.round(res1.bookValue)).toBe(82000);

    // 5 years elapsed: fully depreciated to salvage value 10000
    const asOf5Yr = new Date('2029-01-01T00:00:00.000Z');
    const res5 = computeAssetDepreciation(asset, asOf5Yr);
    expect(Math.round(res5.accumulatedDepreciation)).toBe(90000);
    expect(Math.round(res5.bookValue)).toBe(10000);

    // 10 years elapsed: should NOT depreciate below salvage value
    const asOf10Yr = new Date('2034-01-01T00:00:00.000Z');
    const res10 = computeAssetDepreciation(asset, asOf10Yr);
    expect(res10.accumulatedDepreciation).toBe(90000);
    expect(res10.bookValue).toBe(10000);
  });

  test('Declining-Balance: applies annual rate and respects salvage floor', () => {
    const asset = {
      purchaseValue: 50000,
      salvageValue: 5000,
      depreciationRate: 20, // 20%
      purchaseDate: new Date('2024-01-01T00:00:00.000Z'),
      depreciationMethod: 'declining-balance',
    };

    // 1 year: 50000 * 0.20 = 10000 dep, book value = 40000
    const asOf1Yr = new Date('2025-01-01T00:00:00.000Z');
    const res1 = computeAssetDepreciation(asset, asOf1Yr);
    expect(Math.round(res1.accumulatedDepreciation)).toBe(10000);
    expect(Math.round(res1.bookValue)).toBe(40000);

    // 2 years: BV = 50000 * (0.8)^2 = 32000, acc dep = 18000
    const asOf2Yr = new Date('2026-01-01T00:00:00.000Z');
    const res2 = computeAssetDepreciation(asset, asOf2Yr);
    expect(Math.round(res2.accumulatedDepreciation)).toBe(18000);
    expect(Math.round(res2.bookValue)).toBe(32000);
  });

  test('Prorated period depreciation between two dates', () => {
    const asset = {
      purchaseValue: 120000,
      salvageValue: 0,
      usefulLife: 10, // 12000 / year = 1000 / month
      purchaseDate: new Date('2024-01-01T00:00:00.000Z'),
      depreciationMethod: 'straight-line',
    };

    // Period: 2025-01-01 to 2025-12-31 (1 year)
    const start = new Date('2025-01-01T00:00:00.000Z');
    const end = new Date('2025-12-31T23:59:59.999Z');
    const periodDep = computePeriodDepreciation(asset, start, end);
    expect(Math.round(periodDep)).toBe(12000);
  });

  test('Asset purchased in the future or depreciationMethod: none returns 0', () => {
    const assetFuture = {
      purchaseValue: 50000,
      salvageValue: 0,
      usefulLife: 5,
      purchaseDate: new Date('2027-01-01T00:00:00.000Z'),
      depreciationMethod: 'straight-line',
    };

    const res = computeAssetDepreciation(assetFuture, new Date('2026-01-01T00:00:00.000Z'));
    expect(res.accumulatedDepreciation).toBe(0);
    expect(res.bookValue).toBe(50000);

    const assetNone = {
      purchaseValue: 50000,
      salvageValue: 0,
      purchaseDate: new Date('2024-01-01T00:00:00.000Z'),
      depreciationMethod: 'none',
    };
    const resNone = computeAssetDepreciation(assetNone, new Date('2026-01-01T00:00:00.000Z'));
    expect(resNone.accumulatedDepreciation).toBe(0);
    expect(resNone.bookValue).toBe(50000);
  });
});
