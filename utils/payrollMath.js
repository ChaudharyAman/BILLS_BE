const DEFAULT_PAYROLL_CONFIG = {
  basicPercent: 0.5,
  hraPercent: 0.5,
  pfRate: 0.12,
  pfCap: 15000,
  pfEmployerRate: 0.12,
  esiEmployeeRate: 0.0075,
  esiEmployerRate: 0.0325,
  esiBasicThreshold: 21000,
  lwfEmployer: 35,
  lwfEmployee: 15,
  gratuityRate: 0.0481,
  defaultWorkingDays: 30,
  defaultInsurance: 0,
  ltaMaxPercent: 0.0833,
};

const roundAmount = (value) => Math.round((Number(value) || 0) * 100) / 100;
const sumNamedAmounts = (items = []) => items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

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
    esiEmployeeRate: getNum(cfg.esiEmployeeRate, DEFAULT_PAYROLL_CONFIG.esiEmployeeRate),
    esiEmployerRate: getNum(cfg.esiEmployerRate, DEFAULT_PAYROLL_CONFIG.esiEmployerRate),
    esiBasicThreshold: getNum(cfg.esiBasicThreshold, DEFAULT_PAYROLL_CONFIG.esiBasicThreshold),
    lwfEmployer: getNum(cfg.lwfEmployer, DEFAULT_PAYROLL_CONFIG.lwfEmployer),
    lwfEmployee: getNum(cfg.lwfEmployee, DEFAULT_PAYROLL_CONFIG.lwfEmployee),
    gratuityRate: getNum(cfg.gratuityRate, DEFAULT_PAYROLL_CONFIG.gratuityRate),
    defaultWorkingDays: getNum(cfg.defaultWorkingDays, DEFAULT_PAYROLL_CONFIG.defaultWorkingDays),
    defaultInsurance: getNum(cfg.defaultInsurance, DEFAULT_PAYROLL_CONFIG.defaultInsurance),
    ltaMaxPercent: getNum(cfg.ltaMaxPercent, DEFAULT_PAYROLL_CONFIG.ltaMaxPercent),
    salaryComponents: cfg.salaryComponents || null,
  };
};

const getMonthlyCTCValue = (source = {}) => {
  const monthlyCTC = Number(source.monthlyCTC);
  if (Number.isFinite(monthlyCTC) && monthlyCTC > 0) return monthlyCTC;

  const annualCTC = Number(source.annualCTC);
  if (Number.isFinite(annualCTC) && annualCTC > 0) return annualCTC / 12;

  const salaryCTC = Number(source.salaryStructure?.ctc);
  if (Number.isFinite(salaryCTC) && salaryCTC > 0) return salaryCTC;

  return 0;
};

const calculateHRAExemption = (basicMaster, hraMaster, rentPaidMonthly, isMetroCity) => {
  const annualBasic = basicMaster * 12;
  const annualHRA = hraMaster * 12;
  const rentPaidAnnual = (Number(rentPaidMonthly) || 0) * 12;
  if (rentPaidAnnual <= 0) return 0;

  const pctOfBasic = annualBasic * 0.10;
  const capPercent = isMetroCity ? 0.50 : 0.40;
  const capAmount = annualBasic * capPercent;

  return Math.max(0, Math.min(
    annualHRA,
    rentPaidAnnual - pctOfBasic,
    capAmount
  ));
};

const calculateTaxForRegime = (regime, annualTaxableIncome) => {
  const income = Math.max(0, annualTaxableIncome);
  let tax = 0;

  if (regime === 'new') {
    if (income <= 400000) return 0;
    if (income > 2400000) {
      tax += (income - 2400000) * 0.30;
      tax += 300000;
    } else if (income > 2000000) {
      tax += (income - 2000000) * 0.25;
      tax += 200000;
    } else if (income > 1600000) {
      tax += (income - 1600000) * 0.20;
      tax += 120000;
    } else if (income > 1200000) {
      tax += (income - 1200000) * 0.15;
      tax += 60000;
    } else if (income > 800000) {
      tax += (income - 800000) * 0.10;
      tax += 20000;
    } else if (income > 400000) {
      tax += (income - 400000) * 0.05;
    }

    if (income <= 1200000) {
      tax = 0;
    }
  } else {
    // Old Regime
    if (income <= 250000) return 0;
    if (income > 1000000) {
      tax += (income - 1000000) * 0.30;
      tax += 112500;
    } else if (income > 500000) {
      tax += (income - 500000) * 0.20;
      tax += 12500;
    } else if (income > 250000) {
      tax += (income - 250000) * 0.05;
    }

    if (income <= 500000) {
      tax = 0;
    }
  }

  return tax;
};

