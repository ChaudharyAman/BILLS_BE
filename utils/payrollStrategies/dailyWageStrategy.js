/**
 * dailyWageStrategy.js
 *
 * Gross = dailyRate × daysWorked.
 * dailyRate is stored in employee.rateCard[0].rate where paymentType === 'DAY',
 * or derived from monthlyCTC / workingDays if no explicit rate is set.
 * No salary components; no statutory deductions by default.
 */
'use strict';

const { divide, multiply, roundToPaise } = require('../money');

module.exports = {
  usesSalaryComponents: false,
  zeroesFixedAllowances: true,
  requiredPeriodInputFields: ['daysWorked'],

  computeGrossEarnings(src, config, periodInput) {
    const daysWorked = Number(periodInput.daysWorked || src.hoursWorked || 0);
    // Resolve daily rate: explicit rateCard entry > CTC / working days
    const rateCardEntry = (src.rateCard || []).find(r => r.paymentType === 'DAY');
    const dailyRate = rateCardEntry
      ? Number(rateCardEntry.rate)
      : roundToPaise(divide(src.monthlyCTC || 0, config.defaultWorkingDays || 26));
    const gross = roundToPaise(multiply(dailyRate, daysWorked));

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
