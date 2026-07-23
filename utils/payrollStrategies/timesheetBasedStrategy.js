/**
 * timesheetBasedStrategy.js
 *
 * Gross = (monthlyCTC / standardMonthlyHours) × hoursLogged.
 * standardMonthlyHours defaults to 160 (from PayrollConfig).
 * No salary components — single earnings line.
 */
'use strict';

const { divide, multiply, roundToPaise } = require('../money');

module.exports = {
  usesSalaryComponents: false,
  zeroesFixedAllowances: true,
  requiredPeriodInputFields: ['hoursLogged'],

  computeGrossEarnings(src, config, periodInput) {
    const stdHours = Number(config.standardMonthlyHours) || 160;
    const hoursLogged = Number(periodInput.hoursLogged || periodInput.hoursWorked || 0);
    const hourlyBlendedRate = divide(src.monthlyCTC || 0, stdHours);
    const gross = roundToPaise(multiply(hourlyBlendedRate, hoursLogged));

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