const calculateTaxDetails = (employee, monthlyCTC, config, basicMaster, hraMaster, totalEarnings) => {
  const annualGrossEarnings = totalEarnings * 12;
  const dec = employee.declarations || {};
  const ptEnabled = employee.ptEnabled !== false;

  // 1. New Regime calculations
  const standardDeductionNew = 75000;
  const netTaxableIncomeNew = Math.max(0, annualGrossEarnings - standardDeductionNew);
  let annualTaxNewBase = calculateTaxForRegime('new', netTaxableIncomeNew);
  // Apply Marginal Relief under Section 87A for New Regime (Budget 2025 limit: ₹12 Lakhs)
  if (netTaxableIncomeNew > 1200000) {
    const excessIncome = netTaxableIncomeNew - 1200000;
    if (annualTaxNewBase > excessIncome) {
      annualTaxNewBase = excessIncome;
    }
  }
  const cessNew = roundAmount(annualTaxNewBase * 0.04);
  const annualTaxNew = roundAmount(annualTaxNewBase + cessNew);
  const monthlyTaxNew = roundAmount(annualTaxNew / 12);

  // 2. Old Regime calculations
  const standardDeductionOld = 50000;
  const hraExemption = calculateHRAExemption(basicMaster, hraMaster, dec.rentPaidMonthly || 0, dec.isMetroCity || false);
  const sec80C = Math.min(Number(dec.section80C) || 0, 150000);
  const sec80D = Math.min(Number(dec.section80D) || 0, 25000);
  const sec24b = Math.min(Number(dec.section24b) || 0, 200000);
  const sec80CCD1B = Math.min(Number(dec.section80CCD1B) || 0, 50000);
  const otherExemptions = Number(dec.otherExemptions) || 0;
  const professionalTaxOld = ptEnabled ? (Number(employee.deductions?.professionalTax) || 0) * 12 : 0;

  const totalDeductionsOld = standardDeductionOld + hraExemption + sec80C + sec80D + sec24b + sec80CCD1B + otherExemptions + professionalTaxOld;
  const netTaxableIncomeOld = Math.max(0, annualGrossEarnings - totalDeductionsOld);
  const annualTaxOldBase = calculateTaxForRegime('old', netTaxableIncomeOld);
  const cessOld = roundAmount(annualTaxOldBase * 0.04);
  const annualTaxOld = roundAmount(annualTaxOldBase + cessOld);
  const monthlyTaxOld = roundAmount(annualTaxOld / 12);

  return {
    newRegime: {
      standardDeduction: standardDeductionNew,
      netTaxableIncome: netTaxableIncomeNew,
      annualTaxBase: annualTaxNewBase,
      cess: cessNew,
      annualTax: annualTaxNew,
      monthlyTax: monthlyTaxNew,
    },
    oldRegime: {
      standardDeduction: standardDeductionOld,
      hraExemption,
      section80C: sec80C,
      section80D: sec80D,
      section24b: sec24b,
      section80CCD1B: sec80CCD1B,
      otherExemptions,
      professionalTax: professionalTaxOld,
      totalDeductions: totalDeductionsOld,
      netTaxableIncome: netTaxableIncomeOld,
      annualTaxBase: annualTaxOldBase,
      cess: cessOld,
      annualTax: annualTaxOld,
      monthlyTax: monthlyTaxOld,
    }
  };
};

