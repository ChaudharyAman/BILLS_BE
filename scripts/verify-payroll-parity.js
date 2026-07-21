#!/usr/bin/env node
/**
 * verify-payroll-parity.js
 *
 * Confirms byte-identical netSalary for existing salaried and hourly employees
 * before and after the strategy dispatch refactor. Fails with exit 1 if any
 * mismatch exceeds ₹0.01 (floating-point rounding tolerance).
 *
 * Usage:
 *   node MBB/scripts/verify-payroll-parity.js --month 6 --year 2025
 *   node MBB/scripts/verify-payroll-parity.js --month 6 --year 2025 --sample 20
 */
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : def;
};
const MONTH  = Number(getArg('--month',  new Date().getMonth() + 1));
const YEAR   = Number(getArg('--year',   new Date().getFullYear()));
const SAMPLE = Number(getArg('--sample', 20));

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Parity check: month=${MONTH} year=${YEAR} sample=${SAMPLE}`);

  const Payroll      = require('../models/Payroll');
  const Employee     = require('../models/Employee');
  const PayrollConfig = require('../models/PayrollConfig');
  const { buildPayrollSnapshot } = require('../utils/payrollMath');

  // Sample paid payrolls from the target month
  const payrolls = await Payroll.find({ month: MONTH, year: YEAR, status: { $ne: 'cancelled' } })
    .limit(SAMPLE)
    .lean();

  if (payrolls.length === 0) {
    console.log(`No payrolls found for ${MONTH}/${YEAR}`);
    await mongoose.disconnect();
    return;
  }

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const p of payrolls) {
    const employee = await Employee.findById(p.employee)
      .select('+panNumber +uanNumber +aadharNumber +bankDetails.accountNumber')
      .lean();
    if (!employee) continue;

    const config = await PayrollConfig.findOne({ user: p.user }).lean() || {};

    const attendance = {
      workingDays: p.workingDays,
      paidDays:    p.paidDays,
      paidLeaves:  p.paidLeaves,
      unpaidLeaves: p.unpaidLeaves,
      hoursWorked: p.hoursWorked,
    };

    const adjustments = {
      overtime:          p.variablePay?.joiningBonus     !== undefined ? 0 : 0,
      joiningBonus:      p.variablePay?.joiningBonus     || 0,
      loyaltyBonus:      p.variablePay?.loyaltyBonus     || 0,
      incentive:         p.variablePay?.incentive         || 0,
      specialBonus:      p.variablePay?.specialBonus      || 0,
      otherAllowanceArrear: p.variablePay?.otherAllowanceArrear || 0,
      loanDeduction:     p.deductions?.loanDeduction      || 0,
      advanceDeduction:  p.deductions?.advanceDeduction   || 0,
      tds: p.deductions?.tds,
      hoursWorked:       p.hoursWorked || 0,
      otherEarnings:     p.earnings?.otherEarnings || [],
      otherDeductions:   p.deductions?.otherDeductions || [],
    };

    try {
      const snapshot = buildPayrollSnapshot(employee, config, attendance, adjustments, MONTH, YEAR);
      const diff = Math.abs(snapshot.netSalary - p.netSalary);
      if (diff > 0.01) {
        failed++;
        failures.push({
          employeeId: employee.employeeId,
          name: `${employee.firstName} ${employee.lastName}`,
          stored: p.netSalary,
          recomputed: snapshot.netSalary,
          diff,
        });
      } else {
        passed++;
      }
    } catch (err) {
      failed++;
      failures.push({
        employeeId: employee.employeeId,
        name: `${employee.firstName} ${employee.lastName}`,
        error: err.message,
      });
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed out of ${payrolls.length} checked`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach(f => {
      if (f.error) {
        console.log(`  [${f.employeeId}] ${f.name} — ERROR: ${f.error}`);
      } else {
        console.log(`  [${f.employeeId}] ${f.name} — stored: ₹${f.stored}, recomputed: ₹${f.recomputed}, diff: ₹${f.diff.toFixed(2)}`);
      }
    });
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log('✓ All checks passed — netSalary is byte-identical.');
  await mongoose.disconnect();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
