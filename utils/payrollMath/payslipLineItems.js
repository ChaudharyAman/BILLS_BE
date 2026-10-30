/**
 * utils/payrollMath/payslipLineItems.js
 *
 * Formats earnings and deductions line items for payslip serialization.
 */

const { roundAmount } = require('../money');
const { NON_COMPONENT_TYPES, resolveNonComponentRowSpec } = require('./compensationRowSpec');

function buildPayslipEarningsLineItems(payroll = {}, options = {}) {
  const lineItems = [];
  const earnings = payroll.earnings || {};
  const periodInput = payroll.periodInput || {};
  const empSnapshot = payroll.employeeSnapshot || {};
  const emp = payroll.employee || {};

  const compType = empSnapshot.compensationType || emp.compensationType || (payroll.payType === 'hourly' ? 'hourly' : 'monthly_salary');

  const formatCurrency = (val) => Number(val) || 0;
  const salaryComponents = options.salaryComponents || options.config?.salaryComponents || payroll.salaryComponents || payroll.payrollConfig?.salaryComponents || [];

  const findComp = (idOrKey) => {
    if (!Array.isArray(salaryComponents) || salaryComponents.length === 0) return null;
    const cleanKey = String(idOrKey || '').toLowerCase().trim();
    return salaryComponents.find(c => {
      if (!c) return false;
      const cId = String(c.id || '').toLowerCase().trim();
      const cName = String(c.name || '').toLowerCase().trim();
      return cId === cleanKey || cName === cleanKey || cleanKey.replace(/^custom_/, '') === cId.replace(/^custom_/, '');
    });
  };

  if (['monthly_salary', 'attendance_based', 'salary_plus_commission'].includes(compType)) {
    if (earnings.basic > 0) lineItems.push({ id: 'basic', name: findComp('basic')?.name || 'Basic Salary', amount: formatCurrency(earnings.basic), details: '-', arrear: '-' });
    if (earnings.hra > 0) lineItems.push({ id: 'hra', name: findComp('hra')?.name || 'House Rent Allowance (HRA)', amount: formatCurrency(earnings.hra), details: '-', arrear: '-' });
    
    const specialAmt = earnings.specialAllowance > 0 ? earnings.specialAllowance : (earnings.earningsMap?.special > 0 ? earnings.earningsMap.special : 0);
    if (specialAmt > 0) lineItems.push({ id: 'special', name: findComp('special')?.name || 'Special Allowance', amount: formatCurrency(specialAmt), details: '-', arrear: '-' });

    const flexiAmt = earnings.flexiAmount > 0 ? earnings.flexiAmount : (earnings.earningsMap?.flexi > 0 ? earnings.earningsMap.flexi : 0);
    if (flexiAmt > 0) lineItems.push({ id: 'flexi', name: findComp('flexi')?.name || 'Flexi Allowance', amount: formatCurrency(flexiAmt), details: '-', arrear: '-' });

    const broadbandAmt = earnings.broadband > 0 ? earnings.broadband : (earnings.earningsMap?.broadband > 0 ? earnings.earningsMap.broadband : 0);
    if (broadbandAmt > 0) lineItems.push({ id: 'broadband', name: findComp('broadband')?.name || 'Broadband Allowance', amount: formatCurrency(broadbandAmt), details: '-', arrear: '-' });

    const petrolAmt = earnings.petrol > 0 ? earnings.petrol : (earnings.earningsMap?.petrol > 0 ? earnings.earningsMap.petrol : 0);
    if (petrolAmt > 0) lineItems.push({ id: 'petrol', name: findComp('petrol')?.name || 'Fuel/Petrol Allowance', amount: formatCurrency(petrolAmt), details: '-', arrear: '-' });

    const ltaAmt = earnings.lta > 0 ? earnings.lta : (earnings.earningsMap?.lta > 0 ? earnings.earningsMap.lta : 0);
    if (ltaAmt > 0) lineItems.push({ id: 'lta', name: findComp('lta')?.name || 'Leave Travel Allowance (LTA)', amount: formatCurrency(ltaAmt), details: '-', arrear: '-' });

    const conveyanceAmt = earnings.conveyance > 0 ? earnings.conveyance : (earnings.earningsMap?.conveyance > 0 ? earnings.earningsMap.conveyance : 0);
    if (conveyanceAmt > 0) lineItems.push({ id: 'conveyance', name: findComp('conveyance')?.name || 'Conveyance Allowance', amount: formatCurrency(conveyanceAmt), details: '-', arrear: '-' });

    const medicalAmt = earnings.medicalAllowance > 0 ? earnings.medicalAllowance : (earnings.earningsMap?.medical > 0 ? earnings.earningsMap.medical : 0);
    if (medicalAmt > 0) lineItems.push({ id: 'medical', name: findComp('medical')?.name || 'Medical Allowance', amount: formatCurrency(medicalAmt), details: '-', arrear: '-' });

    // Dynamic earnings in earningsMap not covered above
    if (earnings.earningsMap && typeof earnings.earningsMap === 'object') {
      const standardKeys = [
        'basic', 'hra', 'special', 'specialAllowance', 'flexi', 'flexiAmount',
        'broadband', 'petrol', 'lta', 'conveyance', 'medical', 'medicalAllowance'
      ];
      Object.entries(earnings.earningsMap).forEach(([key, val]) => {
        if (!standardKeys.includes(key) && Number(val) > 0) {
          const comp = findComp(key);
          const formattedName = comp?.name || key
            .replace(/^custom_/, '')
            .replace(/[_-]/g, ' ')
            .replace(/\b\w/g, c => c.toUpperCase());
          lineItems.push({
            id: key,
            name: formattedName,
            amount: formatCurrency(val),
            details: '-',
            arrear: '-'
          });
        }
      });
    }

    if (Array.isArray(earnings.otherEarnings)) {
      earnings.otherEarnings.forEach((item) => {
        if (Number(item.amount) > 0) {
          lineItems.push({ name: item.name || 'Other Allowance', amount: formatCurrency(item.amount), details: '-', arrear: '-' });
        }
      });
    }
  } else if (NON_COMPONENT_TYPES.has(compType)) {
    if (compType !== 'commission_only' || !Array.isArray(earnings.variableCompensation) || earnings.variableCompensation.length === 0) {
      const spec = resolveNonComponentRowSpec(compType, payroll);
      lineItems.push({
        name: spec.name,
        amount: formatCurrency(spec.amount),
        details: spec.details
      });
    }
  }

  if (compType === 'commission_only' || compType === 'salary_plus_commission' || Array.isArray(earnings.variableCompensation)) {
    if (Array.isArray(earnings.variableCompensation) && earnings.variableCompensation.length > 0) {
      earnings.variableCompensation.forEach((v) => {
        const title = v.paymentType ? `Commission (${v.paymentType})` : 'Sales Commission';
        const info = `${v.reference || v.remarks || 'Approved Transaction'}${v.quantity > 1 ? ` (${v.quantity} × ₹${v.rate})` : ''}`;
        lineItems.push({
          name: title,
          amount: formatCurrency(v.amount),
          details: info
        });
      });
    } else if (compType === 'commission_only' && lineItems.length === 0) {
      lineItems.push({
        name: 'Sales Commission',
        amount: formatCurrency(earnings.totalEarnings || earnings.basic || 0),
        details: 'Commission Earnings'
      });
    }
  }

  if (lineItems.length === 0 && (earnings.totalEarnings > 0 || earnings.basic > 0)) {
    lineItems.push({
      name: 'Base Earnings',
      amount: formatCurrency(earnings.totalEarnings || earnings.basic || 0),
      details: 'Compensation Earnings'
    });
  }

  const otAmount = Number(earnings.overtime) || 0;
  if (otAmount > 0) {
    const otObj = periodInput.overtime || payroll.adjustments?.overtime;
    if (typeof otObj === 'object' && otObj !== null) {
      if (Number(otObj.weekdayHours) > 0) {
        lineItems.push({ name: 'Overtime (Weekday)', amount: formatCurrency(roundAmount(otObj.weekdayHours * ((empSnapshot.hourlyRate || 100) * 1.5))), details: `${otObj.weekdayHours} hrs @ 1.5×` });
      }
      if (Number(otObj.weekendHours) > 0) {
        lineItems.push({ name: 'Overtime (Weekend)', amount: formatCurrency(roundAmount(otObj.weekendHours * ((empSnapshot.hourlyRate || 100) * 2.0))), details: `${otObj.weekendHours} hrs @ 2.0×` });
      }
      if (Number(otObj.holidayHours) > 0) {
        lineItems.push({ name: 'Overtime (Holiday)', amount: formatCurrency(roundAmount(otObj.holidayHours * ((empSnapshot.hourlyRate || 100) * 2.0))), details: `${otObj.holidayHours} hrs @ 2.0×` });
      }
      if (lineItems.filter(i => i.name.startsWith('Overtime')).length === 0) {
        lineItems.push({ name: 'Overtime Pay', amount: formatCurrency(otAmount), details: 'Additional Overtime Compensation' });
      }
    } else {
      lineItems.push({ name: 'Overtime Pay', amount: formatCurrency(otAmount), details: 'Additional Overtime Compensation' });
    }
  }

  return lineItems;
}

