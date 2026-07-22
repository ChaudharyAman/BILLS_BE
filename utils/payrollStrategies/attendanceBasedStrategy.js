/**
 * attendanceBasedStrategy.js
 *
 * Like monthly_salary but proration on paidDays/workingDays is always
 * mandatory — no "full month" short-circuit. Typically used for interns,
 * contractual workers paid per actual working day, and migrated 'intern'
 * employmentType records.
 *
 * Statutory flags: all eligible (per-employee toggles still override).
 * ponytail: shares monthly_salary component math — only flag difference.
 */
'use strict';

module.exports = {
  usesSalaryComponents: true,
  zeroesFixedAllowances: false,
  requiredPeriodInputFields: ['paidDays', 'workingDays'],

  computeGrossEarnings(_src, _config, _periodInput) {
    // Uses existing CTC component path in buildMasterSalaryStructure.
    // The mandatory-proration behaviour is enforced in buildPayrollSnapshot
    // by checking attendanceMode === 'attendance' and never defaulting paidDays
    // to workingDays for this strategy.
    return null; // null = "use existing logic"
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
