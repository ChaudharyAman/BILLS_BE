/**
 * pieceRateStrategy.js
 *
 * Gross = ratePerUnit × unitsProduced.
 * ratePerUnit comes from rateCard where paymentType === 'UNIT', else
 * falls back to periodInput.ratePerUnit.
 */
'use strict';

const { roundAmount } = require('../payrollMath');

module.exports = {
  requiredPeriodInputFields: ['unitsProduced'],

  computeGrossEarnings(src, _config, periodInput) {
    const units = Number(periodInput.unitsProduced || 0);
    const rateCardEntry = (src.rateCard || []).find(r => r.paymentType === 'UNIT');
    const ratePerUnit = rateCardEntry
      ? Number(rateCardEntry.rate)
      : Number(periodInput.ratePerUnit || 0);
    const gross = roundAmount(units * ratePerUnit);

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
