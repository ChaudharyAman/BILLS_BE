/**
 * salaryPlusCommissionStrategy.js
 *
 * Base salary computed via the existing monthly_salary logic (CTC components),
 * plus commission from variableTransactions[] on top.
 * The commission portion is appended to earningsMap as 'commission'.
 *
 * Statutory flags: same as monthly_salary — eligible by default.
 * ponytail: delegates base to null (existing path) and signals commission addition.
 */
'use strict';

module.exports = {
  requiredPeriodInputFields: ['paidDays'],

  computeGrossEarnings(_src, _config, _periodInput) {
    // Base salary: existing CTC component logic runs unchanged.
    // Commission is added post-hoc by buildPayrollSnapshot reading
    // periodInput.variableTransactions and appending to variablePay.
    return null; // null = "use existing monthly_salary logic"
  },

  defaultStatutoryFlags() {
    return {
      pfEligible:       true,
      esiEligible:      true,
      ptApplicable:     true,
      gratuityEligible: true,
      lwfApplicable:    true,
    };
  },
};
