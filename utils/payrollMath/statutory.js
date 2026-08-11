/**
 * utils/payrollMath/statutory.js
 *
 * Statutory PF, ESI, PT, LWF, and Gratuity calculations, plus statutory config version resolution.
 */

const { getMonthlyPT } = require('../professionalTaxSlabs');
const { calculateTaxDetails } = require('./tax');
const { roundAmount } = require('../money');

const computeStatutoryAndTax = ({
  gross,
  basicMaster,
  hraMaster = 0,
  monthlyCTC,
  flags,
  config,
  src
}) => {
  const {
    pfEnabled,
    esiEnabled,
    ptEnabled,
    lwfEnabled,
    tdsEnabled,
    gratuityEnabled,
  } = flags;

  // 1. PF Calculation
  let pfEmployer = 0;
  let pfEmployee = 0;
  let pfBase = 0;
  if (pfEnabled) {
    if (config.pfCalculationType === 'fixed') {
      pfEmployer = roundAmount(config.pfAmountEmployer);
      pfEmployee = roundAmount(config.pfAmountEmployee);
      pfBase = pfEmployee;
    } else {
      pfBase = roundAmount(Math.min(basicMaster, config.pfCap));
      pfEmployer = roundAmount(pfBase * config.pfEmployerRate);
      pfEmployee = roundAmount(pfBase * config.pfRate);
    }
  }

  // 2. Gratuity Calculation
  const gratuity = gratuityEnabled ? roundAmount(basicMaster * config.gratuityRate) : 0;

  // 3. LWF Calculation — deducted semi-annually (June/Month 6 & Dec/Month 12) unless set to monthly
  const isLwfCycleMonth = !src._month || src._month % 6 === 0 || config.lwfFrequency === 'monthly';
  const lwfEmployer = (lwfEnabled && gross > 0 && isLwfCycleMonth) ? roundAmount(config.lwfEmployer) : 0;
  const lwfEmployee = (lwfEnabled && gross > 0 && isLwfCycleMonth) ? roundAmount(config.lwfEmployee) : 0;

  // 4. ESI Calculation — project full monthly-equivalent gross for partial periods
  const periodRatio = (src._paidDays && src._workingDays && src._workingDays > 0)
    ? (src._paidDays / src._workingDays)
    : 1;
  const projectedMonthlyGross = (periodRatio > 0 && periodRatio < 1)
    ? roundAmount(gross / periodRatio)
    : (monthlyCTC || gross);

  const esiApplicable = esiEnabled && (projectedMonthlyGross <= config.esiBasicThreshold);
  // ESI is on gross wages (ESI Act, 1948 — Section 2(22), "wages" = all remuneration).
  const esiEmployer = roundAmount(esiApplicable ? gross * config.esiEmployerRate : 0);
  const esiEmployee = roundAmount(esiApplicable ? gross * config.esiEmployeeRate : 0);

  // 5. Dynamic Tax Engine Calculations (TDS)
  const taxRegime = src.taxRegime || 'new';
  const declarations = src.declarations || {};

  const taxDetails = calculateTaxDetails({
    ...src,
    ptEnabled,
    taxRegime,
    declarations
  }, monthlyCTC || gross, config, basicMaster, hraMaster, gross);

  const calculatedTdsMonthly = taxDetails[taxRegime === 'old' ? 'oldRegime' : 'newRegime'].monthlyTax;
  const tds = tdsEnabled
    ? (Number(src.deductions?.tds) > 0 ? Number(src.deductions?.tds) : roundAmount(calculatedTdsMonthly))
    : 0;

  // 6. Professional Tax
  const manualPT = Number(src.deductions?.professionalTax) || 0;
  const computedPT = (ptEnabled && src.ptState)
    ? getMonthlyPT(src.ptState, gross, src._month, src._year)
    : 0;
  const professionalTax = ptEnabled
    ? (manualPT > 0 ? manualPT : computedPT)
    : 0;

  const insurance = gross > 0 ? roundAmount(src.insuranceAmount ?? config.defaultInsurance) : 0;
  const employerNPS = roundAmount(src.employerNPS);

  const totalEmployerContributions = roundAmount(
    pfEmployer + esiEmployer + gratuity + lwfEmployer + insurance + employerNPS
  );

  return {
    pfBase,
    pfEmployer,
    pfEmployee,
    gratuity,
    lwfEmployer,
    lwfEmployee,
    esiApplicable,
    esiEmployer,
    esiEmployee,
    taxRegime,
    declarations,
    taxDetails,
    tds,
    professionalTax,
    insurance,
    employerNPS,
    totalEmployerContributions,
  };
};

