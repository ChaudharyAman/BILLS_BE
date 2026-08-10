/**
 * utils/payrollMath/snapshot.js
 *
 * Payroll snapshot orchestrator computing earnings, proration, statutory deductions, variable pay, and net salary.
 */

const { checkMinimumWageCompliance } = require('../minimumWageSlabs');
const { resolveCompensationType } = require('../payrollStrategies/index');
const { clamp, getSegmentLops, getDayProrateArray, getEmployeeParamsForDate } = require('./proration');
const { normalizeConfig, buildMasterSalaryStructure } = require('./salaryStructure');
const { roundAmount, sumNamedAmounts } = require('../money');

const applyOvertimePolicy = (overtimeInput, hourlyRateInput, basicMaster = 0, configInput = {}) => {
  const config = normalizeConfig(configInput);
  const otConfig = config.overtimePolicy || {};

  const standardMonthlyHours = Number(config.standardMonthlyHours) || 160;
  const derivedHourlyRate = Number(hourlyRateInput) > 0 
    ? Number(hourlyRateInput) 
    : (basicMaster > 0 ? (basicMaster / standardMonthlyHours) : 0);

  let totalOtHours = 0;
  let otAmount = 0;
  let isCapped = false;
  let maxOtHours = Number(otConfig.maxOvertimeHoursPerMonth) || 50;

  let weekdayHours = 0;
  let weekendHours = 0;
  let holidayHours = 0;
  let customAmount = 0;

  const weekdayMult = Number(otConfig.weekdayMultiplier) || 1.5;
  const weekendMult = Number(otConfig.weekendMultiplier) || 2.0;
  const holidayMult = Number(otConfig.holidayMultiplier) || 2.0;

  if (overtimeInput && typeof overtimeInput === 'object') {
    weekdayHours = Number(overtimeInput.weekdayHours) || 0;
    weekendHours = Number(overtimeInput.weekendHours) || 0;
    holidayHours = Number(overtimeInput.holidayHours) || 0;
    customAmount = Number(overtimeInput.customAmount) || 0;

    totalOtHours = weekdayHours + weekendHours + holidayHours;

    const weekdayOtPay = weekdayHours * derivedHourlyRate * weekdayMult;
    const weekendOtPay = weekendHours * derivedHourlyRate * weekendMult;
    const holidayOtPay = holidayHours * derivedHourlyRate * holidayMult;

    otAmount = roundAmount(weekdayOtPay + weekendOtPay + holidayOtPay + customAmount);
  } else if (typeof overtimeInput === 'number' || (!isNaN(Number(overtimeInput)) && overtimeInput !== '')) {
    const rawVal = Number(overtimeInput) || 0;
    if (rawVal > 0 && rawVal <= 120) {
      weekdayHours = rawVal;
      totalOtHours = rawVal;
      otAmount = roundAmount(totalOtHours * derivedHourlyRate * weekdayMult);
    } else {
      customAmount = rawVal;
      otAmount = roundAmount(rawVal);
    }
  }

  if (totalOtHours > maxOtHours) {
    isCapped = true;
  }

  const breakdown = {
    hourlyRate: derivedHourlyRate,
    weekday: { hours: weekdayHours, multiplier: weekdayMult, rate: derivedHourlyRate, amount: roundAmount(weekdayHours * derivedHourlyRate * weekdayMult) },
    weekend: { hours: weekendHours, multiplier: weekendMult, rate: derivedHourlyRate, amount: roundAmount(weekendHours * derivedHourlyRate * weekendMult) },
    holiday: { hours: holidayHours, multiplier: holidayMult, rate: derivedHourlyRate, amount: roundAmount(holidayHours * derivedHourlyRate * holidayMult) },
    customAmount: roundAmount(customAmount),
  };

  return {
    overtimeAmount: otAmount,
    totalOvertimeHours: totalOtHours,
    maxOvertimeHours: maxOtHours,
    overtimeCapWarning: isCapped ? {
      flagged: true,
      totalHours: totalOtHours,
      maxCap: maxOtHours,
      exceededBy: roundAmount(totalOtHours - maxOtHours),
      warningMessage: `[Overtime Cap Warning] Total OT hours (${totalOtHours} hrs) exceeds statutory max cap (${maxOtHours} hrs/month)`,
    } : null,
    breakdown,
  };
};

