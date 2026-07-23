/**
 * controllers/payroll/common.js
 *
 * Shared helper utilities for payroll controller modules.
 */

const PayrollConfig = require('../../models/PayrollConfig');
const Category = require('../../models/Category');
const { sumNamedAmounts } = require('../../utils/money');

const monthName = (month) => new Date(0, Number(month) - 1).toLocaleString('en-US', { month: 'long' });

const buildEmployeeName = (employee, snapshot) => {
  const first = employee?.firstName || snapshot?.firstName || '';
  const last = employee?.lastName || snapshot?.lastName || '';
  return `${first} ${last}`.trim() || 'Unknown Employee';
};

const isValidMonth = (month) => Number.isInteger(month) && month >= 1 && month <= 12;
const isValidYear = (year) => Number.isInteger(year) && year >= 1970 && year <= 3000;

const getOrCreateConfig = async (userId, targetDate = new Date()) => {
  const dateObj = new Date(targetDate);
  let config = await PayrollConfig.findOne({
    user: userId,
    effectiveFrom: { $lte: dateObj }
  }).sort({ effectiveFrom: -1, createdAt: -1 });

  if (!config) {
    config = await PayrollConfig.findOne({ user: userId }).sort({ effectiveFrom: 1 });
    if (!config) {
      config = await PayrollConfig.create({ user: userId, effectiveFrom: new Date('2020-01-01') });
    }
  }
  return config;
};

const getPayrollCategory = async (userId) => Category.findOneAndUpdate(
  { user: userId, name: 'Payroll', type: 'expense' },
  {
    $setOnInsert: {
      user: userId,
      name: 'Payroll',
      type: 'expense',
      isSystem: true,
      color: '#2563eb',
      icon: 'FaUsers',
    },
  },
  { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
);

const shouldExcludeEmployeeFromRun = (employee) => employee.status !== 'active' || Boolean(employee.dateOfLeaving);

const shouldApplyJoiningBonus = (employee, month, year) => {
  if (!employee?.joiningDate || !Number(employee.joiningBonus)) return false;
  const joiningDate = new Date(employee.joiningDate);
  return joiningDate.getMonth() + 1 === month && joiningDate.getFullYear() === year;
};

const buildAttendancePayload = (payload = {}, defaultWorkingDays = 26) => {
  const workingDays = Math.max(Number(payload.workingDays) || defaultWorkingDays, 1);
  const paidLeaves = Math.max(Number(payload.paidLeaves) || 0, 0);
  const unpaidLeaves = Math.max(Number(payload.unpaidLeaves) || 0, 0);
  const paidDaysInput = payload.paidDays ?? payload.presentDays ?? workingDays - unpaidLeaves;
  const paidDays = Math.max(Math.min(Number(paidDaysInput) || 0, workingDays), 0);
  const hoursWorked = Number(payload.hoursWorked) || 0;

  return {
    workingDays,
    paidDays,
    paidLeaves,
    unpaidLeaves,
    hoursWorked,
  };
};

const buildAdjustmentsPayload = (employee, payload = {}, month, year) => {
  const adjustments = payload.adjustments && typeof payload.adjustments === 'object'
    ? { ...payload.adjustments }
    : {};

  ['daysWorked', 'unitsProduced', 'hoursLogged', 'hoursWorked', 'projectFee', 'milestoneAmount', 'ratePerUnit'].forEach(field => {
    if (adjustments[field] === undefined && payload[field] !== undefined) {
      adjustments[field] = payload[field];
    }
  });

  if (payload.periodInput && typeof payload.periodInput === 'object') {
    Object.assign(adjustments, payload.periodInput);
  }

  if (shouldApplyJoiningBonus(employee, month, year)) {
    adjustments.joiningBonus = Number(employee.joiningBonus);
  }

  return adjustments;
};

module.exports = {
  monthName,
  buildEmployeeName,
  isValidMonth,
  isValidYear,
  sumNamedAmounts,
  getOrCreateConfig,
  getPayrollCategory,
  shouldExcludeEmployeeFromRun,
  shouldApplyJoiningBonus,
  buildAttendancePayload,
  buildAdjustmentsPayload,
};
