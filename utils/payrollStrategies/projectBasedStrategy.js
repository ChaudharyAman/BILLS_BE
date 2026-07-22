/**
 * projectBasedStrategy.js
 *
 * Flat agreed project fee for the period.
 * Fee comes from periodInput.projectFee, or rateCard where paymentType === 'PROJECT'.
 * No proration — either paid in full or not at all.
 */
'use strict';

const roundAmount = (val) => Math.round((Number(val) || 0) * 100) / 100;

module.exports = {
  usesSalaryComponents: false,
  zeroesFixedAllowances: true,
  requiredPeriodInputFields: ['projectFee'],

  computeGrossEarnings(src, _config, periodInput) {
    const txns = periodInput.variableTransactions || [];
    const projectTxns = txns.filter(t => t.paymentType === 'PROJECT');
    let gross = roundAmount(projectTxns.reduce((sum, t) => sum + (Number(t.amount) || 0), 0));

    if (gross === 0) {
      const rateCardEntry = (src.rateCard || []).find(r => r.paymentType === 'PROJECT');
      gross = roundAmount(
        rateCardEntry ? Number(rateCardEntry.rate) : Number(periodInput.projectFee || src.monthlyCTC || 0)
      );
    }

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
