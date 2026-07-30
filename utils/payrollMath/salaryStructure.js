/**
 * utils/payrollMath/salaryStructure.js
 *
 * Salary component allocation, configuration normalization, master salary structure, and mid-month revision split calculations.
 */

const { resolveCompensationType, resolveStrategy, getStrategyStatutoryDefaults } = require('../payrollStrategies/index');
const { computeStatutoryAndTax } = require('./statutory');
const { getDayProrateArray, getEmployeeParamsForDate } = require('./proration');
const { roundAmount } = require('../money');

const DEFAULT_PAYROLL_CONFIG = {
  basicPercent: 0.5,
  hraPercent: 0.5,
  pfRate: 0.12,
  pfCap: 15000,
  pfEmployerRate: 0.12,
  pfCalculationType: 'percent',
  pfAmountEmployee: 1800,
  pfAmountEmployer: 1800,
  esiEmployeeRate: 0.0075,
  esiEmployerRate: 0.0325,
  esiBasicThreshold: 21000,
  lwfEmployer: 35,
  lwfEmployee: 15,
  gratuityRate: 0.0481,
  defaultWorkingDays: 30,
  defaultInsurance: 0,
  ltaMaxPercent: 0.0833,
  standardMonthlyHours: 160,
  tds194JRate: 0.10,
  compensationTypeDefaults: {},
};

const normalizeConfig = (config = {}) => {
  const getNum = (val, def) => {
    const n = Number(val);
    return Number.isFinite(n) ? n : def;
  };
  const cfg = config || {};
  return {
    basicPercent: getNum(cfg.basicPercent, DEFAULT_PAYROLL_CONFIG.basicPercent),
    hraPercent: getNum(cfg.hraPercent, DEFAULT_PAYROLL_CONFIG.hraPercent),
    pfRate: getNum(cfg.pfRate, DEFAULT_PAYROLL_CONFIG.pfRate),
    pfCap: getNum(cfg.pfCap, DEFAULT_PAYROLL_CONFIG.pfCap),
    pfEmployerRate: getNum(cfg.pfEmployerRate, DEFAULT_PAYROLL_CONFIG.pfEmployerRate),
    pfCalculationType: cfg.pfCalculationType || DEFAULT_PAYROLL_CONFIG.pfCalculationType,
    pfAmountEmployee: getNum(cfg.pfAmountEmployee, DEFAULT_PAYROLL_CONFIG.pfAmountEmployee),
    pfAmountEmployer: getNum(cfg.pfAmountEmployer, DEFAULT_PAYROLL_CONFIG.pfAmountEmployer),
    esiEmployeeRate: getNum(cfg.esiEmployeeRate, DEFAULT_PAYROLL_CONFIG.esiEmployeeRate),
    esiEmployerRate: getNum(cfg.esiEmployerRate, DEFAULT_PAYROLL_CONFIG.esiEmployerRate),
    esiBasicThreshold: getNum(cfg.esiBasicThreshold, DEFAULT_PAYROLL_CONFIG.esiBasicThreshold),
    lwfEmployer: getNum(cfg.lwfEmployer, DEFAULT_PAYROLL_CONFIG.lwfEmployer),
    lwfEmployee: getNum(cfg.lwfEmployee, DEFAULT_PAYROLL_CONFIG.lwfEmployee),
    gratuityRate: getNum(cfg.gratuityRate, DEFAULT_PAYROLL_CONFIG.gratuityRate),
    defaultWorkingDays: getNum(cfg.defaultWorkingDays, DEFAULT_PAYROLL_CONFIG.defaultWorkingDays),
    defaultInsurance: getNum(cfg.defaultInsurance, DEFAULT_PAYROLL_CONFIG.defaultInsurance),
    ltaMaxPercent: getNum(cfg.ltaMaxPercent, DEFAULT_PAYROLL_CONFIG.ltaMaxPercent),
    standardMonthlyHours: getNum(cfg.standardMonthlyHours, DEFAULT_PAYROLL_CONFIG.standardMonthlyHours),
    tds194JRate: getNum(cfg.tds194JRate, DEFAULT_PAYROLL_CONFIG.tds194JRate),
    compensationTypeDefaults: cfg.compensationTypeDefaults || DEFAULT_PAYROLL_CONFIG.compensationTypeDefaults,
    salaryComponents: cfg.salaryComponents || null,
  };
};

