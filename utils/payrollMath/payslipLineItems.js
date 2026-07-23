/**
 * utils/payrollMath/payslipLineItems.js
 *
 * Formats earnings and deductions line items for payslip serialization.
 */

const { roundAmount } = require('../money');

function buildPayslipEarningsLineItems(payroll = {}) {
  const lineItems = [];
  const earnings = payroll.earnings || {};
  const periodInput = payroll.periodInput || {};
  const empSnapshot = payroll.employeeSnapshot || {};
  const emp = payroll.employee || {};

  const compType = empSnapshot.compensationType || emp.compensationType || (payroll.payType === 'hourly' ? 'hourly' : 'monthly_salary');

  const formatCurrency = (val) => Number(val) || 0;

  if (['monthly_salary', 'attendance_based', 'salary_plus_commission'].includes(compType)) {
    if (earnings.basic > 0) lineItems.push({ name: 'Basic Salary', amount: formatCurrency(earnings.basic), details: 'Core Basic Earnings' });
    if (earnings.hra > 0) lineItems.push({ name: 'House Rent Allowance (HRA)', amount: formatCurrency(earnings.hra), details: 'Housing Exemption Component' });
    if (earnings.specialAllowance > 0) lineItems.push({ name: 'Special Allowance', amount: formatCurrency(earnings.specialAllowance), details: 'Special Component' });
    if (earnings.flexiAmount > 0) lineItems.push({ name: 'Flexi Allowance', amount: formatCurrency(earnings.flexiAmount), details: 'Flexible Component' });
    if (earnings.broadband > 0) lineItems.push({ name: 'Broadband Allowance', amount: formatCurrency(earnings.broadband), details: 'Internet Allowance' });
    if (earnings.petrol > 0) lineItems.push({ name: 'Fuel/Petrol Allowance', amount: formatCurrency(earnings.petrol), details: 'Travel Reimbursement' });
    if (earnings.lta > 0) lineItems.push({ name: 'Leave Travel Allowance (LTA)', amount: formatCurrency(earnings.lta), details: 'Travel Concession' });
    if (earnings.conveyance > 0) lineItems.push({ name: 'Conveyance Allowance', amount: formatCurrency(earnings.conveyance), details: 'Commute Allowance' });
    if (earnings.medicalAllowance > 0) lineItems.push({ name: 'Medical Allowance', amount: formatCurrency(earnings.medicalAllowance), details: 'Medical Cover' });

    if (Array.isArray(earnings.otherEarnings)) {
      earnings.otherEarnings.forEach((item) => {
        if (Number(item.amount) > 0) {
          lineItems.push({ name: item.name || 'Other Allowance', amount: formatCurrency(item.amount), details: 'Custom Allowance' });
        }
      });
    }
  } else if (compType === 'hourly' || compType === 'timesheet_based') {
    const hours = Number(payroll.hoursWorked) || Number(periodInput.hoursWorked) || Number(periodInput.hoursLogged) || 0;
    const rate = Number(payroll.hourlyRate) || Number(empSnapshot.hourlyRate) || Number(emp.hourlyRate) || 0;
    const total = earnings.totalEarnings || earnings.basic || roundAmount(hours * rate);
    lineItems.push({
      name: compType === 'timesheet_based' ? 'Timesheet Logged Hours Pay' : 'Hourly Wages',
      amount: formatCurrency(total),
      details: `${hours} hrs × ₹${rate}/hr`
    });
  } else if (compType === 'daily_wage') {
    const days = Number(payroll.paidDays) || Number(periodInput.daysWorked) || 0;
    const rate = Number(empSnapshot.dailyRate) || Number(emp.dailyRate) || (days > 0 ? roundAmount(earnings.totalEarnings / days) : 0);
    const total = earnings.totalEarnings || earnings.basic || roundAmount(days * rate);
    lineItems.push({
      name: 'Daily Wage Earnings',
      amount: formatCurrency(total),
      details: `${days} days × ₹${rate}/day`
    });
  } else if (compType === 'piece_rate') {
    const units = Number(periodInput.unitsProduced) || 0;
    const rate = Number(periodInput.ratePerUnit) || Number(empSnapshot.rateCard?.[0]?.rate) || Number(emp.rateCard?.[0]?.rate) || 0;
    const unitType = periodInput.unitType || empSnapshot.rateCard?.[0]?.paymentType || 'Units';
    const total = earnings.totalEarnings || earnings.basic || roundAmount(units * rate);
    lineItems.push({
      name: `${unitType} Output Pay`,
      amount: formatCurrency(total),
      details: `${units} units × ₹${rate}/unit`
    });
  } else if (compType === 'project_based') {
    const fee = Number(periodInput.projectFee) || earnings.totalEarnings || earnings.basic || 0;
    const ref = periodInput.projectRef || periodInput.description || '';
    lineItems.push({
      name: `Project Fee${ref ? ` — ${ref}` : ''}`,
      amount: formatCurrency(fee),
      details: 'Approved Project Deliverable Fee'
    });
  } else if (compType === 'milestone_based') {
    const amt = Number(periodInput.milestoneAmount) || earnings.totalEarnings || earnings.basic || 0;
    const ref = periodInput.milestoneRef || '';
    lineItems.push({
      name: `Milestone Deliverable${ref ? `: ${ref}` : ''}`,
      amount: formatCurrency(amt),
      details: 'Completed Milestone Payment'
    });
  } else if (compType === 'retainer') {
    const amt = earnings.totalEarnings || earnings.basic || 0;
    lineItems.push({
      name: 'Monthly Retainer Fee',
      amount: formatCurrency(amt),
      details: 'Fixed Service Retainer Contract'
    });
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

function buildPayslipDeductionsLineItems(payroll = {}) {
  const lineItems = [];
  const deductions = payroll.deductions || {};

  if (Number(deductions.pfEmployee) > 0) lineItems.push({ name: 'PF - Employee Share', amount: roundAmount(deductions.pfEmployee) });
  if (Number(deductions.esiEmployee) > 0) lineItems.push({ name: 'ESI - Employee Share', amount: roundAmount(deductions.esiEmployee) });
  if (Number(deductions.professionalTax) > 0) lineItems.push({ name: 'Professional Tax (PT)', amount: roundAmount(deductions.professionalTax) });
  if (Number(deductions.tds) > 0) lineItems.push({ name: 'Income Tax (TDS)', amount: roundAmount(deductions.tds) });
  if (Number(deductions.insuranceEmployee) > 0) lineItems.push({ name: 'Insurance Premium', amount: roundAmount(deductions.insuranceEmployee) });
  if (Number(deductions.lwfEmployee) > 0) lineItems.push({ name: 'Labour Welfare Fund (LWF)', amount: roundAmount(deductions.lwfEmployee) });
  if (Number(deductions.advanceDeduction) > 0) lineItems.push({ name: 'Salary Advance Recovery', amount: roundAmount(deductions.advanceDeduction) });

  if (Array.isArray(deductions.loanRepayments) && deductions.loanRepayments.length > 0) {
    deductions.loanRepayments.forEach((lr) => {
      if (Number(lr.amountApplied) > 0) {
        const ref = lr.loanReference || 'Loan';
        lineItems.push({
          name: `Loan Repayment (${ref})`,
          amount: roundAmount(lr.amountApplied),
          details: lr.remainingBalance !== undefined ? `Remaining Balance: ₹${lr.remainingBalance}` : ''
        });
      }
    });
  } else if (Number(deductions.loanDeduction) > 0) {
    lineItems.push({ name: 'Loan Recovery', amount: roundAmount(deductions.loanDeduction) });
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

module.exports = {
  buildPayslipEarningsLineItems,
  buildPayslipDeductionsLineItems,
};
