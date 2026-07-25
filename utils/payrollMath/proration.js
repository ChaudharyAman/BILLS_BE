/**
 * utils/payrollMath/proration.js
 *
 * LOP allocation and day-by-day proration calculations across salary revision segments.
 */

const { roundAmount } = require('../money');

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const getSegmentLops = (totalLop, workingDays, totalDays, strategy = 'proportional', segments = [], customLops = []) => {
  const segmentLops = new Array(segments.length).fill(0);
  if (totalLop <= 0 || segments.length === 0) return segmentLops;

  if (strategy === 'custom') {
    let sum = 0;
    for (let i = 0; i < segments.length; i++) {
      segmentLops[i] = Number(customLops[i]) || 0;
      sum += segmentLops[i];
    }
    for (let i = 0; i < segments.length; i++) {
      const segWorkingDays = (segments[i].daysCount / totalDays) * workingDays;
      segmentLops[i] = Math.max(0, Math.min(segWorkingDays, segmentLops[i]));
    }
  } else if (strategy === 'older_first') {
    let remainingLop = totalLop;
    for (let i = 0; i < segments.length; i++) {
      const segWorkingDays = (segments[i].daysCount / totalDays) * workingDays;
      const segLop = Math.min(remainingLop, segWorkingDays);
      segmentLops[i] = roundAmount(segLop);
      remainingLop -= segLop;
    }
  } else if (strategy === 'newer_first') {
    let remainingLop = totalLop;
    for (let i = segments.length - 1; i >= 0; i--) {
      const segWorkingDays = (segments[i].daysCount / totalDays) * workingDays;
      const segLop = Math.min(remainingLop, segWorkingDays);
      segmentLops[i] = roundAmount(segLop);
      remainingLop -= segLop;
    }
  } else {
    // proportional
    for (let i = 0; i < segments.length; i++) {
      const segRatio = segments[i].daysCount / totalDays;
      segmentLops[i] = roundAmount(segRatio * totalLop);
    }
  }
  return segmentLops;
};

const getDayProrateArray = (totalDays, workingDays, paidDays, strategy = 'proportional', segmentLops = [], segments = []) => {
  const dayProrate = new Array(totalDays).fill(1);
  if (workingDays <= 0) return dayProrate;
  const ratio = Math.min(paidDays / workingDays, 1);
  if (ratio >= 1) return dayProrate;

  if (segments.length === 0) {
    dayProrate.fill(ratio);
    return dayProrate;
  }

  const computedLops = getSegmentLops(workingDays - paidDays, workingDays, totalDays, strategy, segments, segmentLops);

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segLop = computedLops[i] || 0;
    const segRatio = seg.daysCount / totalDays;
    const segWorkingDays = segRatio * workingDays;
    const segProrate = segWorkingDays > 0 ? Math.max(0, Math.min(1, (segWorkingDays - segLop) / segWorkingDays)) : 1;
    for (let d = seg.startDay; d <= seg.endDay; d++) {
      dayProrate[d - 1] = segProrate;
    }
  }
  return dayProrate;
};

const getYYYYMMDD = (dateVal) => {
  const dateObj = new Date(dateVal);
  if (isNaN(dateObj.getTime())) return '';
  const y = dateObj.getUTCFullYear();
  const m = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const getEmployeeParamsForDate = (employee, dateStr) => {
  const revisions = [...(employee.salaryRevisions || [])].sort((a, b) => new Date(a.effectiveDate) - new Date(b.effectiveDate));
  if (revisions.length === 0) {
    return employee;
  }
  const latestRevision = revisions[revisions.length - 1];
  const latestRevDateStr = getYYYYMMDD(latestRevision.effectiveDate);
  if (dateStr >= latestRevDateStr) {
    return employee;
  }
  let activeRevision = null;
  for (let i = revisions.length - 1; i >= 0; i--) {
    const revDateStr = getYYYYMMDD(revisions[i].effectiveDate);
    if (revDateStr && revDateStr <= dateStr) {
      activeRevision = revisions[i];
      break;
    }
  }
  if (!activeRevision) {
    activeRevision = revisions[0];
  }

  const getVal = (field, def) => {
    if (activeRevision && activeRevision[field] !== undefined && activeRevision[field] !== null) {
      return activeRevision[field];
    }
    if (employee[field] !== undefined && employee[field] !== null) {
      return employee[field];
    }
    return def;
  };

  const getDeductionVal = (field, def) => {
    if (activeRevision && activeRevision.deductions && activeRevision.deductions[field] !== undefined && activeRevision.deductions[field] !== null) {
      return activeRevision.deductions[field];
    }
    if (employee.deductions && employee.deductions[field] !== undefined && employee.deductions[field] !== null) {
      return employee.deductions[field];
    }
    return def;
  };

  const getStructureVal = (field, def) => {
    if (activeRevision && activeRevision.salaryStructure && activeRevision.salaryStructure[field] !== undefined && activeRevision.salaryStructure[field] !== null) {
      return activeRevision.salaryStructure[field];
    }
    if (employee.salaryStructure && employee.salaryStructure[field] !== undefined && employee.salaryStructure[field] !== null) {
      return employee.salaryStructure[field];
    }
    return def;
  };

  let monthlyCTC = Number(activeRevision.newCTC) || Number(activeRevision.monthlyCTC) || 0;
  if (!monthlyCTC && activeRevision === revisions[0]) {
    monthlyCTC = Number(revisions[0].previousCTC) || Number(employee.monthlyCTC) || 0;
  }

  return {
    monthlyCTC,
    compensationType: getVal('compensationType', null),
    employmentType: getVal('employmentType', 'full-time'),
    compensationModel: getVal('compensationModel', 'SALARIED'),
    paymentBasis: getVal('paymentBasis', 'MONTHLY'),
    payType: getVal('payType', 'salaried'),
    hourlyRate: getVal('hourlyRate', 0),
    pfEnabled: getVal('pfEnabled', true),
    esiEnabled: getVal('esiEnabled', true),
    ptEnabled: getVal('ptEnabled', true),
    ptState: getVal('ptState', ''),
    lwfEnabled: getVal('lwfEnabled', true),
    tdsEnabled: getVal('tdsEnabled', true),
    gratuityEnabled: getVal('gratuityEnabled', true),
    includePfInCTC: getVal('includePfInCTC', false),
    includeGratuityInCTC: getVal('includeGratuityInCTC', true),
    basicPercent: getVal('basicPercent', null),
    hraPercent: getVal('hraPercent', null),
    useSalaryComponents: getVal('useSalaryComponents', true),
    joiningBonus: getVal('joiningBonus', 0),
    flexiAmount: getVal('flexiAmount', 0),
    broadband: getVal('broadband', 0),
    petrol: getVal('petrol', 0),
    lta: getVal('lta', 0),
    employerNPS: getVal('employerNPS', 0),
    insuranceAmount: getVal('insuranceAmount', 0),
    deductions: {
      tds: getDeductionVal('tds', 0),
      professionalTax: getDeductionVal('professionalTax', 0),
      otherDeductions: getDeductionVal('otherDeductions', []),
    },
    salaryStructure: {
      conveyance: getStructureVal('conveyance', 0),
      medicalAllowance: getStructureVal('medicalAllowance', 0),
      otherAllowances: getStructureVal('otherAllowances', []),
    },
  };
};

module.exports = {
  clamp,
  getSegmentLops,
  getDayProrateArray,
  getYYYYMMDD,
  getEmployeeParamsForDate,
};
