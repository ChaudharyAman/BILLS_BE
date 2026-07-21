/**
 * projectBasedStrategy.js
 *
 * Flat agreed project fee for the period.
 * Fee comes from periodInput.projectFee, or rateCard where paymentType === 'PROJECT'.
 * No proration — either paid in full or not at all.
 */
'use strict';

const { roundAmount } = require('../payrollMath');

module.exports = {
  requiredPeriodInputFields: ['projectFee'],

  computeGrossEarnings(src, _config, periodInput) {
    const rateCardEntry = (src.rateCard || []).find(r => r.paymentType === 'PROJECT');
    const gross = roundAmount(
      rateCardEntry ? Number(rateCardEntry.rate) : Number(periodInput.projectFee || src.monthlyCTC || 0)
    );

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
