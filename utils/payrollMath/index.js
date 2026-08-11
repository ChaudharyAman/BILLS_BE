/**
 * utils/payrollMath/index.js
 *
 * Central export hub for all decomposed payroll math modules.
 * Re-exports every function and constant to preserve exact backward compatibility.
 */

const { roundAmount, sumNamedAmounts } = require('../money');
const { clamp, getSegmentLops, getDayProrateArray } = require('./proration');
const { calculateHRAExemption, calculateTaxForRegime, calculateTaxDetails } = require('./tax');
const { computeStatutoryAndTax, calculateGratuityEntitlement, getConfigForDate, getOrCreateConfig } = require('./statutory');
const { DEFAULT_PAYROLL_CONFIG, normalizeConfig, getMonthlyCTCValue, buildMasterSalaryStructure, getSalarySplits } = require('./salaryStructure');
const { buildPayrollSnapshot } = require('./snapshot');
const { buildPayslipEarningsLineItems, buildPayslipDeductionsLineItems } = require('./payslipLineItems');
const { buildTaxWorksheet } = require('./taxWorksheet');
const { NON_COMPONENT_TYPES, resolveNonComponentRowSpec } = require('./compensationRowSpec');

module.exports = {
  DEFAULT_PAYROLL_CONFIG,
  roundAmount,
  sumNamedAmounts,
  clamp,
  getSegmentLops,
  getDayProrateArray,
  calculateHRAExemption,
  calculateTaxForRegime,
  calculateTaxDetails,
  computeStatutoryAndTax,
  calculateGratuityEntitlement,
  getConfigForDate,
  getOrCreateConfig,
  normalizeConfig,
  getMonthlyCTCValue,
  buildMasterSalaryStructure,
  getSalarySplits,
  buildPayrollSnapshot,
  buildPayslipEarningsLineItems,
  buildPayslipDeductionsLineItems,
  buildTaxWorksheet,
  NON_COMPONENT_TYPES,
  resolveNonComponentRowSpec,
};
