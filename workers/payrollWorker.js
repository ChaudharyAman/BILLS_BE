/**
 * payrollWorker.js
 *
 * Asynchronous worker module for processing bulk payroll jobs in background.
 * Reuses per-employee transactional safety (runTransaction) and updates durable
 * progress in PayrollBatchRun for real-time frontend polling.
 */

const mongoose = require('mongoose');
const Payroll = require('../models/Payroll');
const Employee = require('../models/Employee');
const Settings = require('../models/Settings');
const PayrollConfig = require('../models/PayrollConfig');
const Loan = require('../models/Loan');
const ReimbursementClaim = require('../models/ReimbursementClaim');
const AuditLog = require('../models/AuditLog');
const PayrollBatchRun = require('../models/PayrollBatchRun');
const hrmsSyncService = require('../services/hrmsSyncService');
const { runTransaction } = require('../utils/withTransaction');
const {
  roundAmount,
  buildPayrollSnapshot,
  getOrCreateConfig,
} = require('../utils/payrollMath');

const buildEmployeeName = (employee) => {
  const first = employee?.firstName || '';
  const last = employee?.lastName || '';
  return `${first} ${last}`.trim() || 'Unknown Employee';
};

const shouldExcludeEmployeeFromRun = (employee) => {
  if (employee?.status === 'inactive' || employee?.status === 'terminated') return true;
  if (employee?.dateOfLeaving && new Date(employee.dateOfLeaving) <= new Date()) return true;
  return false;
};

const buildAttendancePayload = (payload, defaultWorkingDays = 30) => ({
  workingDays: Number(payload.workingDays) || defaultWorkingDays,
  paidDays: Number(payload.paidDays) || 0,
  paidLeaves: Number(payload.paidLeaves) || 0,
  unpaidLeaves: Number(payload.unpaidLeaves) || 0,
  hoursWorked: Number(payload.hoursWorked) || 0,
});

const buildAdjustmentsPayload = (employee, payload, month, year) => {
  const adj = payload.adjustments || {};
  return {
    daysWorked: payload.periodInput?.daysWorked ?? payload.daysWorked ?? adj.daysWorked,
    unitsProduced: payload.periodInput?.unitsProduced ?? payload.unitsProduced ?? adj.unitsProduced,
    hoursLogged: payload.periodInput?.hoursLogged ?? payload.hoursLogged ?? adj.hoursLogged,
    projectFee: payload.periodInput?.projectFee ?? payload.projectFee ?? adj.projectFee,
    projectRef: payload.periodInput?.projectRef ?? payload.projectRef ?? adj.projectRef,
    milestoneAmount: payload.periodInput?.milestoneAmount ?? payload.milestoneAmount ?? adj.milestoneAmount,
    milestoneRef: payload.periodInput?.milestoneRef ?? payload.milestoneRef ?? adj.milestoneRef,
    ratePerUnit: payload.periodInput?.ratePerUnit ?? payload.ratePerUnit ?? adj.ratePerUnit,
    hoursWorked: payload.periodInput?.hoursWorked ?? payload.hoursWorked ?? adj.hoursWorked,
    overtime: payload.periodInput?.overtime ?? payload.overtime ?? adj.overtime,
    lopStrategy: adj.lopStrategy || payload.lopStrategy || 'proportional',
    segmentLops: adj.segmentLops || payload.segmentLops || [],
    loanDeduction: adj.loanDeduction,
    otherEarnings: adj.otherEarnings || [],
    otherDeductions: adj.otherDeductions || [],
  };
};