const buildMasterSalaryStructure = (source = {}, configInput = {}) => {
  const config = normalizeConfig(configInput);
  const monthlyCTC = roundAmount(getMonthlyCTCValue(source));

  // Toggles integration
  const pfEnabled = source.pfEnabled !== false;
  const esiEnabled = source.esiEnabled !== false;
  const ptEnabled = source.ptEnabled !== false;
  const lwfEnabled = source.lwfEnabled !== false;
  const gratuityEnabled = source.gratuityEnabled !== false;
  const includePfInCTC = source.includePfInCTC !== false;
  const includeGratuityInCTC = source.includeGratuityInCTC !== false;

  let basicPercent = config.basicPercent;
  if (source.basicPercent !== undefined && source.basicPercent !== null && Number(source.basicPercent) > 0) {
    basicPercent = Number(source.basicPercent) > 1 ? Number(source.basicPercent) / 100 : Number(source.basicPercent);
  }

  let hraPercent = config.hraPercent;
  if (source.hraPercent !== undefined && source.hraPercent !== null && Number(source.hraPercent) > 0) {
    hraPercent = Number(source.hraPercent) > 1 ? Number(source.hraPercent) / 100 : Number(source.hraPercent);
  }

  const hasDynamicComponents = config.salaryComponents && config.salaryComponents.length > 0;
  const earningsMap = {};

  let basicMaster = roundAmount(monthlyCTC * basicPercent);
  const sourceBasic = source.basic !== undefined ? source.basic : source.salaryStructure?.basic;
  if (sourceBasic !== undefined && sourceBasic !== null && Number(sourceBasic) > 0) {
    basicMaster = roundAmount(sourceBasic);
  }

  let hraMaster = roundAmount(basicMaster * hraPercent);
  const sourceHra = source.hra !== undefined ? source.hra : source.salaryStructure?.hra;
  if (sourceHra !== undefined && sourceHra !== null && Number(sourceHra) > 0) {
    hraMaster = roundAmount(sourceHra);
  }

  if (hasDynamicComponents) {
    const basicComp = config.salaryComponents.find(c => c.id === 'basic');
    if (basicComp) {
      let bVal = basicComp.linkValue;
      if (source.basicPercent !== undefined && source.basicPercent !== null && Number(source.basicPercent) > 0) {
        bVal = Number(source.basicPercent) > 1 ? Number(source.basicPercent) / 100 : Number(source.basicPercent);
      }
      if (basicComp.linkedTo === 'ctc_percent') {
        basicMaster = roundAmount(monthlyCTC * bVal);
      } else if (basicComp.linkedTo === 'fixed') {
        const val = source['basic'] !== undefined ? source['basic'] : (source.salaryStructure?.['basic'] !== undefined ? source.salaryStructure['basic'] : 0);
        basicMaster = roundAmount(val);
      }
    }
    const hraComp = config.salaryComponents.find(c => c.id === 'hra');
    if (hraComp) {
      let hVal = hraComp.linkValue;
      if (source.hraPercent !== undefined && source.hraPercent !== null && Number(source.hraPercent) > 0) {
        hVal = Number(source.hraPercent) > 1 ? Number(source.hraPercent) / 100 : Number(source.hraPercent);
      }
      if (hraComp.linkedTo === 'basic_percent') {
        hraMaster = roundAmount(basicMaster * hVal);
      } else if (hraComp.linkedTo === 'ctc_percent') {
        hraMaster = roundAmount(monthlyCTC * hVal);
      } else if (hraComp.linkedTo === 'fixed') {
        const val = source['hra'] !== undefined ? source['hra'] : (source.salaryStructure?.['hra'] !== undefined ? source.salaryStructure['hra'] : 0);
        hraMaster = roundAmount(val);
      }
    }
  }

  // PF Calculation
  const pfBase = pfEnabled ? roundAmount(Math.min(basicMaster, config.pfCap)) : 0;
  const pfEmployer = pfEnabled ? roundAmount(pfBase * config.pfEmployerRate) : 0;
  const pfEmployee = pfEnabled ? roundAmount(pfBase * config.pfRate) : 0;

  // Gratuity Calculation
  const gratuity = gratuityEnabled ? roundAmount(basicMaster * config.gratuityRate) : 0;

  // LWF Calculation
  const lwfEmployer = (lwfEnabled && monthlyCTC > 0) ? roundAmount(config.lwfEmployer) : 0;
  const lwfEmployee = (lwfEnabled && monthlyCTC > 0) ? roundAmount(config.lwfEmployee) : 0;

  const insurance = monthlyCTC > 0 ? roundAmount(source.insuranceAmount ?? config.defaultInsurance) : 0;
  const employerNPS = roundAmount(source.employerNPS);

  // ESI Calculation based on estimated Gross Wages (avoiding circular dependency)
  const estimatedGross = monthlyCTC - pfEmployer - lwfEmployer - insurance - gratuity;
  const esiApplicable = esiEnabled && (estimatedGross <= config.esiBasicThreshold);
  const esiEmployer = roundAmount(esiApplicable ? basicMaster * config.esiEmployerRate : 0);
  const esiEmployee = roundAmount(esiApplicable ? basicMaster * config.esiEmployeeRate : 0);

  // CTC integration balancing special allowance
  const pfEmployerInCTC = (pfEnabled && includePfInCTC) ? pfEmployer : 0;
  const gratuityInCTC = (gratuityEnabled && includeGratuityInCTC) ? gratuity : 0;

  const otherAllowances = source.salaryStructure?.otherAllowances || source.otherAllowances || [];
  const otherAllowancesSum = roundAmount(otherAllowances.reduce((sum, item) => sum + (Number(item.amount) || 0), 0));

  let flexi = 0, broadband = 0, petrol = 0, lta = 0, ltaCap = 0, conveyance = 0, medicalAllowance = 0, specialAllowance = 0;

  if (hasDynamicComponents) {
    ltaCap = roundAmount(basicMaster * config.ltaMaxPercent);
    let sumOfAllNonRemainderComponents = 0;

    config.salaryComponents.forEach(c => {
      if (c.type === 'earning' && c.linkedTo !== 'remainder') {
        let amount = 0;
        if (c.id === 'basic') {
          amount = basicMaster;
        } else if (c.id === 'hra') {
          amount = hraMaster;
        } else if (c.linkedTo === 'ctc_percent') {
          amount = roundAmount(monthlyCTC * c.linkValue);
        } else if (c.linkedTo === 'basic_percent') {
          amount = roundAmount(basicMaster * c.linkValue);
        } else if (c.linkedTo === 'fixed') {
          const val = source[c.id] !== undefined ? source[c.id] : (source.salaryStructure?.[c.id] !== undefined ? source.salaryStructure[c.id] : 0);
          amount = roundAmount(val);
        }
        if (c.id === 'lta') {
          amount = roundAmount(Math.min(amount, ltaCap || amount));
        }
        earningsMap[c.id] = amount;
        sumOfAllNonRemainderComponents += amount;
      }
    });

    config.salaryComponents.forEach(c => {
      if (c.type === 'earning' && c.linkedTo === 'remainder') {
        const amount = roundAmount(Math.max(
          monthlyCTC - sumOfAllNonRemainderComponents - pfEmployerInCTC - gratuityInCTC - lwfEmployer - insurance - esiEmployer - employerNPS - otherAllowancesSum,
          0
        ));
        earningsMap[c.id] = amount;
      }
    });

    flexi = earningsMap['flexi'] || 0;
    broadband = earningsMap['broadband'] || 0;
    petrol = earningsMap['petrol'] || 0;
    lta = earningsMap['lta'] || 0;
    conveyance = earningsMap['conveyance'] || 0;
    medicalAllowance = earningsMap['medical'] || 0;
    specialAllowance = earningsMap['special'] || 0;
  } else {
    flexi = roundAmount(source.flexiAmount);
    broadband = roundAmount(source.broadband);
    petrol = roundAmount(source.petrol);
    const ltaRequested = roundAmount(source.lta);
    ltaCap = roundAmount(basicMaster * config.ltaMaxPercent);
    lta = roundAmount(Math.min(ltaRequested, ltaCap || ltaRequested));
    conveyance = roundAmount(source.salaryStructure?.conveyance);
    medicalAllowance = roundAmount(source.salaryStructure?.medicalAllowance);
    specialAllowance = roundAmount(Math.max(
      monthlyCTC - basicMaster - hraMaster - flexi - broadband - petrol - lta - pfEmployerInCTC - gratuityInCTC - lwfEmployer - insurance - esiEmployer - employerNPS - conveyance - medicalAllowance - otherAllowancesSum,
      0
    ));
  }

  const totalEarnings = hasDynamicComponents
    ? roundAmount(Object.values(earningsMap).reduce((sum, v) => sum + v, 0) + otherAllowancesSum)
    : roundAmount(basicMaster + hraMaster + flexi + broadband + petrol + lta + specialAllowance + conveyance + medicalAllowance + otherAllowancesSum);

  const grossSalary = hasDynamicComponents
    ? roundAmount(Object.entries(earningsMap).reduce((sum, [id, val]) => {
        if (['flexi', 'broadband', 'petrol', 'lta'].includes(id)) return sum;
        return sum + val;
      }, 0) + otherAllowancesSum)
    : roundAmount(basicMaster + hraMaster + conveyance + medicalAllowance + specialAllowance + otherAllowancesSum);

  const totalEmployerContributions = roundAmount(
    pfEmployer + esiEmployer + gratuity + lwfEmployer + insurance + employerNPS
  );

  // Dynamic Tax Engine Calculations
  const taxRegime = source.taxRegime || 'new';
  const declarations = source.declarations || {};

  const taxDetails = calculateTaxDetails({
    ...source,
    ptEnabled,
    taxRegime,
    declarations
  }, monthlyCTC, config, basicMaster, hraMaster, totalEarnings);

  const calculatedTdsMonthly = taxDetails[taxRegime === 'old' ? 'oldRegime' : 'newRegime'].monthlyTax;
  const tds = Number(source.deductions?.tds) > 0 ? Number(source.deductions?.tds) : roundAmount(calculatedTdsMonthly);

  const professionalTax = ptEnabled ? (Number(source.deductions?.professionalTax) || 0) : 0;
  const otherDeductions = source.deductions?.otherDeductions || source.otherDeductions || [];
  const otherDeductionsSum = roundAmount(otherDeductions.reduce((sum, item) => sum + (Number(item.amount) || 0), 0));

  const totalDeductions = roundAmount(
    pfEmployee +
    esiEmployee +
    professionalTax +
    tds +
    lwfEmployee +
    otherDeductionsSum
  );

  return {
    config,
    monthlyCTC,
    annualCTC: roundAmount(monthlyCTC * 12),
    basicMaster,
    hraMaster,
    pfBase,
    pfEmployer,
    pfEmployee,
    gratuity,
    lwfEmployer,
    lwfEmployee,
    insurance,
    flexi,
    broadband,
    petrol,
    lta,
    ltaCap,
    employerNPS,
    conveyance,
    medicalAllowance,
    specialAllowance,
    esiApplicable,
    esiEmployer,
    esiEmployee,
    grossSalary,
    totalEarnings,
    totalEmployerContributions,
    grossTotalSalary: roundAmount(totalEarnings + totalEmployerContributions),
    totalDeductions,
    netTakeHome: roundAmount(Math.max(0, totalEarnings - totalDeductions)),
    diff: roundAmount(monthlyCTC - (basicMaster + hraMaster + flexi + broadband + petrol + lta + pfEmployerInCTC + gratuityInCTC + lwfEmployer + insurance + esiEmployer + employerNPS + conveyance + medicalAllowance + specialAllowance)),
    taxRegime,
    declarations,
    taxDetails,
    tds,
    professionalTax,
    pfEnabled,
    esiEnabled,
    ptEnabled,
    lwfEnabled,
    gratuityEnabled,
    includePfInCTC,
    includeGratuityInCTC,
    earningsMap,
  };
};

