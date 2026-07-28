/**
 * pieceRateStrategy.js
 *
 * Gross = ratePerUnit × unitsProduced.
 * ratePerUnit comes from rateCard where paymentType === 'UNIT', else
 * falls back to periodInput.ratePerUnit.
 */
'use strict';

const { multiply, roundToPaise } = require('../money');

module.exports = {
  usesSalaryComponents: false,
  zeroesFixedAllowances: true,
  requiredPeriodInputFields: ['unitsProduced'],

  computeGrossEarnings(src, _config, periodInput) {
    const units = periodInput.unitsProduced !== undefined ? Number(periodInput.unitsProduced) : 1;
    const rateCardEntry = (src.rateCard || []).find(r => r.paymentType === 'UNIT') || (src.rateCard || [])[0];
    const ratePerUnit = rateCardEntry
      ? Number(rateCardEntry.rate)
      : Number(periodInput.ratePerUnit || 0);
    const gross = roundToPaise(multiply(units, ratePerUnit));

    return {
      gross,
      earningsMap: { basic: gross },
      basicMaster: gross,
      hraMaster: 0,
    };
  },

  defaultStatutoryFlags() {
    return {
      pfEligible:       false,
      esiEligible:      false,
      ptApplicable:     false,
      gratuityEligible: false,
      lwfApplicable:    false,
    };
  },
};
