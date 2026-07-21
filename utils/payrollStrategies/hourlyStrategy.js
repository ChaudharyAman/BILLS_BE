/**
 * hourlyStrategy.js
 *
 * Existing hourly path: gross = hourlyRate × hoursWorked.
 * No salary components; no statutory deductions by default.
 *
 * The engine already handles this via `src.payType === 'hourly'`.
 * This strategy is the explicit marker so the registry can dispatch
 * and Employee.js no longer needs inline isHourly ternaries.
 */
'use strict';

module.exports = {
  requiredPeriodInputFields: ['hoursWorked'],

  computeGrossEarnings(_src, _config, _periodInput) {
    // Existing isHourly branch in buildMasterSalaryStructure handles this.
    return null; // null = "use existing logic"
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
