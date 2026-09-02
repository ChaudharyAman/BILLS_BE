/**
 * utils/salaryRevisionHelper.js
 *
 * Appends a salaryRevisions[] entry on an Employee document if any compensation-affecting
 * fields (monthlyCTC, hourlyRate, dailyRate, weeklyRate, projectFee, milestoneAmount, rateCard)
 * have changed.
 *
 * Ensures historical payroll correctness via getEmployeeParamsForDate().
 */

const { resolveStrategy } = require('./payrollStrategies/index');

/**
 * Checks updateData against an existing Employee document for compensation changes,
 * bootstraps an initial revision if salaryRevisions[] is empty, and appends a new
 * salaryRevisions[] entry.
 *
 * @param {Object} params
 * @param {Object} params.employee       - Mongoose Employee document (or plain object with current values)
 * @param {Object} params.updateData     - The updates about to be applied to the Employee document
 * @param {Date}   [params.effectiveDate]- Effective date for the revision (defaults to today)
 * @param {string} [params.reason]       - Reason for revision
 * @param {string|Object} [params.revisedBy] - User ID or System identifier
 * @returns {Promise<Object|null>} The created salary revision entry, or null if no compensation change occurred.
 */
async function appendSalaryRevisionIfChanged({
  employee,
  updateData,
  effectiveDate = new Date(),
  reason = 'Compensation adjustment',
  revisedBy = 'System',
}) {
  if (!employee || !updateData) return null;

  const oldCTC = Number(employee.monthlyCTC) || 0;
  const newCTC = updateData.monthlyCTC !== undefined ? Number(updateData.monthlyCTC) : oldCTC;
  const oldHourly = Number(employee.hourlyRate) || 0;
  const newHourly = updateData.hourlyRate !== undefined ? Number(updateData.hourlyRate) : oldHourly;
  const oldDaily = Number(employee.dailyRate) || 0;
  const newDaily = updateData.dailyRate !== undefined ? Number(updateData.dailyRate) : oldDaily;

  const oldWeekly = Number(employee.weeklyRate) || 0;
  const newWeekly = updateData.weeklyRate !== undefined ? Number(updateData.weeklyRate) : oldWeekly;
  const oldProjectFee = Number(employee.projectFee) || 0;
  const newProjectFee = updateData.projectFee !== undefined ? Number(updateData.projectFee) : oldProjectFee;
  const oldMilestone = Number(employee.milestoneAmount) || 0;
  const newMilestone = updateData.milestoneAmount !== undefined ? Number(updateData.milestoneAmount) : oldMilestone;

  const oldRateCardStr = JSON.stringify(employee.rateCard || []);
  const newRateCardStr = updateData.rateCard !== undefined ? JSON.stringify(updateData.rateCard || []) : oldRateCardStr;

  const isSalariedChange = updateData.monthlyCTC !== undefined && newCTC !== oldCTC;
  const isHourlyChange = updateData.hourlyRate !== undefined && newHourly !== oldHourly;
  const isDailyChange = updateData.dailyRate !== undefined && newDaily !== oldDaily;
  const isWeeklyChange = updateData.weeklyRate !== undefined && newWeekly !== oldWeekly;
  const isProjectFeeChange = updateData.projectFee !== undefined && newProjectFee !== oldProjectFee;
  const isMilestoneChange = updateData.milestoneAmount !== undefined && newMilestone !== oldMilestone;
  const isRateCardChange = updateData.rateCard !== undefined && oldRateCardStr !== newRateCardStr;

  const oldCompType = employee.compensationType || null;
  const newCompType = updateData.compensationType !== undefined ? updateData.compensationType : oldCompType;
  const isCompTypeChange = updateData.compensationType !== undefined && newCompType !== oldCompType;

  const isSalaryChange = isSalariedChange || isHourlyChange || isDailyChange || isWeeklyChange || isProjectFeeChange || isMilestoneChange || isRateCardChange || isCompTypeChange;

  if (!isSalaryChange) return null;

  const effectiveCompType = updateData.compensationType || employee.compensationType || 'monthly_salary';
  // isNonComponent: true for all strategy types where usesSalaryComponents === false
  // (hourly, timesheet_based, commission_only, daily_wage, milestone_based, piece_rate, project_based, retainer).
  // Derived from the strategy registry — the single source of truth used by salaryStructure.js.
  const isNonComponent = !resolveStrategy(effectiveCompType).usesSalaryComponents;

  const previousCTC = oldCTC || Number(employee.salaryStructure?.ctc) || 0;
  const previousHourlyRate = oldHourly || 0;

  // Initialize array if missing
  if (!employee.salaryRevisions) {
    employee.salaryRevisions = [];
  }

  // If no salary revisions exist yet, bootstrap an initial setup entry first
  if (employee.salaryRevisions.length === 0) {
    employee.salaryRevisions.push({
      effectiveDate: employee.joiningDate || new Date(0),
      previousCTC: 0,
      newCTC: isNonComponent ? 0 : previousCTC,
      previousHourlyRate: isNonComponent ? 0 : undefined,
      newHourlyRate: isNonComponent ? previousHourlyRate : undefined,
      hourlyRate: isNonComponent ? previousHourlyRate : undefined,
      reason: 'Initial Salary Setup',
      revisedBy: 'System',
      createdAt: employee.createdAt || new Date(),
      role: employee.role || null,
      compensationType: effectiveCompType,
      useSalaryComponents: !isNonComponent && employee.useSalaryComponents !== false,
      employmentType: employee.employmentType || 'full-time',
      compensationModel: employee.compensationModel || 'SALARIED',
      paymentBasis: employee.paymentBasis || 'MONTHLY',

      monthlyCTC: isNonComponent ? 0 : previousCTC,
      pfEnabled: isNonComponent ? false : employee.pfEnabled !== false,
      esiEnabled: isNonComponent ? false : employee.esiEnabled !== false,
      ptEnabled: isNonComponent ? false : employee.ptEnabled !== false,
      ptState: employee.ptState || '',
      lwfEnabled: isNonComponent ? false : employee.lwfEnabled !== false,
      gratuityEnabled: isNonComponent ? false : employee.gratuityEnabled !== false,
      includePfInCTC: isNonComponent ? false : employee.includePfInCTC === true,
      includeGratuityInCTC: isNonComponent ? false : employee.includeGratuityInCTC !== false,
      basicPercent: isNonComponent ? null : employee.basicPercent,
      hraPercent: isNonComponent ? null : employee.hraPercent,
      joiningBonus: isNonComponent ? 0 : (Number(employee.joiningBonus) || 0),
      flexiAmount: isNonComponent ? 0 : (Number(employee.flexiAmount) || 0),
      broadband: isNonComponent ? 0 : (Number(employee.broadband) || 0),
      petrol: isNonComponent ? 0 : (Number(employee.petrol) || 0),
      lta: isNonComponent ? 0 : (Number(employee.lta) || 0),
      employerNPS: isNonComponent ? 0 : (Number(employee.employerNPS) || 0),
      insuranceAmount: isNonComponent ? 0 : (Number(employee.insuranceAmount) || 0),
      dailyRate: Number(employee.dailyRate) || 0,
      weeklyRate: Number(employee.weeklyRate) || 0,
      projectFee: Number(employee.projectFee) || 0,
      milestoneAmount: Number(employee.milestoneAmount) || 0,
      commissionNotes: employee.commissionNotes || '',
      deductions: {
        tds: employee.deductions?.tds || 0,
        professionalTax: isNonComponent ? 0 : (employee.deductions?.professionalTax || 0),
        otherDeductions: isNonComponent ? [] : (employee.deductions?.otherDeductions || []),
      },
      salaryStructure: {
        conveyance: isNonComponent ? 0 : (Number(employee.salaryStructure?.conveyance) || 0),
        medicalAllowance: isNonComponent ? 0 : (Number(employee.salaryStructure?.medicalAllowance) || 0),
        otherAllowances: isNonComponent ? [] : (employee.salaryStructure?.otherAllowances || []),
      },
    });
  }

  const getVal = (field) => (updateData[field] !== undefined ? updateData[field] : employee[field]);
  const getNum = (field) => (updateData[field] !== undefined ? Number(updateData[field]) : (Number(employee[field]) || 0));

  const revisionEntry = {
    effectiveDate: effectiveDate ? new Date(effectiveDate) : new Date(),
    previousCTC: isNonComponent ? 0 : oldCTC,
    newCTC: isNonComponent ? 0 : newCTC,
    previousHourlyRate: isNonComponent ? oldHourly : undefined,
    newHourlyRate: isNonComponent ? newHourly : undefined,
    hourlyRate: isNonComponent ? newHourly : undefined,
    reason: reason || 'Compensation adjustment',
    revisedBy: revisedBy || 'System',
    createdAt: new Date(),
    role: getVal('role') || null,
    compensationType: effectiveCompType,
    useSalaryComponents: !isNonComponent && getVal('useSalaryComponents') !== false,
    employmentType: getVal('employmentType') || 'full-time',
    compensationModel: getVal('compensationModel') || 'SALARIED',
    paymentBasis: getVal('paymentBasis') || 'MONTHLY',
    rateCard: updateData.rateCard !== undefined ? updateData.rateCard : employee.rateCard,

    monthlyCTC: isNonComponent ? 0 : newCTC,
    pfEnabled: isNonComponent ? false : getVal('pfEnabled') !== false,
    esiEnabled: isNonComponent ? false : getVal('esiEnabled') !== false,
    ptEnabled: isNonComponent ? false : getVal('ptEnabled') !== false,
    ptState: getVal('ptState') || '',
    lwfEnabled: isNonComponent ? false : getVal('lwfEnabled') !== false,
    gratuityEnabled: isNonComponent ? false : getVal('gratuityEnabled') !== false,
    includePfInCTC: isNonComponent ? false : getVal('includePfInCTC') === true,
    includeGratuityInCTC: isNonComponent ? false : getVal('includeGratuityInCTC') !== false,
    basicPercent: isNonComponent ? null : (getVal('basicPercent') ?? null),
    hraPercent: isNonComponent ? null : (getVal('hraPercent') ?? null),
    joiningBonus: isNonComponent ? 0 : getNum('joiningBonus'),
    flexiAmount: isNonComponent ? 0 : getNum('flexiAmount'),
    broadband: isNonComponent ? 0 : getNum('broadband'),
    petrol: isNonComponent ? 0 : getNum('petrol'),
    lta: isNonComponent ? 0 : getNum('lta'),
    employerNPS: isNonComponent ? 0 : getNum('employerNPS'),
    insuranceAmount: isNonComponent ? 0 : getNum('insuranceAmount'),
    dailyRate: getNum('dailyRate'),
    weeklyRate: getNum('weeklyRate'),
    projectFee: getNum('projectFee'),
    milestoneAmount: getNum('milestoneAmount'),
    commissionNotes: getVal('commissionNotes') || '',
    deductions: {
      tds: updateData.deductions?.tds !== undefined ? Number(updateData.deductions.tds) : (employee.deductions?.tds || 0),
      professionalTax: isNonComponent ? 0 : (updateData.deductions?.professionalTax !== undefined ? Number(updateData.deductions.professionalTax) : (employee.deductions?.professionalTax || 0)),
      otherDeductions: isNonComponent ? [] : (updateData.deductions?.otherDeductions !== undefined ? updateData.deductions.otherDeductions : (employee.deductions?.otherDeductions || [])),
    },
    salaryStructure: {
      conveyance: isNonComponent ? 0 : (updateData.salaryStructure?.conveyance !== undefined ? Number(updateData.salaryStructure.conveyance) : (Number(employee.salaryStructure?.conveyance) || 0)),
      medicalAllowance: isNonComponent ? 0 : (updateData.salaryStructure?.medicalAllowance !== undefined ? Number(updateData.salaryStructure.medicalAllowance) : (Number(employee.salaryStructure?.medicalAllowance) || 0)),
      otherAllowances: isNonComponent ? [] : (updateData.salaryStructure?.otherAllowances !== undefined ? updateData.salaryStructure.otherAllowances : (employee.salaryStructure?.otherAllowances || [])),
    },
  };

  employee.salaryRevisions.push(revisionEntry);
  return revisionEntry;
}

module.exports = {
  appendSalaryRevisionIfChanged,
};
