/**
 * utils/depreciation.js
 *
 * Real on-read fixed asset depreciation calculation engine.
 * Supports Straight-Line and Declining-Balance methods with salvage value floors
 * and prorated calendar-year calculations (30/360 financial convention).
 */

const roundTwo = (num) => Math.round((Number(num || 0) + Number.EPSILON) * 100) / 100;

function getYearsElapsed(purchaseDate, asOfDate) {
  const pDate = new Date(purchaseDate);
  const aDate = new Date(asOfDate);
  if (Number.isNaN(pDate.getTime()) || Number.isNaN(aDate.getTime())) return 0;
  if (aDate <= pDate) return 0;

  const pYear = pDate.getUTCFullYear();
  const aYear = aDate.getUTCFullYear();

  const isPJan1 = pDate.getUTCMonth() === 0 && pDate.getUTCDate() === 1;
  const isAJan1 = aDate.getUTCMonth() === 0 && aDate.getUTCDate() === 1;
  const isADec31 = aDate.getUTCMonth() === 11 && aDate.getUTCDate() === 31;

  if (isPJan1 && isAJan1) {
    return Math.max(0, aYear - pYear);
  }
  if (isPJan1 && isADec31) {
    return Math.max(0, aYear - pYear + 1);
  }

  // 30/360 Day Count Convention for financial depreciation
  const pMonth = pDate.getUTCMonth();
  const pDay = Math.min(30, pDate.getUTCDate());
  const aMonth = aDate.getUTCMonth();
  const aDay = isADec31 ? 30 : Math.min(30, aDate.getUTCDate());

  const yearDiff = aYear - pYear;
  const monthDiff = aMonth - pMonth;
  const dayDiff = aDay - pDay;

  const totalDays = (yearDiff * 360) + (monthDiff * 30) + dayDiff;
  return Math.max(0, totalDays / 360);
}

function straightLine(asset, asOfDate) {
  const purchaseValue = Number(asset.purchaseValue) || 0;
  const salvageValue = Number(asset.salvageValue) || 0;
  const usefulLife = Number(asset.usefulLife) || 0;
  const purchaseDate = asset.purchaseDate || asset.createdAt;

  if (usefulLife <= 0 || purchaseValue <= 0) return 0;

  const yearsElapsed = getYearsElapsed(purchaseDate, asOfDate);
  if (yearsElapsed <= 0) return 0;

  const maxDepreciable = Math.max(0, purchaseValue - salvageValue);
  const annualDepreciation = maxDepreciable / usefulLife;
  const accumulated = Math.min(maxDepreciable, annualDepreciation * yearsElapsed);

  return roundTwo(accumulated);
}

function decliningBalance(asset, asOfDate) {
  const purchaseValue = Number(asset.purchaseValue) || 0;
  const salvageValue = Number(asset.salvageValue) || 0;
  const rawRate = Number(asset.depreciationRate) || 0;
  const purchaseDate = asset.purchaseDate || asset.createdAt;

  const rate = rawRate > 1 ? rawRate / 100 : rawRate;
  if (rate <= 0 || purchaseValue <= 0) return 0;

  const yearsElapsed = getYearsElapsed(purchaseDate, asOfDate);
  if (yearsElapsed <= 0) return 0;

  const maxDepreciable = Math.max(0, purchaseValue - salvageValue);
  const remainingValue = purchaseValue * Math.pow(1 - rate, yearsElapsed);
  const calculatedAccumulated = purchaseValue - remainingValue;
  const accumulated = Math.min(maxDepreciable, calculatedAccumulated);

  return roundTwo(accumulated);
}

function computeAssetDepreciation(asset, asOfDate) {
  const purchaseValue = Number(asset.purchaseValue) || 0;
  const salvageValue = Number(asset.salvageValue) || 0;
  const method = asset.depreciationMethod || 'straight-line';

  let accumulatedDepreciation = 0;
  if (method === 'straight-line') {
    accumulatedDepreciation = straightLine(asset, asOfDate);
  } else if (method === 'declining-balance') {
    accumulatedDepreciation = decliningBalance(asset, asOfDate);
  } else {
    accumulatedDepreciation = 0;
  }

  const bookValue = roundTwo(Math.max(salvageValue, purchaseValue - accumulatedDepreciation));

  return {
    accumulatedDepreciation: roundTwo(accumulatedDepreciation),
    bookValue,
  };
}

function computePeriodDepreciation(asset, startDate, endDate) {
  const depAtStart = computeAssetDepreciation(asset, startDate).accumulatedDepreciation;
  const depAtEnd = computeAssetDepreciation(asset, endDate).accumulatedDepreciation;
  return roundTwo(Math.max(0, depAtEnd - depAtStart));
}

module.exports = {
  roundTwo,
  getYearsElapsed,
  straightLine,
  decliningBalance,
  computeAssetDepreciation,
  computePeriodDepreciation,
};