const getMonthlyCTCValue = (source = {}) => {
  const compType = source.compensationType;
  if (compType === 'commission_only') return 0;

  if (compType === 'retainer' && Array.isArray(source.rateCard)) {
    const retainerItem = source.rateCard.find(r => r.paymentType === 'MONTHLY');
    if (retainerItem && Number.isFinite(Number(retainerItem.rate)) && Number(retainerItem.rate) > 0) {
      return Number(retainerItem.rate);
    }
  }

  const monthlyCTC = Number(source.monthlyCTC);
  if (Number.isFinite(monthlyCTC) && monthlyCTC > 0) return monthlyCTC;

  const annualCTC = Number(source.annualCTC);
  if (Number.isFinite(annualCTC) && annualCTC > 0) return annualCTC / 12;

  const salaryCTC = Number(source.salaryStructure?.ctc);
  if (Number.isFinite(salaryCTC) && salaryCTC > 0) return salaryCTC;

  const hourlyRate = Number(source.hourlyRate);
  if (Number.isFinite(hourlyRate) && hourlyRate > 0) return hourlyRate * 160;

  const dailyRate = Number(source.dailyRate);
  if (Number.isFinite(dailyRate) && dailyRate > 0) return dailyRate * 26;

  const weeklyRate = Number(source.weeklyRate);
  if (Number.isFinite(weeklyRate) && weeklyRate > 0) return (weeklyRate * 52) / 12;

  const projectFee = Number(source.projectFee);
  if (Number.isFinite(projectFee) && projectFee > 0) return projectFee;

  const milestoneAmount = Number(source.milestoneAmount);
  if (Number.isFinite(milestoneAmount) && milestoneAmount > 0) return milestoneAmount;

  if (Array.isArray(source.rateCard) && source.rateCard.length > 0) {
    const rateCardRate = Number(source.rateCard[0]?.rate);
    if (Number.isFinite(rateCardRate) && rateCardRate > 0) return rateCardRate;
  }

  return 0;
};

