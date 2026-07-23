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

const { roundToPaise, sumField } = require('../money');

module.exports = {
  usesSalaryComponents: false,
  zeroesFixedAllowances: true,
  requiredPeriodInputFields: ['milestoneAmount'],

  computeGrossEarnings(_src, _config, periodInput) {
    const txns = periodInput.variableTransactions || [];
    const milestoneTxns = txns.filter(t => t.paymentType === 'MILESTONE');
    let gross = roundToPaise(sumField(milestoneTxns, 'amount'));

    if (gross === 0) {
      gross = roundToPaise(periodInput.milestoneAmount || 0);
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
