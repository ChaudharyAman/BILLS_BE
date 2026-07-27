/**
 * utils/salaryRevisionHelper.js
 *
 * Appends a salaryRevisions[] entry on an Employee document if any compensation-affecting
 * fields (monthlyCTC, hourlyRate, dailyRate, rateCard) have changed.
 *
 * Ensures historical payroll correctness via getEmployeeParamsForDate().
 */

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

  const oldRateCardStr = JSON.stringify(employee.rateCard || []);
  const newRateCardStr = updateData.rateCard !== undefined ? JSON.stringify(updateData.rateCard || []) : oldRateCardStr;

  const isSalariedChange = updateData.monthlyCTC !== undefined && newCTC !== oldCTC;
  const isHourlyChange = updateData.hourlyRate !== undefined && newHourly !== oldHourly;
  const isDailyChange = updateData.dailyRate !== undefined && newDaily !== oldDaily;
  const isRateCardChange = updateData.rateCard !== undefined && oldRateCardStr !== newRateCardStr;

  const oldCompType = employee.compensationType || null;
  const newCompType = updateData.compensationType !== undefined ? updateData.compensationType : oldCompType;
  const isCompTypeChange = updateData.compensationType !== undefined && newCompType !== oldCompType;

  const isSalaryChange = isSalariedChange || isHourlyChange || isDailyChange || isRateCardChange || isCompTypeChange;

  if (!isSalaryChange) return null;

  const effectiveCompType = updateData.compensationType || employee.compensationType || 'monthly_salary';
  const isHourly = ['hourly', 'timesheet_based'].includes(effectiveCompType) || employee.payType === 'hourly';

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
      previousCTC: isHourly ? 0 : 0,
      newCTC: isHourly ? 0 : previousCTC,
      previousHourlyRate: isHourly ? 0 : undefined,
      newHourlyRate: isHourly ? previousHourlyRate : undefined,
      hourlyRate: isHourly ? previousHourlyRate : undefined,
      reason: 'Initial Salary Setup',
      revisedBy: 'System',
      createdAt: employee.createdAt || new Date(),
      role: employee.role || null,
      useSalaryComponents: isHourly ? false : employee.useSalaryComponents !== false,
      employmentType: employee.employmentType || 'full-time',
      compensationModel: employee.compensationModel || 'SALARIED',
      paymentBasis: employee.paymentBasis || 'MONTHLY',

      monthlyCTC: isHourly ? 0 : previousCTC,
      pfEnabled: isHourly ? false : employee.pfEnabled !== false,
      esiEnabled: isHourly ? false : employee.esiEnabled !== false,
      ptEnabled: isHourly ? false : employee.ptEnabled !== false,
      lwfEnabled: isHourly ? false : employee.lwfEnabled !== false,
      gratuityEnabled: isHourly ? false : employee.gratuityEnabled !== false,
      includePfInCTC: isHourly ? false : employee.includePfInCTC === true,
      includeGratuityInCTC: isHourly ? false : employee.includeGratuityInCTC !== false,
      basicPercent: isHourly ? null : employee.basicPercent,
      hraPercent: isHourly ? null : employee.hraPercent,
      joiningBonus: isHourly ? 0 : (Number(employee.joiningBonus) || 0),
      flexiAmount: isHourly ? 0 : (Number(employee.flexiAmount) || 0),
      broadband: isHourly ? 0 : (Number(employee.broadband) || 0),
      petrol: isHourly ? 0 : (Number(employee.petrol) || 0),
      lta: isHourly ? 0 : (Number(employee.lta) || 0),
      employerNPS: isHourly ? 0 : (Number(employee.employerNPS) || 0),
      insuranceAmount: isHourly ? 0 : (Number(employee.insuranceAmount) || 0),
      deductions: {
        tds: employee.deductions?.tds || 0,
        professionalTax: isHourly ? 0 : (employee.deductions?.professionalTax || 0),
        otherDeductions: isHourly ? [] : (employee.deductions?.otherDeductions || []),
      },
      salaryStructure: {
        conveyance: isHourly ? 0 : (Number(employee.salaryStructure?.conveyance) || 0),
        medicalAllowance: isHourly ? 0 : (Number(employee.salaryStructure?.medicalAllowance) || 0),
        otherAllowances: isHourly ? [] : (employee.salaryStructure?.otherAllowances || []),
      },
    });
  }

  const getVal = (field) => (updateData[field] !== undefined ? updateData[field] : employee[field]);
  const getNum = (field) => (updateData[field] !== undefined ? Number(updateData[field]) : (Number(employee[field]) || 0));

  const revisionEntry = {
    effectiveDate: effectiveDate ? new Date(effectiveDate) : new Date(),
    previousCTC: isHourly ? 0 : oldCTC,
    newCTC: isHourly ? 0 : newCTC,
    previousHourlyRate: isHourly ? oldHourly : undefined,
    newHourlyRate: isHourly ? newHourly : undefined,
    hourlyRate: isHourly ? newHourly : undefined,
    reason: reason || 'Compensation adjustment',
    revisedBy: revisedBy || 'System',
    createdAt: new Date(),
    role: getVal('role') || null,
    useSalaryComponents: isHourly ? false : getVal('useSalaryComponents') !== false,
    employmentType: getVal('employmentType') || 'full-time',
    compensationModel: getVal('compensationModel') || 'SALARIED',
    paymentBasis: getVal('paymentBasis') || 'MONTHLY',
    rateCard: updateData.rateCard !== undefined ? updateData.rateCard : employee.rateCard,

    monthlyCTC: isHourly ? 0 : newCTC,
    pfEnabled: isHourly ? false : getVal('pfEnabled') !== false,
    esiEnabled: isHourly ? false : getVal('esiEnabled') !== false,
    ptEnabled: isHourly ? false : getVal('ptEnabled') !== false,
    lwfEnabled: isHourly ? false : getVal('lwfEnabled') !== false,
    gratuityEnabled: isHourly ? false : getVal('gratuityEnabled') !== false,
    includePfInCTC: isHourly ? false : getVal('includePfInCTC') === true,
    includeGratuityInCTC: isHourly ? false : getVal('includeGratuityInCTC') !== false,
    basicPercent: isHourly ? null : (getVal('basicPercent') ?? null),
    hraPercent: isHourly ? null : (getVal('hraPercent') ?? null),
    joiningBonus: isHourly ? 0 : getNum('joiningBonus'),
    flexiAmount: isHourly ? 0 : getNum('flexiAmount'),
    broadband: isHourly ? 0 : getNum('broadband'),
    petrol: isHourly ? 0 : getNum('petrol'),
    lta: isHourly ? 0 : getNum('lta'),
    employerNPS: isHourly ? 0 : getNum('employerNPS'),
    insuranceAmount: isHourly ? 0 : getNum('insuranceAmount'),
    deductions: {
      tds: updateData.deductions?.tds !== undefined ? Number(updateData.deductions.tds) : (employee.deductions?.tds || 0),
      professionalTax: isHourly ? 0 : (updateData.deductions?.professionalTax !== undefined ? Number(updateData.deductions.professionalTax) : (employee.deductions?.professionalTax || 0)),
      otherDeductions: isHourly ? [] : (updateData.deductions?.otherDeductions !== undefined ? updateData.deductions.otherDeductions : (employee.deductions?.otherDeductions || [])),
    },
    salaryStructure: {
      conveyance: isHourly ? 0 : (updateData.salaryStructure?.conveyance !== undefined ? Number(updateData.salaryStructure.conveyance) : (Number(employee.salaryStructure?.conveyance) || 0)),
      medicalAllowance: isHourly ? 0 : (updateData.salaryStructure?.medicalAllowance !== undefined ? Number(updateData.salaryStructure.medicalAllowance) : (Number(employee.salaryStructure?.medicalAllowance) || 0)),
      otherAllowances: isHourly ? [] : (updateData.salaryStructure?.otherAllowances !== undefined ? updateData.salaryStructure.otherAllowances : (employee.salaryStructure?.otherAllowances || [])),
    },
  };

  employee.salaryRevisions.push(revisionEntry);
  return revisionEntry;
}

module.exports = {
  appendSalaryRevisionIfChanged,
};
