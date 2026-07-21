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

const { roundAmount } = require('../payrollMath');

module.exports = {
  requiredPeriodInputFields: ['milestoneAmount'],

  computeGrossEarnings(_src, _config, periodInput) {
    const gross = roundAmount(Number(periodInput.milestoneAmount || 0));
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
