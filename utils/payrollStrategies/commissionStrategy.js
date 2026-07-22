/**
 * commissionStrategy.js
 *
 * Gross = total commission from variableTransactions[].
 * variableTransactions already exists as an adjustments key in usePayrollSnapshot;
 * the engine sums them as variableCompensation. This strategy marks those as
 * the ONLY earnings — no base salary.
 *
 * ponytail: reuse variableTransactions[] mechanism; no new commission ledger.
 */
'use strict';

const roundAmount = (val) => Math.round((Number(val) || 0) * 100) / 100;

module.exports = {
  usesSalaryComponents: false,
  zeroesFixedAllowances: true,
  requiredPeriodInputFields: [],

  computeGrossEarnings(_src, _config, periodInput) {
    const txns = periodInput.variableTransactions || [];
    const commissionTxns = txns.filter(t => !t.paymentType || t.paymentType === 'COMMISSION' || t.paymentType === 'PERCENTAGE');
    const gross = roundAmount(commissionTxns.reduce((sum, t) => sum + (Number(t.amount) || 0), 0));

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
