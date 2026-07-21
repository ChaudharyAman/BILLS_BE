/**
 * payrollStrategies/index.js
 *
 * Central strategy registry for the payroll engine.
 *
 * Each strategy must implement the interface:
 *   computeGrossEarnings(src, config, periodInput) → EarningsResult
 *   defaultStatutoryFlags()                        → StatutoryFlags
 *   requiredPeriodInputFields                       : string[]
 *
 * EarningsResult  — same shape buildMasterSalaryStructure() currently returns
 * StatutoryFlags  — { pfEligible, esiEligible, ptApplicable, gratuityEligible, lwfApplicable }
 *
 * ponytail: registry is a plain object lookup — no factory class needed.
 */

'use strict';

const strategies = {
  monthly_salary:         require('./monthlySalaryStrategy'),
  hourly:                 require('./hourlyStrategy'),
  daily_wage:             require('./dailyWageStrategy'),
  weekly_salary:          require('./monthlySalaryStrategy'), // same compute, payFrequency handled upstream
  piece_rate:             require('./pieceRateStrategy'),
  project_based:          require('./projectBasedStrategy'),
  milestone_based:        require('./milestoneBasedStrategy'),
  attendance_based:       require('./attendanceBasedStrategy'),
  timesheet_based:        require('./timesheetBasedStrategy'),
  commission_only:        require('./commissionStrategy'),
  salary_plus_commission: require('./salaryPlusCommissionStrategy'),
  retainer:               require('./retainerStrategy'),
};

/**
 * Derives a compensationType from the legacy payType / compensationModel / employmentType trio.
 * Called during the migration window when compensationType is null on a document.
 */
function deriveCompensationTypeFromLegacy({ payType, compensationModel, employmentType } = {}) {
  if (payType === 'hourly') return 'hourly';
  if (employmentType === 'intern') return 'attendance_based';
  if (!compensationModel || compensationModel === 'SALARIED') return 'monthly_salary';
  if (['CONSULTANT', 'PROJECT', 'POSITION', 'INTERVIEW'].includes(compensationModel)) return 'retainer';
  if (compensationModel === 'HOURLY') return 'hourly';
  return 'monthly_salary'; // safe default
}

/**
 * Resolves the compensationType for a source object, falling back to legacy derivation.
 */
function resolveCompensationType(src) {
  return src.compensationType || deriveCompensationTypeFromLegacy(src);
}

/**
 * Returns the strategy object for a given compensationType.
 * Falls back to monthly_salary if unknown — never throws.
 */
function resolveStrategy(compensationType) {
  return strategies[compensationType] || strategies.monthly_salary;
}

/**
 * Returns defaultStatutoryFlags for a given compensationType,
 * merged with any per-tenant overrides from PayrollConfig.compensationTypeDefaults.
 */
function getStrategyStatutoryDefaults(compensationType, configOverrides = {}) {
  const strategy = resolveStrategy(compensationType);
  const base = strategy.defaultStatutoryFlags();
  const override = configOverrides[compensationType] || {};
  return { ...base, ...override };
}

module.exports = {
  resolveStrategy,
  resolveCompensationType,
  deriveCompensationTypeFromLegacy,
  getStrategyStatutoryDefaults,
};
