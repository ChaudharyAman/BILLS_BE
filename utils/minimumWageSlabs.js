/**
 * minimumWageSlabs.js
 *
 * Config-driven per-state minimum wage table for flagging statutory minimum wage compliance.
 * Flags for admin review without altering computed earnings.
 */

'use strict';

const MINIMUM_WAGE_TABLE = {
  KA: { daily: 450, hourly: 56.25 },
  MH: { daily: 480, hourly: 60.00 },
  DL: { daily: 650, hourly: 81.25 },
  TN: { daily: 420, hourly: 52.50 },
  GJ: { daily: 440, hourly: 55.00 },
  DEFAULT: { daily: 400, hourly: 50.00 },
};

function checkMinimumWageCompliance({ compensationType, gross, paidDays, hoursWorked, state = 'DEFAULT' }) {
  const compType = compensationType || 'monthly_salary';
  if (!['hourly', 'daily_wage', 'piece_rate', 'timesheet_based'].includes(compType)) {
    return null;
  }

  const stateKey = (state || 'DEFAULT').toUpperCase();
  const slabs = MINIMUM_WAGE_TABLE[stateKey] || MINIMUM_WAGE_TABLE.DEFAULT;
  let requiredMinimum = 0;

  if (compType === 'hourly' || compType === 'timesheet_based') {
    const hrs = Number(hoursWorked) || 0;
    requiredMinimum = hrs * slabs.hourly;
  } else {
    const days = Number(paidDays) || 0;
    requiredMinimum = days * slabs.daily;
  }

  requiredMinimum = Math.round(requiredMinimum * 100) / 100;

  if (requiredMinimum > 0 && gross < requiredMinimum) {
    return {
      flagged: true,
      state: stateKey,
      computedGross: gross,
      requiredMinimum,
      shortfall: Math.round((requiredMinimum - gross) * 100) / 100,
      warningMessage: `[Minimum Wage Flag] Computed gross (₹${gross}) is below statutory minimum wage floor (₹${requiredMinimum}) for state ${stateKey}`,
    };
  }

  return null;
}

module.exports = {
  MINIMUM_WAGE_TABLE,
  checkMinimumWageCompliance,
};