const buildPayrollSnapshot = (employeeInput, configInput, attendance, adjustments = {}, monthNum, yearNum) => {
  const employee = (employeeInput && typeof employeeInput.toObject === 'function')
    ? employeeInput.toObject()
    : employeeInput;
  const config = normalizeConfig(configInput);
  
  const year = Number(yearNum) || Number(attendance?.year) || Number(adjustments?.year) || new Date().getFullYear();
  const month = Number(monthNum) || Number(attendance?.month) || Number(adjustments?.month) || (new Date().getMonth() + 1);

  const totalDaysInMonth = new Date(year, month, 0).getDate();
  const dailyStructures = [];
  const dailyOtherAllowances = [];
  const dailyOtherDeductions = [];

  const effectiveCompType = adjustments.compensationType || resolveCompensationType(employee);
  const isHourly = effectiveCompType === 'hourly' || employee.payType === 'hourly';
  const hoursWorked = isHourly ? (Number(attendance?.hoursWorked) || Number(adjustments?.hoursWorked) || Number(employee.hoursWorked) || 0) : 0;

  const periodInput = {
    daysWorked:      Number(adjustments.daysWorked ?? adjustments.periodInput?.daysWorked ?? attendance?.paidDays ?? 0),
    unitsProduced:   adjustments.unitsProduced !== undefined ? Number(adjustments.unitsProduced) : (adjustments.periodInput?.unitsProduced !== undefined ? Number(adjustments.periodInput.unitsProduced) : undefined),
    hoursLogged:     Number(adjustments.hoursLogged ?? adjustments.periodInput?.hoursLogged ?? adjustments.timesheetHours ?? 0),
    hoursWorked:     Number(attendance?.hoursWorked ?? adjustments.hoursWorked ?? adjustments.periodInput?.hoursWorked ?? employee.hoursWorked ?? 0),
    projectFee:      adjustments.projectFee !== undefined ? Number(adjustments.projectFee) : (adjustments.periodInput?.projectFee !== undefined ? Number(adjustments.periodInput.projectFee) : undefined),
    milestoneAmount: adjustments.milestoneAmount !== undefined ? Number(adjustments.milestoneAmount) : (adjustments.periodInput?.milestoneAmount !== undefined ? Number(adjustments.periodInput.milestoneAmount) : undefined),
    ratePerUnit:     adjustments.ratePerUnit !== undefined ? Number(adjustments.ratePerUnit) : (adjustments.periodInput?.ratePerUnit !== undefined ? Number(adjustments.periodInput.ratePerUnit) : undefined),
    variableTransactions: Array.isArray(adjustments.variableTransactions) ? adjustments.variableTransactions : (Array.isArray(adjustments.periodInput?.variableTransactions) ? adjustments.periodInput.variableTransactions : []),
  };

  for (let d = 1; d <= totalDaysInMonth; d++) {
    const currentStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const activeParams = getEmployeeParamsForDate(employee, currentStr);
    
    const daySource = {
      ...activeParams,
      _periodInput: periodInput,
      hoursWorked: isHourly ? hoursWorked : undefined,
      pfEnabled: adjustments.pfEnabled !== undefined ? adjustments.pfEnabled : activeParams.pfEnabled,
      esiEnabled: adjustments.esiEnabled !== undefined ? adjustments.esiEnabled : activeParams.esiEnabled,
      ptEnabled: adjustments.ptEnabled !== undefined ? adjustments.ptEnabled : activeParams.ptEnabled,
      ptState: adjustments.ptState !== undefined ? adjustments.ptState : activeParams.ptState,
      lwfEnabled: adjustments.lwfEnabled !== undefined ? adjustments.lwfEnabled : activeParams.lwfEnabled,
      tdsEnabled: adjustments.tdsEnabled !== undefined ? adjustments.tdsEnabled : activeParams.tdsEnabled,
      gratuityEnabled: adjustments.gratuityEnabled !== undefined ? adjustments.gratuityEnabled : activeParams.gratuityEnabled,
      includePfInCTC: adjustments.includePfInCTC !== undefined ? adjustments.includePfInCTC : activeParams.includePfInCTC,
      includeGratuityInCTC: adjustments.includeGratuityInCTC !== undefined ? adjustments.includeGratuityInCTC : activeParams.includeGratuityInCTC,
      basicPercent: adjustments.basicPercent !== undefined && adjustments.basicPercent !== null ? adjustments.basicPercent : activeParams.basicPercent,
      hraPercent: adjustments.hraPercent !== undefined && adjustments.hraPercent !== null ? adjustments.hraPercent : activeParams.hraPercent,
      _month: month,
      _year: year,
    };

    Object.keys(activeParams).forEach(key => {
      if (key.endsWith('Percent')) {
        daySource[key] = activeParams[key];
      }
    });
    Object.keys(adjustments).forEach(key => {
      if (key.endsWith('Percent') && adjustments[key] !== undefined && adjustments[key] !== null) {
        daySource[key] = adjustments[key];
      }
    });

    const dayMaster = buildMasterSalaryStructure(daySource, config);
    dailyStructures.push(dayMaster);
    dailyOtherAllowances.push(daySource.salaryStructure?.otherAllowances || []);
    dailyOtherDeductions.push(daySource.deductions?.otherDeductions || []);
  }

  const master = {};
  const sample = dailyStructures[0] || {};
  for (const [key, val] of Object.entries(sample)) {
    if (typeof val === 'number') {
      let sum = 0;
      for (const ds of dailyStructures) {
        sum += ds[key] || 0;
      }
      master[key] = roundAmount(sum / totalDaysInMonth);
    } else if (typeof val === 'boolean') {
      master[key] = dailyStructures[dailyStructures.length - 1][key];
    } else {
      master[key] = val;
    }
  }

  const averagedEarningsMap = {};
  for (const ds of dailyStructures) {
    if (ds.earningsMap) {
      for (const [key, val] of Object.entries(ds.earningsMap)) {
        averagedEarningsMap[key] = (averagedEarningsMap[key] || 0) + val;
      }
    }
  }
  for (const key of Object.keys(averagedEarningsMap)) {
    averagedEarningsMap[key] = roundAmount(averagedEarningsMap[key] / totalDaysInMonth);
  }
  master.earningsMap = averagedEarningsMap;

  const allowanceMap = {};
  for (let i = 0; i < totalDaysInMonth; i++) {
    const list = dailyOtherAllowances[i] || [];
    for (const item of list) {
      if (item.name) {
        allowanceMap[item.name] = (allowanceMap[item.name] || 0) + (Number(item.amount) || 0) / totalDaysInMonth;
      }
    }
  }
  const averagedOtherAllowances = Object.entries(allowanceMap).map(([name, amount]) => ({
    name,
    amount: roundAmount(amount)
  }));

  const deductionMap = {};
  for (let i = 0; i < totalDaysInMonth; i++) {
    const list = dailyOtherDeductions[i] || [];
    for (const item of list) {
      if (item.name) {
        deductionMap[item.name] = (deductionMap[item.name] || 0) + (Number(item.amount) || 0) / totalDaysInMonth;
      }
    }
  }
  const averagedOtherDeductions = Object.entries(deductionMap).map(([name, amount]) => ({
    name,
    amount: roundAmount(amount)
  }));

  const requestedWorkingDays = Number(attendance?.workingDays);
  const workingDays = Math.max(requestedWorkingDays || config.defaultWorkingDays, 1);
  const rawPaidDays = isHourly
    ? workingDays
    : (attendance?.paidDays !== undefined && attendance?.paidDays !== null
        ? Number(attendance.paidDays)
        : (attendance?.presentDays !== undefined && attendance?.presentDays !== null
            ? Number(attendance.presentDays)
            : workingDays));
  const paidDays = isHourly
    ? workingDays
    : roundAmount(clamp(
        rawPaidDays !== null && rawPaidDays !== undefined ? rawPaidDays : workingDays,
        0,
        workingDays
      ));
  const prorate = isHourly ? 1.0 : Math.min(paidDays / workingDays, 1);
  const lop = isHourly ? 0 : roundAmount(Math.max(workingDays - paidDays, 0));

  const segments = [];
  let currentSegment = null;

  for (let d = 1; d <= totalDaysInMonth; d++) {
    const currentStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const activeParams = getEmployeeParamsForDate(employee, currentStr);
    const key = `${activeParams.compensationType || ''}-${activeParams.monthlyCTC}-${activeParams.pfEnabled}-${activeParams.esiEnabled}-${activeParams.tdsEnabled}-${activeParams.gratuityEnabled}`;

    if (!currentSegment || currentSegment.key !== key) {
      if (currentSegment) {
        segments.push(currentSegment);
      }
      currentSegment = {
        key,
        startDay: d,
        endDay: d,
        activeParams,
        daysCount: 1
      };
    } else {
      currentSegment.endDay = d;
      currentSegment.daysCount += 1;
    }
  }
  if (currentSegment) {
    segments.push(currentSegment);
  }

  const lopStrategy = adjustments.lopStrategy || 'proportional';
  const customSegmentLops = adjustments.segmentLops || [];
  const segmentLops = isHourly
    ? new Array(segments.length).fill(0)
    : getSegmentLops(workingDays - paidDays, workingDays, totalDaysInMonth, lopStrategy, segments, customSegmentLops);
  const dayProrate = isHourly
    ? new Array(totalDaysInMonth).fill(1.0)
    : getDayProrateArray(totalDaysInMonth, workingDays, paidDays, lopStrategy, customSegmentLops, segments);

  let otherEarnings = [];
  if (Array.isArray(adjustments.otherEarnings) && adjustments.otherEarnings.length > 0) {
    otherEarnings = adjustments.otherEarnings.map(item => ({
      name: item.name,
      amount: roundAmount(item.amount)
    }));
  } else {
    const otherEarningsMap = {};
    for (let d = 0; d < totalDaysInMonth; d++) {
      const list = dailyOtherAllowances[d] || [];
      for (const item of list) {
        if (item.name) {
          otherEarningsMap[item.name] = (otherEarningsMap[item.name] || 0) + (Number(item.amount) || 0) * dayProrate[d] / totalDaysInMonth;
        }
      }
    }
    otherEarnings = Object.entries(otherEarningsMap).map(([name, amount]) => ({
      name,
      amount: roundAmount(amount)
    }));
  }

  let otherDeductions = [];
  if (Array.isArray(adjustments.otherDeductions) && adjustments.otherDeductions.length > 0) {
    otherDeductions = adjustments.otherDeductions.map(item => ({
      name: item.name,
      amount: roundAmount(item.amount)
    }));
  } else {
    otherDeductions = averagedOtherDeductions.map(item => ({
      name: item.name,
      amount: roundAmount(Number(item.amount) || 0)
    }));
  }

  const isMatchingFrequency = (freq, mNum) => {
    if (!freq || freq === 'monthly') return true;
    const m = Number(mNum) || Number(attendance?.month) || Number(adjustments?.month) || (new Date().getMonth() + 1);
    if (freq === 'quarterly') return m % 3 === 0;
    if (freq === 'semi_annually') return m % 6 === 0;
    if (freq === 'annually') return m % 12 === 0;
    return true;
  };

  const variableTransactions = Array.isArray(adjustments.variableTransactions)
    ? adjustments.variableTransactions
    : [];

  let variableEarningsTotal = 0;
  const variableEarningsDetails = [];

  for (const tx of variableTransactions) {
    const txAmount = Number(tx.amount) || 0;
    const isConsumedByStrategy = (
      (effectiveCompType === 'commission' || effectiveCompType === 'commission_only') && (!tx.paymentType || tx.paymentType === 'COMMISSION' || tx.paymentType === 'PERCENTAGE')
    ) || (
      effectiveCompType === 'project_based' && tx.paymentType === 'PROJECT'
    ) || (
      effectiveCompType === 'milestone_based' && tx.paymentType === 'MILESTONE'
    );

    if (!isConsumedByStrategy) {
      variableEarningsTotal += txAmount;
    }
    variableEarningsDetails.push({
      paymentType: tx.paymentType,
      reference: tx.reference || '',
      client: tx.client || '',
      quantity: Number(tx.quantity) || 1,
      rate: Number(tx.rate) || 0,
      amount: txAmount,
      remarks: tx.remarks || '',
    });
  }

  const otResult = applyOvertimePolicy(adjustments.overtime, master.hourlyRate || employee.hourlyRate, master.basicMaster, config);
  const hasDynamicComponents = config.salaryComponents && config.salaryComponents.length > 0;
  let earnings = {};

  if (hasDynamicComponents) {
    earnings = {
      otherEarnings: [...otherEarnings],
      overtime: otResult.overtimeAmount,
      overtimeHours: otResult.totalOvertimeHours,
      overtimeCapWarning: otResult.overtimeCapWarning,
      overtimeBreakdown: otResult.breakdown,
    };
    config.salaryComponents.forEach(c => {
      if (c.type === 'earning') {
        let sumEarningVal = 0;
        for (let d = 0; d < totalDaysInMonth; d++) {
          const ds = dailyStructures[d];
          const dailyVal = ds.earningsMap?.[c.id] ?? ds[c.id] ?? 0;
          sumEarningVal += (dailyVal / totalDaysInMonth) * dayProrate[d];
        }
        let proratedVal = roundAmount(sumEarningVal);
        const effectiveFreq = employee?.componentFrequencies?.[c.id] || master?.componentFrequencies?.[c.id] || c.frequency || 'monthly';
        if (!isMatchingFrequency(effectiveFreq, month)) {
          proratedVal = 0;
        }
        earnings[c.id] = proratedVal;
        
        if (c.id === 'basic') earnings.basic = proratedVal;
        else if (c.id === 'hra') earnings.hra = proratedVal;
        else if (c.id === 'flexi') earnings.flexiAmount = proratedVal;
        else if (c.id === 'broadband') earnings.broadband = proratedVal;
        else if (c.id === 'petrol') earnings.petrol = proratedVal;
        else if (c.id === 'lta') earnings.lta = proratedVal;
        else if (c.id === 'special') earnings.specialAllowance = proratedVal;
        else if (c.id === 'conveyance') earnings.conveyance = proratedVal;
        else if (c.id === 'medical') earnings.medicalAllowance = proratedVal;
      }
    });

    const compEarningsMap = {};
    config.salaryComponents.forEach(c => {
      if (c.type === 'earning') {
        compEarningsMap[c.id] = earnings[c.id] || 0;
      }
    });
    earnings.earningsMap = compEarningsMap;

    earnings.totalEarnings = roundAmount(
      config.salaryComponents
        .filter(c => c.type === 'earning')
        .reduce((sum, c) => {
          const standardEarningIds = ['basic', 'hra', 'flexi', 'broadband', 'petrol', 'lta', 'special', 'conveyance', 'medical'];
          if (!standardEarningIds.includes(c.id)) return sum;
          return sum + (earnings[c.id] || 0);
        }, 0) +
      earnings.overtime +
      sumNamedAmounts(earnings.otherEarnings) +
      Object.entries(compEarningsMap)
        .filter(([key]) => !['basic', 'hra', 'flexi', 'broadband', 'petrol', 'lta', 'special', 'conveyance', 'medical'].includes(key))
        .reduce((sum, [, val]) => sum + val, 0) +
      variableEarningsTotal
    );
    earnings.variableCompensation = variableEarningsDetails;

  } else {
    const sumDailyComponent = (compField) => {
      let sum = 0;
      for (let d = 0; d < totalDaysInMonth; d++) {
        sum += (dailyStructures[d][compField] / totalDaysInMonth) * dayProrate[d];
      }
      return roundAmount(sum);
    };

    earnings = {
      basic: sumDailyComponent('basicMaster'),
      hra: sumDailyComponent('hraMaster'),
      flexiAmount: sumDailyComponent('flexi'),
      broadband: sumDailyComponent('broadband'),
      petrol: sumDailyComponent('petrol'),
      lta: sumDailyComponent('lta'),
      specialAllowance: sumDailyComponent('specialAllowance'),
      overtime: otResult.overtimeAmount,
      overtimeHours: otResult.totalOvertimeHours,
      overtimeCapWarning: otResult.overtimeCapWarning,
      overtimeBreakdown: otResult.breakdown,
      conveyance: sumDailyComponent('conveyance'),
      medicalAllowance: sumDailyComponent('medicalAllowance'),
      otherEarnings,
    };
    earnings.totalEarnings = roundAmount(
      Object.values(earnings).filter((value) => typeof value === 'number').reduce((sum, value) => sum + value, 0) +
      sumNamedAmounts(earnings.otherEarnings) +
      variableEarningsTotal
    );
    earnings.variableCompensation = variableEarningsDetails;
  }

  let sumPfEmployee = 0;
  let sumPfEmployer = 0;
  let sumEsiEmployee = 0;
  let sumEsiEmployer = 0;
  let sumGratuity = 0;
  for (let d = 0; d < totalDaysInMonth; d++) {
    const ds = dailyStructures[d];
    const dP = dayProrate[d];

    sumPfEmployee += (ds.pfEmployee / totalDaysInMonth) * dP;
    sumPfEmployer += (ds.pfEmployer / totalDaysInMonth) * dP;
    sumGratuity += (ds.gratuity / totalDaysInMonth) * dP;

    let dailyGrossForEsi = 0;
    if (hasDynamicComponents) {
      config.salaryComponents.forEach(c => {
        if (c.type === 'earning') {
          const dailyVal = ds.earningsMap?.[c.id] ?? ds[c.id] ?? 0;
          dailyGrossForEsi += (dailyVal / totalDaysInMonth) * dP;
        }
      });
    } else {
      const dailyBasic = (ds.basicMaster / totalDaysInMonth) * dP;
      const dailyHra = (ds.hraMaster / totalDaysInMonth) * dP;
      const dailyFlexi = (ds.flexi / totalDaysInMonth) * dP;
      const dailyBroadband = (ds.broadband / totalDaysInMonth) * dP;
      const dailyPetrol = (ds.petrol / totalDaysInMonth) * dP;
      const dailyLta = (ds.lta / totalDaysInMonth) * dP;
      const dailySpecial = (ds.specialAllowance / totalDaysInMonth) * dP;
      const dailyConveyance = (ds.conveyance / totalDaysInMonth) * dP;
      const dailyMedical = (ds.medicalAllowance / totalDaysInMonth) * dP;

      dailyGrossForEsi = dailyBasic + dailyHra + dailyFlexi + dailyBroadband + dailyPetrol + dailyLta + dailySpecial + dailyConveyance + dailyMedical;
    }
    dailyGrossForEsi += sumNamedAmounts(otherEarnings) / totalDaysInMonth;
 
    const dailyEsiEmployee = ds.esiApplicable ? dailyGrossForEsi * config.esiEmployeeRate : 0;
    const dailyEsiEmployer = ds.esiApplicable ? dailyGrossForEsi * config.esiEmployerRate : 0;
    sumEsiEmployee += dailyEsiEmployee;
    sumEsiEmployer += dailyEsiEmployer;
  }
  const pfEmployee = roundAmount(sumPfEmployee);
  const pfEmployer = roundAmount(sumPfEmployer);
  const gratuity = roundAmount(sumGratuity);
  const esiEmployee = roundAmount(sumEsiEmployee);
  const esiEmployer = roundAmount(sumEsiEmployer);

  const employerContributions = {
    pfEmployer,
    esiEmployer,
    gratuity,
    lwfEmployer: master.lwfEmployer,
    insuranceEmployer: master.insurance,
    nps: master.employerNPS,
    grossTotalSalary: roundAmount(
      earnings.totalEarnings +
      pfEmployer +
      gratuity +
      master.lwfEmployer +
      master.insurance +
      esiEmployer +
      master.employerNPS
    ),
  };

  const variablePay = {
    joiningBonus: roundAmount(adjustments.joiningBonus),
    loyaltyBonus: roundAmount(adjustments.loyaltyBonus),
    incentive: roundAmount(adjustments.incentive),
    specialBonus: roundAmount(adjustments.specialBonus),
    otherAllowanceArrear: roundAmount(adjustments.otherAllowanceArrear),
    performanceBonus: roundAmount(adjustments.performanceBonus),
    retentionBonus: roundAmount(adjustments.retentionBonus),
    arrear: roundAmount(adjustments.arrear),
    referralBonus: roundAmount(adjustments.referralBonus),
  };
  variablePay.totalVariablePay = roundAmount(Object.values(variablePay).reduce((sum, value) => sum + value, 0));

  const totalPayable = roundAmount(employerContributions.grossTotalSalary + variablePay.totalVariablePay);

  const averagedDeductionsMap = {};
  if (hasDynamicComponents) {
    config.salaryComponents.forEach(c => {
      if (c.type === 'deduction') {
        let sumDeductionVal = 0;
        for (let d = 0; d < totalDaysInMonth; d++) {
          const ds = dailyStructures[d];
          const dailyVal = ds.deductionsMap?.[c.id] ?? ds[c.id] ?? 0;
          sumDeductionVal += (dailyVal / totalDaysInMonth);
        }
        averagedDeductionsMap[c.id] = roundAmount(sumDeductionVal);
      }
    });
  }

  const isTdsEnabled = adjustments.tdsEnabled !== undefined 
    ? adjustments.tdsEnabled 
    : (employee.tdsEnabled !== false);

  const deductions = {
    pfEmployee,
    esiEmployee,
    professionalTax: master.ptEnabled ? roundAmount(employee.deductions?.professionalTax) : 0,
    tds: !isTdsEnabled ? 0 : roundAmount(
      adjustments.tds !== undefined && adjustments.tds !== null
        ? adjustments.tds
        : (Number(employee.deductions?.tds) > 0
            ? employee.deductions.tds
            : (((effectiveCompType && ['retainer', 'project_based', 'milestone_based', 'commission_only'].includes(effectiveCompType)) || (employee.compensationModel && employee.compensationModel !== 'SALARIED'))
                ? roundAmount(earnings.totalEarnings * (config.tds194JRate ?? 0.10))
                : master.tds))
    ),
    insuranceEmployee: roundAmount(adjustments.insuranceEmployee),
    lwfEmployee: master.lwfEmployee,
    gratuityDeduction: roundAmount(adjustments.gratuityDeduction),
    loanDeduction: roundAmount(adjustments.loanDeduction),
    advanceDeduction: roundAmount(adjustments.advanceDeduction),
    otherDeductions,
    deductionsMap: averagedDeductionsMap,
  };

  const dynamicDeductionsSum = roundAmount(Object.values(averagedDeductionsMap).reduce((sum, v) => sum + v, 0));

  deductions.totalDeductions = roundAmount(
    Object.entries(deductions)
      .filter(([key, value]) => key !== 'otherDeductions' && key !== 'deductionsMap' && typeof value === 'number')
      .reduce((sum, [, value]) => sum + value, 0) +
    sumNamedAmounts(deductions.otherDeductions) +
    dynamicDeductionsSum
  );

  const reimbursements = Array.isArray(adjustments.reimbursements) ? adjustments.reimbursements : [];
  const totalReimbursementApproved = roundAmount(reimbursements.reduce((sum, r) => sum + (Number(r.approved) || 0), 0));

  const totalAvailableForDeductions = roundAmount(earnings.totalEarnings + variablePay.totalVariablePay + totalReimbursementApproved);
  let netSalary = roundAmount(totalAvailableForDeductions - deductions.totalDeductions);
  let payrollShortfall = null;

  if (netSalary < 0) {
    const rawShortfall = Math.abs(netSalary);
    const nonStatutorySum = roundAmount(
      deductions.loanDeduction +
      deductions.advanceDeduction +
      deductions.insuranceEmployee +
      deductions.gratuityDeduction +
      sumNamedAmounts(deductions.otherDeductions) +
      dynamicDeductionsSum
    );

    let loanShortfall = 0;
    let advanceShortfall = 0;

    if (nonStatutorySum > 0) {
      // Proportionally reduce non-statutory deductions to prevent negative net salary.
      const ratio = Math.min(1, rawShortfall / nonStatutorySum);
      if (deductions.loanDeduction > 0) {
        loanShortfall = roundAmount(deductions.loanDeduction * ratio);
        deductions.loanDeduction = roundAmount(deductions.loanDeduction - loanShortfall);
      }
      if (deductions.advanceDeduction > 0) {
        advanceShortfall = roundAmount(deductions.advanceDeduction * ratio);
        deductions.advanceDeduction = roundAmount(deductions.advanceDeduction - advanceShortfall);
      }

      deductions.totalDeductions = roundAmount(
        Object.entries(deductions)
          .filter(([key, value]) => key !== 'otherDeductions' && key !== 'deductionsMap' && typeof value === 'number')
          .reduce((sum, [, value]) => sum + value, 0) +
        sumNamedAmounts(deductions.otherDeductions) +
        dynamicDeductionsSum
      );
    } else {
      // Shortfall is purely statutory (PF/ESI/PT/TDS). There are no non-statutory
      // deductions to reduce. Cap totalDeductions to what is actually available so
      // that the accounting identity always holds:
      //   earnings.totalEarnings + variablePay.totalVariablePay + totalReimbursementApproved
      //     - deductions.totalDeductions === netSalary
      // This is the minimum correct change: do NOT touch individual statutory lines
      // (which would require a documented statutory-reduction order policy) — instead
      // surface the cap via payrollShortfall.statutoryOnly so payroll managers can
      // apply the correct manual correction.
      deductions.totalDeductions = totalAvailableForDeductions;
    }

    netSalary = roundAmount(totalAvailableForDeductions - deductions.totalDeductions);
    payrollShortfall = {
      shortfallAmount: rawShortfall,
      loanShortfall,
      advanceShortfall,
      // True when the shortfall cannot be resolved by reducing discretionary deductions.
      // Payroll managers must review and adjust statutory deductions manually.
      statutoryOnly: nonStatutorySum === 0,
      notes: nonStatutorySum > 0
        ? 'Non-statutory deductions adjusted to prevent negative net salary'
        : 'Statutory deductions exceed gross earnings; totalDeductions capped to available earnings. Requires manual payroll manager review.',
    };
  }

  const minimumWageCompliance = checkMinimumWageCompliance({
    compensationType: effectiveCompType,
    gross: earnings.totalEarnings,
    paidDays,
    hoursWorked,
    state: employee.ptState || adjustments.ptState || 'DEFAULT',
  });

  return {
    earnings,
    employerContributions,
    variablePay,
    totalPayable,
    deductions,
    reimbursements,
    totalReimbursementApproved,
    netSalary,
    netPayClamped: Boolean(payrollShortfall && payrollShortfall.shortfallAmount > 0),
    belowMinimumWage: Boolean(minimumWageCompliance && minimumWageCompliance.flagged),
    payrollShortfall,
    minimumWageCompliance,
    lop,
    paidDays,
    workingDays,
    paidLeaves: roundAmount(attendance?.paidLeaves),
    unpaidLeaves: roundAmount(attendance?.unpaidLeaves),
    prorate: roundAmount(prorate),
    master,
    lopStrategy,
    segmentLops,
  };
};

module.exports = {
  applyOvertimePolicy,
  buildPayrollSnapshot,
};
