/**
 * retainerStrategy.js
 *
 * Fixed monthly retainer — always fully paid regardless of attendance.
 * Gross = monthlyCTC (or rateCard where paymentType === 'MONTHLY').
 * No salary components; no attendance proration; no statutory deductions by default.
 * Covers migrated CONSULTANT / PROJECT / POSITION compensationModel records.
 */
'use strict';

const roundAmount = (val) => Math.round((Number(val) || 0) * 100) / 100;

module.exports = {
  usesSalaryComponents: false,
  zeroesFixedAllowances: true,
  requiredPeriodInputFields: [], // attendanceMode: 'none' / 'fixed'

  computeGrossEarnings(src, _config, _periodInput) {
    const rateCardEntry = (src.rateCard || []).find(r => r.paymentType === 'MONTHLY');
    const gross = roundAmount(
      rateCardEntry ? Number(rateCardEntry.rate) : Number(src.monthlyCTC || 0)
    );

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