const buildPayrollSnapshot = (employeeInput, configInput, attendance, adjustments = {}, monthNum) => {
  const employee = (employeeInput && typeof employeeInput.toObject === 'function')
    ? employeeInput.toObject()
    : employeeInput;
  const config = normalizeConfig(configInput);
  
  const mergedSource = {
    ...employee,
    pfEnabled: adjustments.pfEnabled !== undefined ? adjustments.pfEnabled : (employee.pfEnabled !== false),
    esiEnabled: adjustments.esiEnabled !== undefined ? adjustments.esiEnabled : (employee.esiEnabled !== false),
    ptEnabled: adjustments.ptEnabled !== undefined ? adjustments.ptEnabled : (employee.ptEnabled !== false),
    lwfEnabled: adjustments.lwfEnabled !== undefined ? adjustments.lwfEnabled : (employee.lwfEnabled !== false),
    gratuityEnabled: adjustments.gratuityEnabled !== undefined ? adjustments.gratuityEnabled : (employee.gratuityEnabled !== false),
    includePfInCTC: adjustments.includePfInCTC !== undefined ? adjustments.includePfInCTC : (employee.includePfInCTC !== false),
    includeGratuityInCTC: adjustments.includeGratuityInCTC !== undefined ? adjustments.includeGratuityInCTC : (employee.includeGratuityInCTC !== false),
    basicPercent: adjustments.basicPercent !== undefined && adjustments.basicPercent !== null ? adjustments.basicPercent : employee.basicPercent,
    hraPercent: adjustments.hraPercent !== undefined && adjustments.hraPercent !== null ? adjustments.hraPercent : employee.hraPercent,
  };

  const master = buildMasterSalaryStructure(mergedSource, config);
  const requestedWorkingDays = Number(attendance?.workingDays);
  const workingDays = Math.max(requestedWorkingDays || config.defaultWorkingDays, 1);
  const rawPaidDays = Number(attendance?.paidDays ?? attendance?.presentDays ?? workingDays);
  const paidDays = roundAmount(clamp(rawPaidDays || workingDays, 0, workingDays));
  const prorate = Math.min(paidDays / workingDays, 1);
  const lop = roundAmount(Math.max(workingDays - paidDays, 0));

  let otherEarnings = [];
  if (Array.isArray(adjustments.otherEarnings) && adjustments.otherEarnings.length > 0) {
    otherEarnings = adjustments.otherEarnings.map(item => ({
      name: item.name,
      amount: roundAmount(item.amount)
    }));
  } else {
    const profileAllowances = employee.salaryStructure?.otherAllowances || [];
    otherEarnings = profileAllowances.map(item => ({
      name: item.name,
      amount: roundAmount((Number(item.amount) || 0) * prorate)
    }));
  }

  let otherDeductions = [];
  if (Array.isArray(adjustments.otherDeductions) && adjustments.otherDeductions.length > 0) {
    otherDeductions = adjustments.otherDeductions.map(item => ({
      name: item.name,
      amount: roundAmount(item.amount)
    }));
  } else {
    const profileDeductions = employee.deductions?.otherDeductions || [];
    otherDeductions = profileDeductions.map(item => ({
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

  const hasDynamicComponents = config.salaryComponents && config.salaryComponents.length > 0;
  let earnings = {};

  if (hasDynamicComponents) {
    earnings = {
      otherEarnings: [...otherEarnings],
      overtime: roundAmount(adjustments.overtime),
    };
    config.salaryComponents.forEach(c => {
      if (c.type === 'earning') {
        const masterVal = master.earningsMap?.[c.id] ?? master[c.id] ?? 0;
        let proratedVal = roundAmount(masterVal * prorate);
        if (!isMatchingFrequency(c.frequency, monthNum)) {
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
        else {
          const name = c.name || c.id;
          const adjustedIndex = earnings.otherEarnings.findIndex(x => x.name === name);
          if (adjustedIndex === -1) {
            earnings.otherEarnings.push({ name, amount: proratedVal });
          }
        }
      }
    });

    earnings.totalEarnings = roundAmount(
      config.salaryComponents
        .filter(c => c.type === 'earning')
        .reduce((sum, c) => {
          const standardEarningIds = ['basic', 'hra', 'flexi', 'broadband', 'petrol', 'lta', 'special', 'conveyance', 'medical'];
          if (!standardEarningIds.includes(c.id)) return sum;
          return sum + (earnings[c.id] || 0);
        }, 0) +
      earnings.overtime +
      sumNamedAmounts(earnings.otherEarnings)
    );
  } else {
    earnings = {
      basic: roundAmount(master.basicMaster * prorate),
      hra: roundAmount(master.hraMaster * prorate),
      flexiAmount: roundAmount(master.flexi * prorate),
      broadband: roundAmount(master.broadband * prorate),
      petrol: roundAmount(master.petrol * prorate),
      lta: roundAmount(master.lta * prorate),
      specialAllowance: roundAmount(master.specialAllowance * prorate),
      overtime: roundAmount(adjustments.overtime),
      conveyance: roundAmount(master.conveyance * prorate),
      medicalAllowance: roundAmount(master.medicalAllowance * prorate),
      otherEarnings,
    };
    earnings.totalEarnings = roundAmount(
      Object.values(earnings).filter((value) => typeof value === 'number').reduce((sum, value) => sum + value, 0) +
      sumNamedAmounts(earnings.otherEarnings)
    );
  }

  const esiEmployer = roundAmount(master.esiApplicable ? earnings.basic * config.esiEmployerRate : 0);
  const employerContributions = {
    pfEmployer: master.pfEmployer,
    esiEmployer,
    gratuity: master.gratuity,
    lwfEmployer: master.lwfEmployer,
    insuranceEmployer: master.insurance,
    nps: master.employerNPS,
    grossTotalSalary: roundAmount(
      earnings.totalEarnings +
      master.pfEmployer +
      master.gratuity +
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

  const deductions = {
    pfEmployee: master.pfEmployee,
    esiEmployee: roundAmount(master.esiApplicable ? earnings.basic * config.esiEmployeeRate : 0),
    professionalTax: master.ptEnabled ? roundAmount(employee.deductions?.professionalTax) : 0,
    tds: roundAmount(adjustments.tds ?? (Number(employee.deductions?.tds) > 0 ? employee.deductions.tds : master.tds)),
    insuranceEmployee: roundAmount(adjustments.insuranceEmployee),
    lwfEmployee: master.lwfEmployee,
    gratuityDeduction: roundAmount(adjustments.gratuityDeduction),
    loanDeduction: roundAmount(adjustments.loanDeduction),
    advanceDeduction: roundAmount(adjustments.advanceDeduction),
    otherDeductions,
  };
  deductions.totalDeductions = roundAmount(
    Object.entries(deductions)
      .filter(([key, value]) => key !== 'otherDeductions' && typeof value === 'number')
      .reduce((sum, [, value]) => sum + value, 0) +
    sumNamedAmounts(deductions.otherDeductions)
  );

  const reimbursements = Array.isArray(adjustments.reimbursements) ? adjustments.reimbursements : [];
  const totalReimbursementApproved = roundAmount(reimbursements.reduce((sum, r) => sum + (Number(r.approved) || 0), 0));

  return {
    earnings,
    employerContributions,
    variablePay,
    totalPayable,
    deductions,
    reimbursements,
    totalReimbursementApproved,
    netSalary: roundAmount(Math.max(0, earnings.totalEarnings + variablePay.totalVariablePay + totalReimbursementApproved - deductions.totalDeductions)),
    lop,
    paidDays,
    workingDays,
    paidLeaves: roundAmount(attendance?.paidLeaves),
    unpaidLeaves: roundAmount(attendance?.unpaidLeaves),
    prorate: roundAmount(prorate),
    master,
  };
};

module.exports = {
  DEFAULT_PAYROLL_CONFIG,
  roundAmount,
  sumNamedAmounts,
  normalizeConfig,
  getMonthlyCTCValue,
  calculateHRAExemption,
  calculateTaxForRegime,
  calculateTaxDetails,
  buildMasterSalaryStructure,
  buildPayrollSnapshot,
};
