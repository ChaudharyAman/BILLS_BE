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

const roundAmount = (val) => Math.round((Number(val) || 0) * 100) / 100;

module.exports = {
  usesSalaryComponents: false,
  zeroesFixedAllowances: true,
  requiredPeriodInputFields: ['hoursWorked'],

  computeGrossEarnings(src, config, periodInput) {
    const hourlyRate = Number(src.hourlyRate || 0);
    const hours = src.hoursWorked !== undefined ? Number(src.hoursWorked) : 160;
    const gross = roundAmount(hourlyRate * hours);
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