const calculateGratuityEntitlement = (joiningDate, separationDate, basicPlusDa) => {
  const GRATUITY_CAP = 2000000;
  const MIN_SERVICE_YEARS = 5;

  const joining = new Date(joiningDate);
  const separation = new Date(separationDate || Date.now());

  if (
    isNaN(joining.getTime()) ||
    isNaN(separation.getTime()) ||
    separation <= joining
  ) {
    return {
      eligible: false,
      completedYears: 0,
      completedMonths: 0,
      roundedYears: 0,
      entitlement: 0,
      cappedEntitlement: 0,
      isCapped: false,
      note: 'Invalid dates — joining date must be before separation date.',
    };
  }

  let years = separation.getFullYear() - joining.getFullYear();
  let months = separation.getMonth() - joining.getMonth();
  let days = separation.getDate() - joining.getDate();

  if (days < 0) {
    months -= 1;
    const prevMonth = new Date(separation.getFullYear(), separation.getMonth(), 0);
    days += prevMonth.getDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }

  const totalMonths = years * 12 + months;
  const roundedYears = years + (months >= 6 ? 1 : 0);
  const roundingNote = months >= 6
    ? `${months} months in final year ≥ 6 → rounded up to full year.`
    : months > 0
      ? `${months} months in final year < 6 → discarded.`
      : '';

  if (years < MIN_SERVICE_YEARS) {
    const yearsRemaining = MIN_SERVICE_YEARS - years;
    const monthsRemaining = months > 0 ? (12 - months) : 0;
    const note = monthsRemaining > 0
      ? `Ineligible. Requires ${yearsRemaining} year(s) and ${monthsRemaining} more month(s) of service.`
      : `Ineligible. Requires ${yearsRemaining} more year(s) of service.`;
    return {
      eligible: false,
      completedYears: years,
      completedMonths: totalMonths,
      roundedYears: 0,
      entitlement: 0,
      cappedEntitlement: 0,
      isCapped: false,
      note,
    };
  }

  const gross = Number(basicPlusDa) || 0;
  const entitlement = roundAmount(gross * 15 / 26 * roundedYears);
  const capped = Math.min(entitlement, GRATUITY_CAP);
  const isCapped = entitlement > GRATUITY_CAP;

  const note = [
    `Eligible. ${years} completed year(s), ${months} month(s).`,
    roundingNote,
    isCapped ? `Entitlement (₹${entitlement.toLocaleString('en-IN')}) exceeds statutory cap — capped at ₹20,00,000.` : '',
  ].filter(Boolean).join(' ');

  return {
    eligible: true,
    completedYears: years,
    completedMonths: totalMonths,
    roundedYears,
    entitlement,
    cappedEntitlement: capped,
    isCapped,
    note,
  };
};

const getConfigForDate = async (userId, targetDate = new Date()) => {
  const PayrollConfig = require('../../models/PayrollConfig');
  const dateObj = new Date(targetDate);
  let config = await PayrollConfig.findOne({
    user: userId,
    effectiveFrom: { $lte: dateObj }
  }).sort({ effectiveFrom: -1, createdAt: -1 });

  if (!config) {
    config = await PayrollConfig.findOne({ user: userId }).sort({ effectiveFrom: 1 });
    if (!config) {
      config = await PayrollConfig.create({ user: userId, effectiveFrom: new Date('2020-01-01') });
    }
  }
  return config;
};

const getOrCreateConfig = getConfigForDate;

module.exports = {
  computeStatutoryAndTax,
  calculateGratuityEntitlement,
  getConfigForDate,
  getOrCreateConfig,
};
