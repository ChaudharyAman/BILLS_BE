/**
 * milestoneBasedStrategy.js
 *
 * Payment triggered by milestone completion.
 * Amount comes from periodInput.milestoneAmount (manually entered per payroll run),
 * matching the existing pattern for joiningBonus / specialBonus in adjustments.
 * No proration.
 *
 * ponytail: no Milestone model needed — accept amount from adjustments, same as joiningBonus.
 */
'use strict';

const roundAmount = (val) => Math.round((Number(val) || 0) * 100) / 100;

module.exports = {
  usesSalaryComponents: false,
  zeroesFixedAllowances: true,
  requiredPeriodInputFields: ['milestoneAmount'],

  computeGrossEarnings(_src, _config, periodInput) {
    const txns = periodInput.variableTransactions || [];
    const milestoneTxns = txns.filter(t => t.paymentType === 'MILESTONE');
    let gross = roundAmount(milestoneTxns.reduce((sum, t) => sum + (Number(t.amount) || 0), 0));

    if (gross === 0) {
      gross = roundAmount(Number(periodInput.milestoneAmount || 0));
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