const buildMasterSalaryStructure = (source = {}, configInput = {}) => {
  const config = normalizeConfig(configInput);
  
  const src = { ...source };
  if (source.salaryBreakup) {
    const breakupObj = source.salaryBreakup instanceof Map 
      ? Object.fromEntries(source.salaryBreakup) 
      : source.salaryBreakup;
    Object.assign(src, breakupObj);
  } else if (source.compensation?.salaryBreakup) {
    const breakupObj = source.compensation.salaryBreakup instanceof Map
      ? Object.fromEntries(source.compensation.salaryBreakup)
      : source.compensation.salaryBreakup;
    Object.assign(src, breakupObj);
  }

  let monthlyCTC = roundAmount(getMonthlyCTCValue(src));

  const effectiveCompType = resolveCompensationType(src);
  const strategy = resolveStrategy(effectiveCompType);

  const stratFlags = getStrategyStatutoryDefaults(effectiveCompType, config.compensationTypeDefaults || {});
  const pfEnabled          = stratFlags.pfEligible       && src.pfEnabled !== false;
  const esiEnabled         = stratFlags.esiEligible      && src.esiEnabled !== false;
  const ptEnabled          = stratFlags.ptApplicable     && src.ptEnabled !== false;
  const lwfEnabled         = stratFlags.lwfApplicable    && src.lwfEnabled !== false;
  const tdsEnabled         = src.tdsEnabled !== false;
  const gratuityEnabled    = stratFlags.gratuityEligible && src.gratuityEnabled !== false;
  const includePfInCTC     = stratFlags.pfEligible       && src.includePfInCTC === true;
  const includeGratuityInCTC = stratFlags.gratuityEligible && src.includeGratuityInCTC !== false;

  const flags = {
    pfEnabled,
    esiEnabled,
    ptEnabled,
    lwfEnabled,
    tdsEnabled,
    gratuityEnabled,
    includePfInCTC,
    includeGratuityInCTC,
  };

  const strategyResult = strategy.computeGrossEarnings(src, config, src._periodInput || {});
  if (strategyResult !== null) {
    const gross = strategyResult.gross || 0;
    const basicMaster = strategyResult.basicMaster || gross || 0;
    const hraMaster = strategyResult.hraMaster || 0;

    const stat = computeStatutoryAndTax({
      gross,
      basicMaster,
      hraMaster,
      monthlyCTC: monthlyCTC || gross,
      flags,
      config,
      src,
    });

    const otherDeductions = src.deductions?.otherDeductions || src.otherDeductions || [];
    const otherDeductionsSum = roundAmount(otherDeductions.reduce((sum, item) => sum + (Number(item.amount) || 0), 0));

    const totalDeductions = roundAmount(
      stat.pfEmployee +
      stat.esiEmployee +
      stat.professionalTax +
      stat.tds +
      stat.lwfEmployee +
      otherDeductionsSum
    );

    return {
      basicMaster,
      hraMaster,
      grossSalary: gross,
      grossTotalSalary: roundAmount(gross + stat.totalEmployerContributions),
      totalEarnings: gross,
      earningsMap: strategyResult.earningsMap || { basic: gross },
      deductionsMap: {},
      flexi: 0, broadband: 0, petrol: 0, lta: 0,
      conveyance: 0, medicalAllowance: 0, specialAllowance: 0,
      pfBase: stat.pfBase,
      pfEmployee: stat.pfEmployee,
      pfEmployer: stat.pfEmployer,
      esiApplicable: stat.esiApplicable,
      esiEmployee: stat.esiEmployee,
      esiEmployer: stat.esiEmployer,
      professionalTax: stat.professionalTax,
      gratuity: stat.gratuity,
      lwfEmployee: stat.lwfEmployee,
      lwfEmployer: stat.lwfEmployer,
      insurance: stat.insurance,
      employerNPS: stat.employerNPS,
      tds: stat.tds,
      taxRegime: stat.taxRegime,
      declarations: stat.declarations,
      taxDetails: stat.taxDetails,
      totalDeductions,
      netSalary: roundAmount(Math.max(0, gross - totalDeductions)),
      netTakeHome: roundAmount(Math.max(0, gross - totalDeductions)),
      pfEnabled,
      esiEnabled,
      ptEnabled,
      gratuityEnabled,
      lwfEnabled,
      tdsEnabled,
      includePfInCTC: false,
      includeGratuityInCTC: false,
      useComponents: false,
      monthlyCTC: monthlyCTC || gross,
      isVariablePay: effectiveCompType === 'commission_only',
      compensationBasis: effectiveCompType === 'commission_only' ? 'commission' : undefined,
    };
  }

  const isIntern = src.employmentType === 'intern';
  const isHourly = src.payType === 'hourly' || effectiveCompType === 'hourly';
  const useComponents = src.useSalaryComponents !== false && !isIntern && !isHourly;

  let basicPercent = !useComponents ? 1.0 : config.basicPercent;
  if (useComponents && src.basicPercent !== undefined && src.basicPercent !== null && Number(src.basicPercent) > 0) {
    basicPercent = Number(src.basicPercent) > 1 ? Number(src.basicPercent) / 100 : Number(src.basicPercent);
  }

  let hraPercent = !useComponents ? 0 : config.hraPercent;
  if (useComponents && src.hraPercent !== undefined && src.hraPercent !== null && Number(src.hraPercent) > 0) {
    hraPercent = Number(src.hraPercent) > 1 ? Number(src.hraPercent) / 100 : Number(src.hraPercent);
  }

  const hasDynamicComponents = config.salaryComponents && config.salaryComponents.length > 0;

  let basicMaster = roundAmount(monthlyCTC * basicPercent);
  const sourceBasic = src.basic !== undefined ? src.basic : src.salaryStructure?.basic;
  if (useComponents && sourceBasic !== undefined && sourceBasic !== null && Number(sourceBasic) > 0) {
    basicMaster = roundAmount(sourceBasic);
  }

  let hraMaster = roundAmount(basicMaster * hraPercent);
  const sourceHra = src.hra !== undefined ? src.hra : src.salaryStructure?.hra;
  if (useComponents && sourceHra !== undefined && sourceHra !== null && Number(sourceHra) > 0) {
    hraMaster = roundAmount(sourceHra);
  }

  if (hasDynamicComponents) {
    const basicComp = config.salaryComponents.find(c => c.id === 'basic');
    if (basicComp) {
      const sourceBasic = src.basic !== undefined ? src.basic : src.salaryStructure?.basic;
      if (!useComponents) {
        basicMaster = monthlyCTC;
      } else if (useComponents && basicComp.linkedTo === 'fixed' && sourceBasic !== undefined && sourceBasic !== null && Number(sourceBasic) > 0) {
        basicMaster = roundAmount(sourceBasic);
      } else {
        let bVal = basicComp.linkValue;
        if (src.basicPercent !== undefined && src.basicPercent !== null && Number(src.basicPercent) > 0) {
          bVal = Number(src.basicPercent) > 1 ? Number(src.basicPercent) / 100 : Number(src.basicPercent);
        }
        if (basicComp.linkedTo === 'ctc_percent') {
          basicMaster = roundAmount(monthlyCTC * bVal);
        } else if (basicComp.linkedTo === 'fixed') {
          const val = src['basic'] !== undefined ? src['basic'] : (src.salaryStructure?.['basic'] !== undefined ? src.salaryStructure['basic'] : 0);
          basicMaster = roundAmount(val);
        }
      }
    }
    const hraComp = config.salaryComponents.find(c => c.id === 'hra');
    if (hraComp) {
      const sourceHra = src.hra !== undefined ? src.hra : src.salaryStructure?.hra;
      if (!useComponents) {
        hraMaster = 0;
      } else if (useComponents && hraComp.linkedTo === 'fixed' && sourceHra !== undefined && sourceHra !== null && Number(sourceHra) > 0) {
        hraMaster = roundAmount(sourceHra);
      } else {
        let hVal = hraComp.linkValue;
        if (src.hraPercent !== undefined && src.hraPercent !== null && Number(src.hraPercent) > 0) {
          hVal = Number(src.hraPercent) > 1 ? Number(src.hraPercent) / 100 : Number(src.hraPercent);
        }
        if (hraComp.linkedTo === 'basic_percent') {
          hraMaster = roundAmount(basicMaster * hVal);
        } else if (hraComp.linkedTo === 'ctc_percent') {
          hraMaster = roundAmount(monthlyCTC * hVal);
        } else if (hraComp.linkedTo === 'fixed') {
          const val = src['hra'] !== undefined ? src['hra'] : (src.salaryStructure?.['hra'] !== undefined ? src.salaryStructure['hra'] : 0);
          hraMaster = roundAmount(val);
        }
      }
    }
  }

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

  const gratuity = gratuityEnabled ? roundAmount(basicMaster * config.gratuityRate) : 0;
  const lwfEmployer = (lwfEnabled && monthlyCTC > 0) ? roundAmount(config.lwfEmployer) : 0;
  const lwfEmployee = (lwfEnabled && monthlyCTC > 0) ? roundAmount(config.lwfEmployee) : 0;
  const insurance = monthlyCTC > 0 ? roundAmount(src.insuranceAmount ?? config.defaultInsurance) : 0;
  const employerNPS = roundAmount(src.employerNPS);

  const pfEmployerInCTC = (pfEnabled && includePfInCTC) ? pfEmployer : 0;
  const gratuityInCTC = (gratuityEnabled && includeGratuityInCTC) ? gratuity : 0;

  const otherAllowances = src.salaryStructure?.otherAllowances || src.otherAllowances || [];
  const otherAllowancesSum = roundAmount(otherAllowances.reduce((sum, item) => sum + (Number(item.amount) || 0), 0));

  let flexi = 0, broadband = 0, petrol = 0, lta = 0, ltaCap = 0, conveyance = 0, medicalAllowance = 0, specialAllowance = 0;

  const computeEarnings = (esiEmployerPlaceholder) => {
    const em = {};
    if (hasDynamicComponents) {
      ltaCap = roundAmount(basicMaster * config.ltaMaxPercent);
      let sumOfAllNonRemainder = 0;
      config.salaryComponents.forEach(c => {
        if (c.type === 'earning' && c.linkedTo !== 'remainder') {
          let amount = 0;
          if (c.id === 'basic') {
            amount = basicMaster;
          } else if (c.id === 'hra') {
            amount = hraMaster;
          } else if (c.linkedTo === 'ctc_percent') {
            let pct = c.linkValue;
            const overrideVal = src[c.id + 'Percent'];
            if (overrideVal !== undefined && overrideVal !== null && Number(overrideVal) > 0) {
              pct = Number(overrideVal) > 1 ? Number(overrideVal) / 100 : Number(overrideVal);
            }
            amount = roundAmount(monthlyCTC * pct);
          } else if (c.linkedTo === 'basic_percent') {
            let pct = c.linkValue;
            const overrideVal = src[c.id + 'Percent'];
            if (overrideVal !== undefined && overrideVal !== null && Number(overrideVal) > 0) {
              pct = Number(overrideVal) > 1 ? Number(overrideVal) / 100 : Number(overrideVal);
            }
            amount = roundAmount(basicMaster * pct);
          } else if (c.linkedTo === 'fixed') {
            let val = src[c.id] !== undefined ? src[c.id] : (src.salaryStructure?.[c.id] !== undefined ? src.salaryStructure[c.id] : 0);
            if (c.id === 'medical' && val === 0) {
              val = src.medicalAllowance !== undefined ? src.medicalAllowance : (src.salaryStructure?.medicalAllowance !== undefined ? src.salaryStructure.medicalAllowance : 0);
            }
            if (c.id === 'flexi' && val === 0) {
              val = src.flexiAmount !== undefined ? src.flexiAmount : (src.salaryStructure?.flexiAmount !== undefined ? src.salaryStructure.flexiAmount : 0);
            }
            amount = roundAmount(val);
          }
          if (c.id === 'lta') amount = roundAmount(Math.min(amount, ltaCap || amount));
          em[c.id] = amount;
          sumOfAllNonRemainder += amount;
        }
      });
      config.salaryComponents.forEach(c => {
        if (c.type === 'earning' && c.linkedTo === 'remainder') {
          em[c.id] = roundAmount(Math.max(
            monthlyCTC - sumOfAllNonRemainder - pfEmployerInCTC - gratuityInCTC - lwfEmployer - insurance - esiEmployerPlaceholder - employerNPS - otherAllowancesSum,
            0
          ));
        }
      });
    }
    return em;
  };

  let earningsMap = computeEarnings(0);

  if (hasDynamicComponents) {
    flexi = earningsMap['flexi'] || 0;
    broadband = earningsMap['broadband'] || 0;
    petrol = earningsMap['petrol'] || 0;
    lta = earningsMap['lta'] || 0;
    conveyance = earningsMap['conveyance'] || 0;
    medicalAllowance = earningsMap['medical'] || 0;
    specialAllowance = earningsMap['special'] || 0;
  } else {
    flexi = roundAmount(src.flexiAmount);
    broadband = roundAmount(src.broadband);
    petrol = roundAmount(src.petrol);
    const ltaRequested = roundAmount(src.lta);
    ltaCap = roundAmount(basicMaster * config.ltaMaxPercent);
    lta = roundAmount(Math.min(ltaRequested, ltaCap || ltaRequested));
    conveyance = roundAmount(src.salaryStructure?.conveyance);
    medicalAllowance = roundAmount(src.salaryStructure?.medicalAllowance);
    specialAllowance = roundAmount(Math.max(
      monthlyCTC - basicMaster - hraMaster - flexi - broadband - petrol - lta - pfEmployerInCTC - gratuityInCTC - lwfEmployer - insurance - employerNPS - conveyance - medicalAllowance - otherAllowancesSum,
      0
    ));
  }

  if (!useComponents) {
    basicMaster = monthlyCTC;
    hraMaster = 0;
    flexi = 0; broadband = 0; petrol = 0; lta = 0; conveyance = 0; medicalAllowance = 0; specialAllowance = 0;
    if (hasDynamicComponents) {
      Object.keys(earningsMap).forEach(k => { earningsMap[k] = k === 'basic' ? monthlyCTC : 0; });
    }
  }

  const pass1TotalEarnings = hasDynamicComponents
    ? roundAmount(Object.values(earningsMap).reduce((sum, v) => sum + v, 0) + otherAllowancesSum)
    : roundAmount(basicMaster + hraMaster + flexi + broadband + petrol + lta + specialAllowance + conveyance + medicalAllowance + otherAllowancesSum);

  const esiApplicable = esiEnabled && (pass1TotalEarnings <= config.esiBasicThreshold);
  const esiEmployer = roundAmount(esiApplicable ? basicMaster * config.esiEmployerRate : 0);
  const esiEmployee = roundAmount(esiApplicable ? basicMaster * config.esiEmployeeRate : 0);

  if (esiApplicable) {
    if (hasDynamicComponents) {
      earningsMap = computeEarnings(esiEmployer);
      flexi = earningsMap['flexi'] || 0;
      broadband = earningsMap['broadband'] || 0;
      petrol = earningsMap['petrol'] || 0;
      lta = earningsMap['lta'] || 0;
      conveyance = earningsMap['conveyance'] || 0;
      medicalAllowance = earningsMap['medical'] || 0;
      specialAllowance = earningsMap['special'] || 0;
      if (!useComponents) {
        basicMaster = monthlyCTC;
        hraMaster = 0;
        Object.keys(earningsMap).forEach(k => { earningsMap[k] = k === 'basic' ? monthlyCTC : 0; });
      }
    } else {
      specialAllowance = roundAmount(Math.max(
        monthlyCTC - basicMaster - hraMaster - flexi - broadband - petrol - lta - pfEmployerInCTC - gratuityInCTC - lwfEmployer - insurance - esiEmployer - employerNPS - conveyance - medicalAllowance - otherAllowancesSum,
        0
      ));
    }
  }

  const totalEarnings = hasDynamicComponents
    ? roundAmount(Object.values(earningsMap).reduce((sum, v) => sum + v, 0) + otherAllowancesSum)
    : roundAmount(basicMaster + hraMaster + flexi + broadband + petrol + lta + specialAllowance + conveyance + medicalAllowance + otherAllowancesSum);

  const grossSalary = hasDynamicComponents
    ? roundAmount(Object.entries(earningsMap).reduce((sum, [id, val]) => {
        const comp = config.salaryComponents?.find(c => c.id === id);
        if (comp) {
          if (comp.taxable || comp.id === 'hra') return sum + val;
          return sum;
        }
        if (['flexi', 'broadband', 'petrol', 'lta'].includes(id)) return sum;
        return sum + val;
      }, 0) + otherAllowancesSum)
    : roundAmount(basicMaster + hraMaster + conveyance + medicalAllowance + specialAllowance + otherAllowancesSum);

  const stat = computeStatutoryAndTax({
    gross: totalEarnings,
    basicMaster,
    hraMaster,
    monthlyCTC,
    flags,
    config,
    src,
  });

  const otherDeductions = src.deductions?.otherDeductions || src.otherDeductions || [];
  const otherDeductionsSum = roundAmount(otherDeductions.reduce((sum, item) => sum + (Number(item.amount) || 0), 0));

  const deductionsMap = {};
  if (hasDynamicComponents) {
    config.salaryComponents.forEach(c => {
      if (c.type === 'deduction') {
        let amount = 0;
        if (c.linkedTo === 'ctc_percent') {
          let pct = c.linkValue;
          const overrideVal = src[c.id + 'Percent'];
          if (overrideVal !== undefined && overrideVal !== null && Number(overrideVal) > 0) {
            pct = Number(overrideVal) > 1 ? Number(overrideVal) / 100 : Number(overrideVal);
          }
          amount = roundAmount(monthlyCTC * pct);
        } else if (c.linkedTo === 'basic_percent') {
          let pct = c.linkValue;
          const overrideVal = src[c.id + 'Percent'];
          if (overrideVal !== undefined && overrideVal !== null && Number(overrideVal) > 0) {
            pct = Number(overrideVal) > 1 ? Number(overrideVal) / 100 : Number(overrideVal);
          }
          amount = roundAmount(basicMaster * pct);
        } else if (c.linkedTo === 'fixed') {
          let val = src[c.id] !== undefined ? src[c.id] : (src.deductions?.[c.id] !== undefined ? src.deductions[c.id] : 0);
          amount = roundAmount(val);
        }
        deductionsMap[c.id] = amount;
      }
    });
  }
  const dynamicDeductionsSum = roundAmount(Object.values(deductionsMap).reduce((sum, v) => sum + v, 0));

  const totalDeductions = roundAmount(
    stat.pfEmployee +
    stat.esiEmployee +
    stat.professionalTax +
    stat.tds +
    stat.lwfEmployee +
    otherDeductionsSum +
    dynamicDeductionsSum
  );

  return {
    config,
    monthlyCTC,
    annualCTC: roundAmount(monthlyCTC * 12),
    basicMaster,
    hraMaster,
    pfBase: stat.pfBase,
    pfEmployer: stat.pfEmployer,
    pfEmployee: stat.pfEmployee,
    gratuity: stat.gratuity,
    lwfEmployer: stat.lwfEmployer,
    lwfEmployee: stat.lwfEmployee,
    insurance: stat.insurance,
    flexi,
    broadband,
    petrol,
    lta,
    ltaCap,
    employerNPS: stat.employerNPS,
    conveyance,
    medicalAllowance,
    specialAllowance,
    esiApplicable: stat.esiApplicable,
    esiEmployer: stat.esiEmployer,
    esiEmployee: stat.esiEmployee,
    grossSalary,
    totalEarnings,
    totalEmployerContributions: stat.totalEmployerContributions,
    grossTotalSalary: roundAmount(totalEarnings + stat.totalEmployerContributions),
    totalDeductions,
    netTakeHome: roundAmount(Math.max(0, totalEarnings - totalDeductions)),
    netSalary: roundAmount(Math.max(0, totalEarnings - totalDeductions)),
    diff: roundAmount(monthlyCTC - (basicMaster + hraMaster + flexi + broadband + petrol + lta + (pfEnabled && includePfInCTC ? stat.pfEmployer : 0) + (gratuityEnabled && includeGratuityInCTC ? stat.gratuity : 0) + stat.lwfEmployer + stat.insurance + stat.esiEmployer + stat.employerNPS + conveyance + medicalAllowance + specialAllowance)),
    taxRegime: stat.taxRegime,
    declarations: stat.declarations,
    taxDetails: stat.taxDetails,
    tds: stat.tds,
    professionalTax: stat.professionalTax,
    pfEnabled,
    esiEnabled,
    ptEnabled,
    lwfEnabled,
    tdsEnabled,
    gratuityEnabled,
    includePfInCTC,
    includeGratuityInCTC,
    useSalaryComponents: useComponents,
    isVariablePay: effectiveCompType === 'commission_only',
    compensationBasis: effectiveCompType === 'commission_only' ? 'commission' : undefined,
    earningsMap,
    deductionsMap,
  };
};

