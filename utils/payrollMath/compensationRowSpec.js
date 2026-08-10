/**
 * utils/payrollMath/compensationRowSpec.js
 *
 * Single authoritative helper defining row specifications (name, label, details, amount)
 * for all non-component compensation types (hourly, daily_wage, piece_rate, project_based,
 * milestone_based, retainer, commission_only, etc.).
 *
 * Used by both payslipLineItems.js and taxWorksheet.js to eliminate duplicated branching.
 */

'use strict';

const { roundAmount } = require('../money');

/**
 * Pay types whose gross earnings are treated as a single non-component amount
 * without discrete component breakdowns (Basic, HRA, Flexi, etc.).
 */
const NON_COMPONENT_TYPES = new Set([
  'hourly',
  'timesheet_based',
  'daily_wage',
  'piece_rate',
  'project_based',
  'milestone_based',
  'retainer',
  'commission_only',
]);

/**
 * Resolves the line-item name, details, and amount for a non-component compensation type.
 *
 * @param {string} compType
 * @param {object} payroll - Payroll record or snapshot
 * @returns {{ name: string, details: string, amount: number }}
 */
function resolveNonComponentRowSpec(compType, payroll = {}) {
  const earnings = payroll.earnings || {};
  const periodInput = payroll.periodInput || {};
  const empSnapshot = payroll.employeeSnapshot || {};
  const emp = payroll.employee || {};

  let name = 'Base Earnings';
  let details = 'Compensation Earnings';
  let amount = Number(earnings.totalEarnings || earnings.basic || 0);

  switch (compType) {
    case 'hourly':
    case 'timesheet_based': {
      const hours = Number(payroll.hoursWorked) || Number(periodInput.hoursWorked) || Number(periodInput.hoursLogged) || 0;
      const rate = Number(payroll.hourlyRate) || Number(empSnapshot.hourlyRate) || Number(emp.hourlyRate) || 0;
      amount = Number(earnings.totalEarnings || earnings.basic || roundAmount(hours * rate));
      name = compType === 'timesheet_based' ? 'Timesheet Logged Hours Pay' : 'Hourly Wages';
      details = `${hours} hrs × ₹${rate}/hr`;
      break;
    }
    case 'daily_wage': {
      const days = Number(payroll.paidDays) || Number(periodInput.daysWorked) || 0;
      const rate = Number(empSnapshot.dailyRate) || Number(emp.dailyRate) || (days > 0 ? roundAmount(earnings.totalEarnings / days) : 0);
      amount = Number(earnings.totalEarnings || earnings.basic || roundAmount(days * rate));
      name = 'Daily Wage Earnings';
      details = `${days} days × ₹${rate}/day`;
      break;
    }
    case 'piece_rate': {
      const units = Number(periodInput.unitsProduced) || 0;
      const rate = Number(periodInput.ratePerUnit) || Number(empSnapshot.rateCard?.[0]?.rate) || Number(emp.rateCard?.[0]?.rate) || 0;
      const unitType = periodInput.unitType || empSnapshot.rateCard?.[0]?.paymentType || 'Units';
      amount = Number(earnings.totalEarnings || earnings.basic || roundAmount(units * rate));
      name = `${unitType} Output Pay`;
      details = `${units} units × ₹${rate}/unit`;
      break;
    }
    case 'project_based': {
      const fee = Number(periodInput.projectFee) || Number(earnings.totalEarnings || earnings.basic || 0);
      const ref = periodInput.projectRef || periodInput.description || '';
      amount = fee;
      name = `Project Fee${ref ? ` — ${ref}` : ''}`;
      details = 'Approved Project Deliverable Fee';
      break;
    }
    case 'milestone_based': {
      const amt = Number(periodInput.milestoneAmount) || Number(earnings.totalEarnings || earnings.basic || 0);
      const ref = periodInput.milestoneRef || '';
      amount = amt;
      name = `Milestone Deliverable${ref ? `: ${ref}` : ''}`;
      details = 'Completed Milestone Payment';
      break;
    }
    case 'retainer': {
      amount = Number(earnings.totalEarnings || earnings.basic || 0);
      name = 'Monthly Retainer Fee';
      details = 'Fixed Service Retainer Contract';
      break;
    }
    case 'commission_only': {
      let commAmt = 0;
      if (Array.isArray(earnings.variableCompensation) && earnings.variableCompensation.length > 0) {
        commAmt = earnings.variableCompensation.reduce((sum, v) => sum + (Number(v.amount) || 0), 0);
      }
      amount = commAmt || Number(earnings.totalEarnings || earnings.basic || 0);
      name = 'Commission Earnings';
      details = 'Commission Earnings';
      break;
    }
  }

  return { name, details, amount };
}

module.exports = {
  NON_COMPONENT_TYPES,
  resolveNonComponentRowSpec,
};
