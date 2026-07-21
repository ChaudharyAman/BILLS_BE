#!/usr/bin/env node
/**
 * migrate-compensation-fields.js
 *
 * One-shot migration: sets compensationType, payFrequency, attendanceMode
 * on all Employee documents and their salaryRevisions[] subdocuments.
 *
 * Safe to re-run — uses $set only; never overwrites an already-set compensationType.
 *
 * Usage:
 *   node MBB/scripts/migrate-compensation-fields.js
 *   node MBB/scripts/migrate-compensation-fields.js --dry-run
 */
'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const { deriveCompensationTypeFromLegacy } = require('../utils/payrollStrategies/index');

const DRY_RUN = process.argv.includes('--dry-run');

function deriveAttendanceMode(compensationType) {
  const map = {
    hourly:                 'timesheet',
    daily_wage:             'attendance',
    piece_rate:             'unit_count',
    project_based:          'fixed',
    milestone_based:        'none',
    attendance_based:       'attendance',
    timesheet_based:        'timesheet',
    commission_only:        'none',
    salary_plus_commission: 'attendance',
    retainer:               'fixed',
    monthly_salary:         'attendance',
    weekly_salary:          'attendance',
  };
  return map[compensationType] || 'attendance';
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to MongoDB${DRY_RUN ? ' (DRY RUN — no writes)' : ''}`);

  const Employee = require('../models/Employee');
  const cursor = Employee.find({
    $or: [
      { compensationType: null },
      { compensationType: { $exists: false } },
    ],
  }).cursor();

  let processed = 0;
  let revisionsUpdated = 0;
  const bulkOps = [];

  for await (const emp of cursor) {
    const ct = deriveCompensationTypeFromLegacy({
      payType: emp.payType,
      compensationModel: emp.compensationModel,
      employmentType: emp.employmentType,
    });
    const am = deriveAttendanceMode(ct);

    // Build $set for top-level fields
    const topLevelSet = {
      compensationType: ct,
      payFrequency: emp.payFrequency || 'monthly',
      attendanceMode: am,
    };

    // Build arrayFilters update for salaryRevisions that lack compensationType
    const revisionsWithoutCT = (emp.salaryRevisions || []).filter(
      r => !r.compensationType
    );

    if (revisionsWithoutCT.length > 0) {
      revisionsUpdated += revisionsWithoutCT.length;
      // Set compensationType on each revision using the parent employee's derived type
      // (closest reasonable proxy for historical accuracy)
      revisionsWithoutCT.forEach(rev => {
        const revCT = deriveCompensationTypeFromLegacy({
          payType: rev.payType || emp.payType,
          compensationModel: rev.compensationModel || emp.compensationModel,
          employmentType: rev.employmentType || emp.employmentType,
        });
        topLevelSet[`salaryRevisions.$[rev].compensationType`] = revCT;
        topLevelSet[`salaryRevisions.$[rev].attendanceMode`] = deriveAttendanceMode(revCT);
        topLevelSet[`salaryRevisions.$[rev].payFrequency`] = 'monthly';
      });
    }

    bulkOps.push({
      updateOne: {
        filter: { _id: emp._id, compensationType: { $in: [null, undefined] } },
        update: { $set: topLevelSet },
        arrayFilters: revisionsWithoutCT.length > 0
          ? [{ 'rev.compensationType': { $in: [null, undefined] } }]
          : [],
      },
    });
    processed++;

    if (bulkOps.length >= 500) {
      if (!DRY_RUN) await Employee.bulkWrite(bulkOps);
      bulkOps.length = 0;
      process.stdout.write('.');
    }
  }

  if (bulkOps.length > 0 && !DRY_RUN) {
    await Employee.bulkWrite(bulkOps);
  }

  console.log(`\n✓ Employees processed : ${processed}`);
  console.log(`✓ Revisions touched   : ${revisionsUpdated}`);
  if (DRY_RUN) console.log('DRY RUN — nothing written.');

  await mongoose.disconnect();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