const getSalarySplits = (employeeInput, configInput, monthNum, yearNum, paidDaysCount, workingDaysCount, adjustments = {}) => {
  const employee = (employeeInput && typeof employeeInput.toObject === 'function')
    ? employeeInput.toObject()
    : employeeInput;
  const config = normalizeConfig(configInput);
  
  const year = Number(yearNum) || new Date().getFullYear();
  const month = Number(monthNum) || (new Date().getMonth() + 1);
  const totalDaysInMonth = new Date(year, month, 0).getDate();

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

  const effectiveCompTypeSplits = resolveCompensationType(employee);
  const isHourly = effectiveCompTypeSplits === 'hourly' || employee.payType === 'hourly';
  const hoursWorked = isHourly ? (Number(adjustments?.hoursWorked) || Number(employee.hoursWorked) || 0) : 0;

  const workingDays = isHourly ? totalDaysInMonth : Math.max(Number(workingDaysCount) || config.defaultWorkingDays, 1);
  const paidDays = isHourly
    ? workingDays
    : Math.max(
        Math.min(
          paidDaysCount !== null && paidDaysCount !== undefined ? Number(paidDaysCount) : workingDays,
          workingDays
        ),
        0
      );

  const lopStrategy = adjustments.lopStrategy || 'proportional';
  const customSegmentLops = adjustments.segmentLops || [];
  const dayProrate = isHourly
    ? new Array(totalDaysInMonth).fill(1.0)
    : getDayProrateArray(totalDaysInMonth, workingDays, paidDays, lopStrategy, customSegmentLops, segments);

  return segments.map((seg) => {
    const daySource = {
      ...seg.activeParams,
      hoursWorked: isHourly ? hoursWorked : undefined,
      pfEnabled: adjustments.pfEnabled !== undefined ? adjustments.pfEnabled : seg.activeParams.pfEnabled,
      esiEnabled: adjustments.esiEnabled !== undefined ? adjustments.esiEnabled : seg.activeParams.esiEnabled,
      ptEnabled: adjustments.ptEnabled !== undefined ? adjustments.ptEnabled : seg.activeParams.ptEnabled,
      ptState: adjustments.ptState !== undefined ? adjustments.ptState : seg.activeParams.ptState,
      lwfEnabled: adjustments.lwfEnabled !== undefined ? adjustments.lwfEnabled : seg.activeParams.lwfEnabled,
      tdsEnabled: adjustments.tdsEnabled !== undefined ? adjustments.tdsEnabled : seg.activeParams.tdsEnabled,
      gratuityEnabled: adjustments.gratuityEnabled !== undefined ? adjustments.gratuityEnabled : seg.activeParams.gratuityEnabled,
      includePfInCTC: adjustments.includePfInCTC !== undefined ? adjustments.includePfInCTC : seg.activeParams.includePfInCTC,
      includeGratuityInCTC: adjustments.includeGratuityInCTC !== undefined ? adjustments.includeGratuityInCTC : seg.activeParams.includeGratuityInCTC,
      basicPercent: adjustments.basicPercent !== undefined && adjustments.basicPercent !== null ? adjustments.basicPercent : seg.activeParams.basicPercent,
      hraPercent: adjustments.hraPercent !== undefined && adjustments.hraPercent !== null ? adjustments.hraPercent : seg.activeParams.hraPercent,
      _month: month,
      _year: year,
    };
    
    const dayMaster = buildMasterSalaryStructure(daySource, config);
    const segmentRatio = seg.daysCount / totalDaysInMonth;

    let segmentBasicSum = 0;
    let segmentPfEmployeeSum = 0;
    let segmentPfEmployerSum = 0;
    let segmentEsiEmployeeSum = 0;
    let segmentEsiEmployerSum = 0;
    let segmentGratuitySum = 0;
    let segmentProrateSum = 0;

    for (let day = seg.startDay; day <= seg.endDay; day++) {
      const dP = dayProrate[day - 1];
      segmentProrateSum += dP;
      
      const dailyBasic = (dayMaster.basicMaster / totalDaysInMonth) * dP;
      segmentBasicSum += dailyBasic;

      const dailyPfEmployee = (dayMaster.pfEmployee / totalDaysInMonth) * dP;
      const dailyPfEmployer = (dayMaster.pfEmployer / totalDaysInMonth) * dP;
      segmentPfEmployeeSum += dailyPfEmployee;
      segmentPfEmployerSum += dailyPfEmployer;

      const dailyGratuity = (dayMaster.gratuity / totalDaysInMonth) * dP;
      segmentGratuitySum += dailyGratuity;

      const dailyGrossForEsi = (dayMaster.totalEarnings / totalDaysInMonth) * dP;
      const dailyEsiEmployee = dayMaster.esiApplicable ? dailyGrossForEsi * config.esiEmployeeRate : 0;
      const dailyEsiEmployer = dayMaster.esiApplicable ? dailyGrossForEsi * config.esiEmployerRate : 0;
      segmentEsiEmployeeSum += dailyEsiEmployee;
      segmentEsiEmployerSum += dailyEsiEmployer;
    }

    const segmentProrateRatio = segmentProrateSum / totalDaysInMonth;

    const basic = roundAmount(segmentBasicSum);
    const hra = roundAmount(dayMaster.hraMaster * segmentProrateRatio);
    const flexi = roundAmount(dayMaster.flexi * segmentProrateRatio);
    const broadband = roundAmount(dayMaster.broadband * segmentProrateRatio);
    const petrol = roundAmount(dayMaster.petrol * segmentProrateRatio);
    const lta = roundAmount(dayMaster.lta * segmentProrateRatio);
    const specialAllowance = roundAmount(dayMaster.specialAllowance * segmentProrateRatio);
    const conveyance = roundAmount(dayMaster.conveyance * segmentProrateRatio);
    const medicalAllowance = roundAmount(dayMaster.medicalAllowance * segmentProrateRatio);

    const pfEmployee = roundAmount(segmentPfEmployeeSum);
    const pfEmployer = roundAmount(segmentPfEmployerSum);
    
    const esiEmployee = roundAmount(segmentEsiEmployeeSum);
    const esiEmployer = roundAmount(segmentEsiEmployerSum);

    const gratuity = roundAmount(segmentGratuitySum);
    const lwfEmployee = roundAmount(dayMaster.lwfEmployee * segmentRatio);
    const lwfEmployer = roundAmount(dayMaster.lwfEmployer * segmentRatio);
    const insurance = roundAmount(dayMaster.insurance * segmentRatio);
    const nps = roundAmount(dayMaster.employerNPS * segmentRatio);
    
    const totalEarnings = roundAmount(basic + hra + flexi + broadband + petrol + lta + specialAllowance + conveyance + medicalAllowance);

    return {
      startDate: new Date(Date.UTC(year, month - 1, seg.startDay)),
      endDate: new Date(Date.UTC(year, month - 1, seg.endDay)),
      daysCount: seg.daysCount,
      monthlyCTC: dayMaster.monthlyCTC,
      basic,
      hra,
      flexi,
      broadband,
      petrol,
      lta,
      specialAllowance,
      conveyance,
      medicalAllowance,
      pfEmployee,
      pfEmployer,
      esiEmployee,
      esiEmployer,
      gratuity,
      lwfEmployee,
      lwfEmployer,
      insurance,
      nps,
      totalEarnings,
    };
  });
};

module.exports = {
  DEFAULT_PAYROLL_CONFIG,
  normalizeConfig,
  getMonthlyCTCValue,
  buildMasterSalaryStructure,
  getSalarySplits,
};