function buildPayslipDeductionsLineItems(payroll = {}, options = {}) {
  const lineItems = [];
  const deductions = payroll.deductions || {};
  const salaryComponents = options.salaryComponents || options.config?.salaryComponents || payroll.salaryComponents || payroll.payrollConfig?.salaryComponents || [];

  const findComp = (idOrKey) => {
    if (!Array.isArray(salaryComponents) || salaryComponents.length === 0) return null;
    const cleanKey = String(idOrKey || '').toLowerCase().trim();
    return salaryComponents.find(c => {
      if (!c) return false;
      const cId = String(c.id || '').toLowerCase().trim();
      const cName = String(c.name || '').toLowerCase().trim();
      return cId === cleanKey || cName === cleanKey || cleanKey.replace(/^custom_/, '') === cId.replace(/^custom_/, '');
    });
  };

  const pfAmt = Number(deductions.pfEmployee) > 0 ? Number(deductions.pfEmployee) : (Number(deductions.pf) > 0 ? Number(deductions.pf) : 0);
  if (pfAmt > 0) lineItems.push({ id: 'pfEmployee', name: 'PF - Employee Share', amount: roundAmount(pfAmt) });

  const esiAmt = Number(deductions.esiEmployee) > 0 ? Number(deductions.esiEmployee) : (Number(deductions.esi) > 0 ? Number(deductions.esi) : 0);
  if (esiAmt > 0) lineItems.push({ id: 'esiEmployee', name: 'ESI - Employee Share', amount: roundAmount(esiAmt) });

  const ptAmt = Number(deductions.professionalTax) > 0 ? Number(deductions.professionalTax) : (Number(deductions.pt) > 0 ? Number(deductions.pt) : 0);
  if (ptAmt > 0) lineItems.push({ id: 'professionalTax', name: 'Professional Tax (PT)', amount: roundAmount(ptAmt) });

  if (Number(deductions.tds) > 0) lineItems.push({ id: 'tds', name: 'Income Tax (TDS)', amount: roundAmount(deductions.tds) });

  const insAmt = Number(deductions.insuranceEmployee) > 0 ? Number(deductions.insuranceEmployee) : (Number(deductions.insurance) > 0 ? Number(deductions.insurance) : 0);
  if (insAmt > 0) lineItems.push({ id: 'insuranceEmployee', name: 'Insurance Premium', amount: roundAmount(insAmt) });

  const lwfAmt = Number(deductions.lwfEmployee) > 0 ? Number(deductions.lwfEmployee) : (Number(deductions.lwf) > 0 ? Number(deductions.lwf) : 0);
  if (lwfAmt > 0) lineItems.push({ id: 'lwfEmployee', name: 'Labour Welfare Fund (LWF)', amount: roundAmount(lwfAmt) });

  if (Number(deductions.advanceDeduction) > 0) lineItems.push({ id: 'advanceDeduction', name: 'Salary Advance Recovery', amount: roundAmount(deductions.advanceDeduction) });

  if (Array.isArray(deductions.loanRepayments) && deductions.loanRepayments.length > 0) {
    deductions.loanRepayments.forEach((lr) => {
      if (Number(lr.amountApplied) > 0) {
        const ref = lr.loanReference || 'Loan';
        lineItems.push({
          id: 'loanRepayments',
          name: `Loan Repayment (${ref})`,
          amount: roundAmount(lr.amountApplied),
          details: lr.remainingBalance !== undefined ? `Remaining Balance: ₹${lr.remainingBalance}` : ''
        });
      }
    });
  } else if (Number(deductions.loanDeduction) > 0) {
    lineItems.push({ id: 'loanDeduction', name: 'Loan Recovery', amount: roundAmount(deductions.loanDeduction) });
  }

  // Dynamic deductions in deductionsMap (e.g. LTA deduction, custom deductions)
  if (deductions.deductionsMap && typeof deductions.deductionsMap === 'object') {
    const statutoryDeductionKeys = [
      'pfEmployee', 'esiEmployee', 'professionalTax', 'tds', 'insuranceEmployee',
      'lwfEmployee', 'gratuityDeduction', 'loanDeduction', 'advanceDeduction'
    ];
    Object.entries(deductions.deductionsMap).forEach(([key, val]) => {
      if (!statutoryDeductionKeys.includes(key) && Number(val) > 0) {
        const comp = findComp(key);
        let name = comp?.name;
        if (!name) {
          if (key === 'lta') name = 'Leave Travel Allowance (LTA)';
          else if (key === 'broadband') name = 'Broadband Deduction';
          else if (key === 'petrol') name = 'Fuel/Petrol Deduction';
          else if (key === 'flexi' || key === 'flexiAmount') name = 'Flexi Deduction';
          else {
            name = key
              .replace(/^custom_/, '')
              .replace(/[_-]/g, ' ')
              .replace(/\b\w/g, c => c.toUpperCase());
          }
        }
        lineItems.push({
          id: key,
          name,
          amount: roundAmount(val),
          details: ''
        });
      }
    });
  }

  if (Array.isArray(deductions.otherDeductions)) {
    deductions.otherDeductions.forEach(d => {
      if (Number(d.amount) > 0) {
        lineItems.push({ name: d.name || 'Other Deduction', amount: roundAmount(d.amount) });
      }
    });
  }

  return lineItems;
}

