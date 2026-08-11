/**
 * utils/payrollMath/taxWorksheet.js
 *
 * Single shared helper for building income tax worksheets for payslip JSON API and PDF rendering.
 * Branches on compensationType (mirroring buildPayslipEarningsLineItems) so that
 * non-component pay types (hourly, daily_wage, etc.) display a correctly-labelled
 * single gross-pay row rather than "Basic ₹X, HRA ₹0, Flexi ₹0 …".
 */

'use strict';

const { calculateHRAExemption, calculateTaxForRegime } = require('./tax');
const { NON_COMPONENT_TYPES, resolveNonComponentRowSpec } = require('./compensationRowSpec');

function buildTaxWorksheet({ payroll = {}, employee = {}, fyPayrolls = [], tdsMonthsInput = null } = {}) {
  if (payroll.taxWorksheet) return payroll.taxWorksheet;

  const empSnap = payroll.employeeSnapshot || {};
  const emp = employee || {};
  const regime = empSnap.taxRegime || emp.taxRegime || 'new';
  const isOld = regime === 'old';
  const standardDeduction = isOld ? 50000 : 75000;

  // Resolve compensationType the same way payslipLineItems does.
  const compType = empSnap.compensationType || emp.compensationType ||
    (payroll.payType === 'hourly' ? 'hourly' : 'monthly_salary');

  const declarations = empSnap.declarations || emp.declarations || {};
  const rentPaidMonthly = Number(declarations.rentPaidMonthly) || 0;
  const rentPaidTotal = rentPaidMonthly * 12;
  const isMetro = declarations.isMetroCity || false;

  let componentBreakdown;
  let grossSalary;
  let exemptHra = 0;
  let basicAnnual = 0;
  let hraAnnual = 0;

  if (NON_COMPONENT_TYPES.has(compType)) {
    // --- Non-component pay types: single gross row, no HRA split. ---
    const spec = resolveNonComponentRowSpec(compType, payroll);
    const effectiveGross = spec.amount * 12;

    componentBreakdown = [
      { name: spec.name, gross: effectiveGross, exempt: 0, taxable: effectiveGross }
    ];
    grossSalary = effectiveGross;
    basicAnnual = effectiveGross; // used for basicPercent / rentMinusBasic10 display only
    hraAnnual = 0;
  } else {
    // --- Component-based types: monthly_salary, attendance_based, salary_plus_commission ---
    const basic  = Number(payroll.earnings?.basic || 0);
    const hra    = Number(payroll.earnings?.hra || 0);
    const flexi  = Number(payroll.earnings?.flexiAmount || payroll.earnings?.flexi || 0);
    const special = Number(payroll.earnings?.specialAllowance || payroll.earnings?.special || 0);
    const meal   = Number(payroll.earnings?.mealAllowance || payroll.earnings?.meal || 0);
    const broadband = Number(payroll.earnings?.broadband || 0);

    let other = Number(payroll.earnings?.petrol || 0) +
                Number(payroll.earnings?.lta || 0) +
                Number(payroll.earnings?.conveyance || 0) +
                Number(payroll.earnings?.medicalAllowance || 0);
    if (Array.isArray(payroll.earnings?.otherEarnings)) {
      other += payroll.earnings.otherEarnings.reduce((s, o) => s + (Number(o.amount) || 0), 0);
    }

    let bonus = 0;
    if (payroll.variablePay) {
      bonus += Number(payroll.variablePay.joiningBonus || 0) +
               Number(payroll.variablePay.loyaltyBonus || 0) +
               Number(payroll.variablePay.incentive || 0) +
               Number(payroll.variablePay.specialBonus || 0) +
               Number(payroll.variablePay.otherAllowanceArrear || 0);
    }

    // Commission for salary_plus_commission
    let commission = 0;
    if (compType === 'salary_plus_commission') {
      if (Array.isArray(payroll.earnings?.variableCompensation)) {
        commission = payroll.earnings.variableCompensation
          .reduce((s, v) => s + (Number(v.amount) || 0), 0);
      }
    }

    basicAnnual    = basic * 12;
    hraAnnual      = hra * 12;
    const flexiAnnual   = flexi * 12;
    const specialAnnual = special * 12;
    const mealAnnual    = meal * 12;
    const broadbandAnnual = broadband * 12;
    const otherAnnual   = other * 12;
    const bonusAnnual   = bonus * 12;
    const commissionAnnual = commission * 12;
    const arrearAnnual  = 0;

    exemptHra = isOld
      ? Math.round(calculateHRAExemption(basic, hra, rentPaidMonthly, isMetro))
      : 0;

    componentBreakdown = [
      { name: 'Basic', gross: basicAnnual, exempt: 0, taxable: basicAnnual },
      { name: 'HRA', gross: hraAnnual, exempt: exemptHra, taxable: Math.max(0, hraAnnual - exemptHra) },
      { name: 'Flexi Allowance', gross: flexiAnnual, exempt: 0, taxable: flexiAnnual },
      { name: 'Special Allowance', gross: specialAnnual, exempt: 0, taxable: specialAnnual },
      { name: 'Meal', gross: mealAnnual, exempt: 0, taxable: mealAnnual },
      { name: 'Broadband', gross: broadbandAnnual, exempt: 0, taxable: broadbandAnnual },
      { name: 'Other', gross: otherAnnual, exempt: 0, taxable: otherAnnual },
      { name: 'Bonus', gross: bonusAnnual, exempt: 0, taxable: bonusAnnual },
      { name: 'Arrear', gross: arrearAnnual, exempt: 0, taxable: arrearAnnual },
    ];

    // Add Commission row for salary_plus_commission when present
    if (compType === 'salary_plus_commission' && commissionAnnual > 0) {
      componentBreakdown.push({
        name: 'Commission',
        gross: commissionAnnual,
        exempt: 0,
        taxable: commissionAnnual
      });
    }

    grossSalary = basicAnnual + hraAnnual + flexiAnnual + specialAnnual + mealAnnual +
                  broadbandAnnual + otherAnnual + bonusAnnual + arrearAnnual + commissionAnnual;
  }

  // Chapter VI-A deductions — old regime only (same caps as tax.js calculateTaxDetails)
  let chapterVIA = 0;
  let sec80C = 0, sec80D = 0, sec80CCD1B = 0, sec24b = 0, otherExemptions = 0;
  if (isOld) {
    sec80C        = Math.min(Number(declarations.section80C)    || 0, 150000);
    sec80D        = Math.min(Number(declarations.section80D)    || 0, 25000);
    sec80CCD1B    = Math.min(Number(declarations.section80CCD1B) || 0, 50000);
    sec24b        = Math.min(Number(declarations.section24b)    || 0, 200000);
    otherExemptions = Number(declarations.otherExemptions)      || 0;
    chapterVIA    = sec80C + sec80D + sec80CCD1B + sec24b + otherExemptions;
  }

  const taxableIncome = Math.max(0, grossSalary - exemptHra - standardDeduction - chapterVIA);
  const totalTax = calculateTaxForRegime(regime, taxableIncome);
  const cess = Math.round(totalTax * 0.04 * 100) / 100;
  const netTax = Math.round((totalTax + cess) * 100) / 100;
  const taxDeductionThisMonth = Number(payroll.deductions?.tds || 0);

  // HRA display metadata (always present in returned shape even for non-component types)
  const basic_10 = basicAnnual * 0.1;
  const rentMinusBasic10 = Math.max(0, rentPaidTotal - basic_10);
  const basicPercent = basicAnnual * (isMetro ? 0.5 : 0.4);

  // Build tdsMonths — genuine FY-to-date sum
  const tdsMonths = { 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0, 1: 0, 2: 0, 3: 0 };

  if (tdsMonthsInput && typeof tdsMonthsInput === 'object') {
    Object.assign(tdsMonths, tdsMonthsInput);
  } else if (Array.isArray(fyPayrolls) && fyPayrolls.length > 0) {
    for (const pr of fyPayrolls) {
      if (pr.deductions?.tds && pr.month in tdsMonths) {
        tdsMonths[pr.month] = Number(pr.deductions.tds) || 0;
      }
    }
  } else if (payroll.month && payroll.month in tdsMonths) {
    tdsMonths[payroll.month] = taxDeductionThisMonth;
  }

  const taxDeductedTillDate = Object.values(tdsMonths).reduce((s, v) => s + v, 0);
  const taxToDeducted = Math.max(0, netTax - taxDeductedTillDate);

  return {
    regime,
    componentBreakdown,
    grossSalary,
    standardDeduction,
    taxableIncome,
    totalTax,
    cess,
    netTax,
    taxDeductedTillDate,
    taxToDeducted,
    taxDeductionThisMonth,
    tdsMonths,
    chapterVIADeductions: {
      section80C: sec80C,
      section80D: sec80D,
      section80CCD1B: sec80CCD1B,
      section24b: sec24b,
      otherExemptions,
      total: chapterVIA
    },
    hra: {
      from: 'April',
      to: 'March',
      rentPaid: rentPaidTotal,
      actualHRA: hraAnnual,
      basicPercent,
      rentMinusBasic10,
      exemptHRA: exemptHra
    }
  };
}

module.exports = {
  buildTaxWorksheet,
};
