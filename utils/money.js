/**
 * utils/money.js
 *
 * Fixed-point decimal arithmetic utility using decimal.js to eliminate
 * intermediate floating point precision drift in financial payroll math.
 */

const Decimal = require('decimal.js');

// Configure standard precision and ROUND_HALF_UP for Indian currency / paise calculations
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

/**
 * Converts input value (number, string, Decimal) safely to Decimal instance.
 */
function toDecimal(val) {
  if (val instanceof Decimal) return val;
  if (val === null || val === undefined || val === '') return new Decimal(0);
  const numVal = Number(val);
  if (isNaN(numVal)) return new Decimal(0);
  return new Decimal(val);
}

/**
 * Adds multiple numeric or Decimal values into a single Decimal result.
 */
function add(...values) {
  return values.reduce((sum, v) => sum.plus(toDecimal(v)), new Decimal(0));
}

/**
 * Subtracts b from a: (a - b) as a Decimal.
 */
function subtract(a, b) {
  return toDecimal(a).minus(toDecimal(b));
}

/**
 * Multiplies a by b: (a * b) as a Decimal.
 */
function multiply(a, b) {
  return toDecimal(a).times(toDecimal(b));
}

/**
 * Divides a by b: (a / b) as a Decimal. Returns Decimal(0) if b is 0.
 */
function divide(a, b) {
  const decB = toDecimal(b);
  if (decB.isZero()) return new Decimal(0);
  return toDecimal(a).div(decB);
}

/**
 * Rounds a Decimal/Number/String to 2 decimal places (paise) and returns a plain Number for DB storage.
 */
function roundToPaise(val) {
  const dec = toDecimal(val);
  return Number(dec.toFixed(2, Decimal.ROUND_HALF_UP));
}

/**
 * Alias helper for backward-compatibility with roundAmount.
 */
function roundAmount(val) {
  return roundToPaise(val);
}

/**
 * Sums a specific numeric property across an array of objects using Decimal arithmetic.
 * @param {Array} items
 * @param {string} fieldName
 * @returns {Decimal}
 */
function sumField(items, fieldName) {
  if (!Array.isArray(items)) return new Decimal(0);
  return items.reduce((sum, item) => {
    if (!item) return sum;
    const val = fieldName ? item[fieldName] : item;
    return sum.plus(toDecimal(val));
  }, new Decimal(0));
}

/**
 * Sums named amounts from an array of objects ({ amount: X }) or map and returns a rounded plain Number.
 */
function sumNamedAmounts(items) {
  if (!items) return 0;
  if (Array.isArray(items)) {
    return roundToPaise(sumField(items, 'amount'));
  }
  if (typeof items === 'object') {
    return roundToPaise(
      Object.values(items).reduce((sum, val) => sum.plus(toDecimal(val)), new Decimal(0))
    );
  }
  return 0;
}

module.exports = {
  Decimal,
  toDecimal,
  add,
  subtract,
  multiply,
  divide,
  roundToPaise,
  roundAmount,
  sumField,
  sumNamedAmounts,
};