function buildPayslipEmployerContributionsLineItems(payroll = {}, options = {}) {
  const lineItems = [];
  const empContrib = payroll.employerContributions || {};
  const emp = payroll.employee || payroll.employeeSnapshot || {};

  const pfEmployer = Number(empContrib.pfEmployer) || 0;
  if (pfEmployer > 0) {
    lineItems.push({
      id: 'pfEmployer',
      name: 'Provident Fund (Employer PF)',
      amount: roundAmount(pfEmployer),
      details: 'Employer PF Contribution'
    });
  }

  const insuranceEmployer = Number(empContrib.insuranceEmployer) || Number(payroll.insurance) || Number(emp.insuranceAmount) || 0;
  if (insuranceEmployer > 0) {
    lineItems.push({
      id: 'insuranceEmployer',
      name: 'Insurance Amount',
      amount: roundAmount(insuranceEmployer),
      details: 'Group / Medical Insurance'
    });
  }

  const esiEmployer = Number(empContrib.esiEmployer) || 0;
  if (esiEmployer > 0) {
    lineItems.push({
      id: 'esiEmployer',
      name: 'ESI (Employer Share)',
      amount: roundAmount(esiEmployer),
      details: 'Employee State Insurance'
    });
  }

  const gratuity = Number(empContrib.gratuity) || 0;
  if (gratuity > 0) {
    lineItems.push({
      id: 'gratuity',
      name: 'Gratuity Provision',
      amount: roundAmount(gratuity),
      details: 'Retirement Gratuity'
    });
  }

  const lwfEmployer = Number(empContrib.lwfEmployer) || 0;
  if (lwfEmployer > 0) {
    lineItems.push({
      id: 'lwfEmployer',
      name: 'Labour Welfare Fund (Employer)',
      amount: roundAmount(lwfEmployer),
      details: 'LWF Contribution'
    });
  }

  const nps = Number(empContrib.nps) || 0;
  if (nps > 0) {
    lineItems.push({
      id: 'nps',
      name: 'Employer NPS',
      amount: roundAmount(nps),
      details: 'National Pension Scheme'
    });
  }

  return lineItems;
}

module.exports = {
  buildPayslipEarningsLineItems,
  buildPayslipDeductionsLineItems,
  buildPayslipEmployerContributionsLineItems,
};