async function processBatchJob({ jobId, userId, month, year, employeePayloads = [], saveAsDraft = false }) {
  try {
    if (mongoose.connection.readyState === 1) {
      await PayrollBatchRun.updateOne(
        { jobId },
        { $set: { status: 'processing', startedAt: new Date(), total: employeePayloads.length } }
      );
    }

    const config = await getOrCreateConfig(userId, new Date(year, month - 1, 1));
    const settings = await Settings.findOne({ user: userId });

    let hrmsAttendanceRecords = null;
    let hrmsSyncError = null;
    if (settings?.integration?.enabled) {
      try {
        hrmsAttendanceRecords = await hrmsSyncService.syncAttendanceFromExternal(userId, month, year);
      } catch (err) {
        hrmsSyncError = err.message;
      }
    }

    const success = [];
    const errors = [];
    const skippedNoActivity = [];

    const totalCount = employeePayloads.length;

    // ponytail: concurrency=5, increase if DB/CPU headroom allows
    const CONCURRENCY = 5;

    const processOneEmployee = async (payload) => {
      const employeeId = payload.employeeId || payload.employee;
      let employeeName = 'Unknown Employee';

      try {
        if (!mongoose.Types.ObjectId.isValid(String(employeeId))) {
          errors.push({ employeeId, error: 'Invalid employee ID format' });
          return;
        }

        const employee = await Employee.findOne({ _id: employeeId, user: userId });
        if (!employee) {
          errors.push({ employeeId, error: 'Employee not found' });
          return;
        }

        employeeName = buildEmployeeName(employee);
        if (shouldExcludeEmployeeFromRun(employee)) {
          errors.push({ employeeId, employeeName, error: 'Employee is inactive or has a date of leaving set' });
          return;
        }

        if (
          payload.skip === true ||
          payload._skipPeriod === true ||
          payload.skipPeriod === true ||
          payload.adjustments?.skip === true ||
          payload.adjustments?._skipPeriod === true ||
          payload.adjustments?.skipPeriod === true
        ) {
          skippedNoActivity.push({
            employeeId,
            employeeName,
            compensationType: employee.compensationType || 'monthly_salary',
            message: 'Marked skip for this period'
          });
          return;
        }

        const attendance = buildAttendancePayload(payload, config.defaultWorkingDays);
        const adjustments = buildAdjustmentsPayload(employee, payload, month, year);

        // Bug 3 guard: validate custom LOP segmentLops before they reach getSegmentLops().
        // getSegmentLops() clamps each value independently but never checks the total, so a
        // mismatch silently produces wrong per-segment LOP without any error signal.
        if (adjustments.lopStrategy === 'custom' && Array.isArray(adjustments.segmentLops) && adjustments.segmentLops.length > 0) {
          const submittedSum = adjustments.segmentLops.reduce((s, v) => s + (Number(v) || 0), 0);
          const expectedTotal = Math.max(0, attendance.workingDays - attendance.paidDays);
          // Round to 2 decimal places to avoid floating-point noise when comparing.
          const diff = Math.abs(Math.round((submittedSum - expectedTotal) * 100) / 100);
          if (diff > 0) {
            errors.push({
              employeeId,
              employeeName,
              error: `Custom LOP split total (${submittedSum} days) does not match expected LOP (${expectedTotal} days = workingDays ${attendance.workingDays} - paidDays ${attendance.paidDays}). Correct the segmentLops values and resubmit.`,
            });
            return;
          }
        }

        const startDate = new Date(year, month - 1, 1);
        const endDate = new Date(year, month, 1);

        const PayrollVariableTransaction = require('../models/PayrollVariableTransaction');
        const transactions = await PayrollVariableTransaction.find({
          employee: employee._id,
          user: userId,
          status: 'approved',
          date: { $gte: startDate, $lt: endDate }
        });
        adjustments.variableTransactions = transactions;

        const { resolveCompensationType } = require('../utils/payrollStrategies/index');
        const compType = resolveCompensationType(employee);

        if (['commission', 'commission_only', 'project_based', 'milestone_based'].includes(compType)) {
          let hasActivity = false;
          if (compType === 'commission' || compType === 'commission_only') {
            hasActivity = (adjustments.variableTransactions || []).some(t => !t.paymentType || t.paymentType === 'COMMISSION' || t.paymentType === 'PERCENTAGE');
          } else if (compType === 'project_based') {
            const hasTx = (adjustments.variableTransactions || []).some(t => t.paymentType === 'PROJECT');
            const hasFee = Number(adjustments.projectFee) > 0;
            const hasRateCard = (employee.rateCard || []).some(r => r.paymentType === 'PROJECT' && Number(r.rate) > 0);
            hasActivity = hasTx || hasFee || hasRateCard;
          } else if (compType === 'milestone_based') {
            const hasTx = (adjustments.variableTransactions || []).some(t => t.paymentType === 'MILESTONE');
            const hasMilestone = Number(adjustments.milestoneAmount) > 0;
            hasActivity = hasTx || hasMilestone;
          }

          if (!hasActivity) {
            skippedNoActivity.push({
              employeeId,
              employeeName,
              compensationType: compType,
              message: 'No matching variable transactions or activity for this period'
            });
            return;
          }
        }

        const claims = await ReimbursementClaim.find({
          employee: employee._id,
          user: userId,
          status: 'approved',
          createdAt: { $gte: startDate, $lt: endDate }
        }).lean();

        const reqReimbursements = payload.adjustments?.reimbursements;
        let finalClaims = claims;
        if (reqReimbursements !== undefined) {
          const includedIds = new Set(reqReimbursements.map(r => String(r._id || r.claimId)));
          finalClaims = claims.filter(c => includedIds.has(String(c._id)));
        }

        adjustments.reimbursements = finalClaims.map(c => ({
          _id: c._id,
          name: c.category,
          claimed: c.amount,
          approved: c.amount,
          billUrl: c.billUrl || ''
        }));

        const activeLoans = await Loan.find({
          employee: employee._id,
          user: userId,
          status: 'active',
          remainingBalance: { $gt: 0 }
        }).sort({ createdAt: 1 });

        if (adjustments.loanDeduction === undefined || adjustments.loanDeduction === null) {
          adjustments.loanDeduction = activeLoans.reduce((sum, loan) => sum + Math.min(loan.emiAmount, loan.remainingBalance), 0);
        }

        let remLoanDeduction = Number(adjustments.loanDeduction) || 0;
        const loanRepayments = [];
        for (const loan of activeLoans) {
          if (remLoanDeduction <= 0) break;
          const applied = Math.min(loan.remainingBalance, loan.emiAmount, remLoanDeduction);
          if (applied > 0) {
            const remAfter = Math.max(0, roundAmount(loan.remainingBalance - applied));
            loanRepayments.push({
              loanId: loan._id,
              loanReference: loan.loanNumber || loan.purpose || `Loan #${String(loan._id).slice(-4)}`,
              amountApplied: roundAmount(applied),
              remainingBalance: remAfter
            });
            remLoanDeduction = roundAmount(remLoanDeduction - applied);
          }
        }

        const snapshot = buildPayrollSnapshot(employee, config, attendance, adjustments, month, year);
        snapshot.deductions.loanRepayments = loanRepayments;
        const statusVal = saveAsDraft ? 'draft' : 'processed';

        await runTransaction(async (session) => {
          const sessionOpt = session ? { session } : {};

          const existing = await Payroll.findOne({ user: userId, employee: employeeId, month, year }, null, sessionOpt);
          if (existing) {
            if (existing.status !== 'draft') {
              throw new Error('PAYROLL_EXISTS');
            }
            await PayrollVariableTransaction.updateMany(
              { payroll: existing._id, user: userId },
              { $set: { status: 'approved', payroll: null } },
              sessionOpt
            );
            await Payroll.updateOne({ _id: existing._id }, { $set: { isDeleted: true, deletedAt: new Date() } }, sessionOpt);
          }

          const createdPayrolls = await Payroll.create([{
            user: userId,
            employee: employee._id,
            month,
            year,
            paymentDate: payload.paymentDate || null,
            workingDays: snapshot.workingDays,
            paidDays: snapshot.paidDays,
            paidLeaves: snapshot.paidLeaves,
            unpaidLeaves: snapshot.unpaidLeaves,
            attendanceSource: payload.attendanceSource || 'default',
            lop: snapshot.lop,
            hoursWorked: attendance.hoursWorked || adjustments.hoursWorked || 0,
            payType: employee.payType,
            hourlyRate: employee.hourlyRate || 0,
            periodInput: {
              daysWorked: adjustments.daysWorked,
              unitsProduced: adjustments.unitsProduced,
              hoursLogged: adjustments.hoursLogged,
              projectFee: adjustments.projectFee,
              projectRef: adjustments.projectRef,
              milestoneAmount: adjustments.milestoneAmount,
              milestoneRef: adjustments.milestoneRef,
              ratePerUnit: adjustments.ratePerUnit,
              hoursWorked: adjustments.hoursWorked || attendance.hoursWorked,
              overtime: adjustments.overtime,
              ...(payload.periodInput || {})
            },
            earnings: snapshot.earnings,
            employerContributions: snapshot.employerContributions,
            variablePay: snapshot.variablePay,
            totalPayable: snapshot.totalPayable,
            deductions: snapshot.deductions,
            netSalary: snapshot.netSalary,
            status: statusVal,
            lopStrategy: adjustments.lopStrategy || 'proportional',
            segmentLops: snapshot.segmentLops || adjustments.segmentLops || [],
            approvalWorkflow: [{
              status: statusVal,
              actor: userId,
              remarks: saveAsDraft ? 'Payroll initialized as draft' : 'Payroll calculated and processed'
            }],
            requiredApprovers: config.requireDualApproval && Array.isArray(config.approverRoles)
              ? config.approverRoles.map(r => ({ role: r, approved: false }))
              : [],
            employeeSnapshot: {
              employeeId: employee.employeeId,
              firstName: employee.firstName,
              lastName: employee.lastName,
              email: employee.email,
              designation: employee.designation,
              joiningDate: employee.joiningDate,
              monthlyCTC: snapshot.master.monthlyCTC,
              pfEnabled: snapshot.master.pfEnabled !== false,
              esiEnabled: snapshot.master.esiEnabled !== false,
              ptEnabled: snapshot.master.ptEnabled !== false,
              ptState: employee.ptState || '',
              lwfEnabled: snapshot.master.lwfEnabled !== false,
              gratuityEnabled: snapshot.master.gratuityEnabled !== false,
              includePfInCTC: snapshot.master.includePfInCTC !== false,
              includeGratuityInCTC: snapshot.master.includeGratuityInCTC !== false,
              useSalaryComponents: snapshot.master.useSalaryComponents !== false,
              basicPercent: snapshot.master.basicPercent,
              hraPercent: snapshot.master.hraPercent,
              taxRegime: employee.taxRegime,
              declarations: employee.declarations,
              compensationType: employee.compensationType || null,
              payFrequency: employee.payFrequency || 'monthly',
              attendanceMode: employee.attendanceMode || 'attendance',
              overtimePolicy: employee.overtimePolicy || {},
            },
            paymentMethod: payload.paymentMethod || '',
            transactionId: payload.transactionId || '',
            notes: payload.notes || '',
            remarks: payload.remarks || '',
            reimbursements: snapshot.reimbursements,
            totalReimbursementApproved: snapshot.totalReimbursementApproved,
            auditLog: [{
              status: statusVal,
              changedBy: 'System Queue',
              changedById: userId,
              changedAt: new Date(),
              netSalary: snapshot.netSalary,
              notes: saveAsDraft ? 'Payroll initialized as draft' : 'Payroll calculated and processed'
            }]
          }], sessionOpt);

          const payroll = Array.isArray(createdPayrolls) ? createdPayrolls[0] : createdPayrolls;

          if (transactions.length > 0) {
            const transactionIds = transactions.map(t => t._id);
            await PayrollVariableTransaction.updateMany(
              { _id: { $in: transactionIds } },
              { $set: { payroll: payroll._id, status: saveAsDraft ? 'approved' : 'paid' } },
              sessionOpt
            );
          }

          await AuditLog.create([{
            user: userId,
            actor: userId,
            action: saveAsDraft ? 'PAYROLL_DRAFT_CREATED' : 'PAYROLL_PROCESSED',
            targetEmployee: employee._id,
            targetPayroll: payroll._id,
            changes: { toStatus: statusVal }
          }], sessionOpt);

          success.push({
            payrollId: payroll._id,
            employeeId: employee._id,
            employeeName,
            status: payroll.status,
            payroll: {
              earnings: payroll.earnings,
              employerContributions: payroll.employerContributions,
              variablePay: payroll.variablePay,
              deductions: payroll.deductions,
              totalPayable: payroll.totalPayable,
              netSalary: payroll.netSalary,
              paidDays: payroll.paidDays,
              workingDays: payroll.workingDays,
              lop: payroll.lop,
            }
          });
        });
      } catch (error) {
        if (error.message === 'PAYROLL_EXISTS' || error.code === 11000) {
          errors.push({
            employeeId,
            employeeName,
            error: 'Payroll already exists or is being processed for this period — refresh and try again.'
          });
        } else {
          errors.push({ employeeId, employeeName, error: error.message || 'Processing error' });
        }
      }
    };

    // Process employees in concurrent slices; flush progress to DB after each slice
    for (let i = 0; i < totalCount; i += CONCURRENCY) {
      const slice = employeePayloads.slice(i, i + CONCURRENCY);
      await Promise.allSettled(slice.map(processOneEmployee));

      const processed = Math.min(i + CONCURRENCY, totalCount);
      const progressPercent = Math.round((processed / totalCount) * 100);
      await PayrollBatchRun.updateOne(
        { jobId },
        { $set: { processed, progressPercent, success, errors, skippedNoActivity } }
      );
    }

    // Auto-dispatch payslips to HRMS if integration enabled and not saved as draft
    if (!saveAsDraft && settings?.integration?.enabled) {
      (async () => {
        try {
          const successIds = success.map(s => s.payrollId).filter(Boolean);
          if (successIds.length > 0) {
            const payrolls = await Payroll.find({ _id: { $in: successIds } })
              .populate({ path: 'employee', populate: { path: 'department', select: 'name code' } });
            await hrmsSyncService.dispatchBatchPayrollResultsToHrms(payrolls, settings);
          }
        } catch (dispatchErr) {
          console.error('[payrollWorker] Auto HRMS payslip dispatch error:', dispatchErr.message);
        }
      })();
    }

    await PayrollBatchRun.updateOne(
      { jobId },
      {
        $set: {
          status: 'completed',
          completedAt: new Date(),
          processed: totalCount,
          progressPercent: 100,
          success,
          errors,
          skippedNoActivity,
        }
      }
    );

    return {
      jobId,
      status: 'completed',
      total: totalCount,
      processed: totalCount,
      success,
      errors,
      skippedNoActivity,
    };
  } catch (fatalError) {
    console.error(`Fatal batch worker error for jobId ${jobId}:`, fatalError);
    await PayrollBatchRun.updateOne(
      { jobId },
      {
        $set: {
          status: 'failed',
          errorMessage: fatalError.message || 'Fatal background worker error',
          completedAt: new Date()
        }
      }
    );
  }
}

module.exports = { processBatchJob };
