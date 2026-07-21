/**
 * monthlySalaryStrategy.js
 *
 * The existing "salaried" path. Does nothing — buildMasterSalaryStructure()
 * already handles it fully. This module exists as the explicit identity
 * strategy so the registry can dispatch to it.
 *
 * Statutory flags: all eligible by default (per-employee toggles override).
 */
'use strict';

module.exports = {
  requiredPeriodInputFields: ['paidDays'],

  /** Called by buildMasterSalaryStructure after it resolves compensationType. */
  computeGrossEarnings(_src, _config, _periodInput) {
    // The full salary-component logic lives in buildMasterSalaryStructure.
    // This strategy is a no-op marker; the engine runs the existing code path.
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
