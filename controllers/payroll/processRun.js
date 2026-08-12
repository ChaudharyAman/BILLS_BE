/**
 * controllers/payroll/processRun.js
 *
 * Payroll processing, previewing, batch enqueuing, batch status polling, bulk approval, and bulk deletion.
 */

const mongoose = require('mongoose');
const Payroll = require('../../models/Payroll');
const Employee = require('../../models/Employee');
const AuditLog = require('../../models/AuditLog');
const PayrollBatchRun = require('../../models/PayrollBatchRun');
const Expense = require('../../models/Expense');
const { enqueueBatchJob } = require('../../queues/payrollQueue');
const { buildPayrollSnapshot } = require('../../utils/payrollMath');
const { isValidMonth, isValidYear, getOrCreateConfig } = require('./common');

const processPayroll = async (req, res) => {
  try {
    const month = Number(req.body.month);
    const year = Number(req.body.year);
    const employeePayloads = Array.isArray(req.body.employees) ? req.body.employees : (req.body.employeePayloads || []);
    const saveAsDraft = Boolean(req.body.saveAsDraft);

    if (!isValidMonth(month) || !isValidYear(year)) {
      return res.status(400).json({ message: 'Valid month and year are required' });
    }
    if (employeePayloads.length === 0) {
      return res.status(400).json({ message: 'Select at least one employee to process payroll' });
    }

    const tenantUserId = req.companyId || req.user._id;
    const isAsync = req.query.async === 'true' || req.body.async === true;

    if (!isAsync) {
      const { processBatchJob } = require('../../workers/payrollWorker');
      const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const batchResult = await processBatchJob({
        jobId,
        userId: tenantUserId,
        month,
        year,
        employeePayloads,
        saveAsDraft,
      });

      return res.status(201).json(batchResult);
    }

    const queueResult = await enqueueBatchJob({
      userId: tenantUserId,
      month,
      year,
      employeePayloads,
      saveAsDraft,
    });

    return res.status(202).json({
      jobId: queueResult.jobId,
      status: queueResult.status,
      total: queueResult.total,
      message: 'Payroll processing enqueued successfully',
    });
  } catch (error) {
    console.error('Error processing payroll batch queue:', error);
    res.status(500).json({ message: 'Server error enqueuing payroll batch' });
  }
};

const getBatchJobStatus = async (req, res) => {
  try {
    const { jobId } = req.params;
    const batchRun = await PayrollBatchRun.findOne({ jobId, user: req.user._id });
    if (!batchRun) {
      return res.status(404).json({ message: 'Payroll batch job not found' });
    }
    res.json({
      jobId: batchRun.jobId,
      status: batchRun.status,
      total: batchRun.total,
      processed: batchRun.processed,
      progressPercent: batchRun.progressPercent,
      success: batchRun.success || [],
      errors: batchRun.errors || [],
      skippedNoActivity: batchRun.skippedNoActivity || [],
      errorMessage: batchRun.errorMessage,
      startedAt: batchRun.startedAt,
      completedAt: batchRun.completedAt,
    });
  } catch (error) {
    console.error('Error fetching batch job status:', error);
    res.status(500).json({ message: 'Server error fetching batch job status' });
  }
};

const previewPayroll = async (req, res) => {
  try {
    const { employeeId, month, year, attendance = {}, adjustments = {} } = req.body;

    if (!employeeId || !month || !year) {
      return res.status(400).json({ message: 'employeeId, month, and year are required' });
    }
    if (!mongoose.Types.ObjectId.isValid(String(employeeId))) {
      return res.status(400).json({ message: 'Invalid employeeId' });
    }

    const employee = await Employee.findOne({ _id: employeeId, user: req.user._id })
      .populate('department', 'name code')
      .lean();
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    const config = await getOrCreateConfig(req.user._id);

    if (adjustments.ptState === undefined) {
      adjustments.ptState = employee.ptState || '';
    }

    const snapshot = buildPayrollSnapshot(employee, config, attendance, adjustments, month, year);
    res.json(snapshot);
  } catch (error) {
    console.error('Error generating payroll preview:', error);
    res.status(500).json({ message: 'Server error generating payroll preview' });
  }
};

const bulkApprovePayroll = async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((id) => mongoose.Types.ObjectId.isValid(String(id))) : [];
    const month = req.body.month !== undefined ? Number(req.body.month) : undefined;
    const year = req.body.year !== undefined ? Number(req.body.year) : undefined;
    const filter = { user: req.user._id, status: 'processed' };

    if (ids.length) filter._id = { $in: ids };
    if (month !== undefined) {
      if (!isValidMonth(month)) return res.status(400).json({ message: 'Valid month is required' });
      filter.month = month;
    }
    if (year !== undefined) {
      if (!isValidYear(year)) return res.status(400).json({ message: 'Valid year is required' });
      filter.year = year;
    }
    if (!ids.length && (month === undefined || year === undefined)) {
      return res.status(400).json({ message: 'Provide payroll IDs or month and year to approve payroll' });
    }

    // Select only the fields needed to build the bulk ops — avoids loading full documents.
    const payrolls = await Payroll.find(filter).select('_id employee netSalary').lean();
    if (!payrolls.length) {
      return res.json({ matched: 0, modified: 0, message: 'No processed payrolls found to approve' });
    }

    const now = new Date();
    const remarks = req.body.remarks || 'Bulk approved';

    // Build all updates as a single bulkWrite — eliminates the partial-approval window
    // that existed when the process crashed mid save() loop.
    const bulkOps = payrolls.map((payroll) => ({
      updateOne: {
        filter: { _id: payroll._id },
        update: {
          $set: { status: 'approved' },
          $push: {
            approvalWorkflow: {
              status: 'approved',
              actor: req.user._id,
              remarks,
            },
            auditLog: {
              status: 'approved',
              changedBy: req.user.name,
              changedById: req.user._id,
              changedAt: now,
              netSalary: payroll.netSalary,
              notes: remarks,
            },
          },
        },
      },
    }));

    const auditDocs = payrolls.map((payroll) => ({
      user: req.user._id,
      actor: req.user._id,
      action: 'PAYROLL_APPROVED',
      targetEmployee: payroll.employee,
      targetPayroll: payroll._id,
      changes: { from: 'processed', to: 'approved' },
    }));

    const bulkResult = await Payroll.bulkWrite(bulkOps, { ordered: false });
    await AuditLog.insertMany(auditDocs, { ordered: false });

    res.json({
      matched: payrolls.length,
      modified: bulkResult.modifiedCount,
      message: 'Payroll approved successfully',
    });
  } catch (error) {
    console.error('Error approving payroll in bulk:', error);
    res.status(500).json({ message: 'Server error approving payroll' });
  }
};

const bulkDeletePayroll = async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((id) => mongoose.Types.ObjectId.isValid(String(id))) : [];
    const month = req.body.month !== undefined ? Number(req.body.month) : undefined;
    const year = req.body.year !== undefined ? Number(req.body.year) : undefined;
    const filter = { user: req.user._id, status: { $ne: 'paid' } };

    if (ids.length) filter._id = { $in: ids };
    if (month !== undefined) {
      if (!isValidMonth(month)) return res.status(400).json({ message: 'Valid month is required' });
      filter.month = month;
    }
    if (year !== undefined) {
      if (!isValidYear(year)) return res.status(400).json({ message: 'Valid year is required' });
      filter.year = year;
    }
    if (!ids.length && (month === undefined || year === undefined)) {
      return res.status(400).json({ message: 'Provide payroll IDs or month and year to delete payroll' });
    }

    const payrolls = await Payroll.find(filter);
    let deletedCount = 0;

    for (const payroll of payrolls) {
      if (payroll.expenseRef) {
        await Expense.updateOne({ _id: payroll.expenseRef, user: req.user._id }, { $set: { isDeleted: true, deletedAt: new Date() } });
      }
      const PayrollVariableTransaction = require('../../models/PayrollVariableTransaction');
      await PayrollVariableTransaction.updateMany(
        { payroll: payroll._id, user: req.user._id },
        { $set: { status: 'approved', payroll: null } }
      );
      await Payroll.updateOne({ _id: payroll._id }, { $set: { isDeleted: true, deletedAt: new Date() } });

      await AuditLog.create({
        user: req.user._id,
        actor: req.user._id,
        action: 'PAYROLL_DELETED',
        targetEmployee: payroll.employee,
        changes: { month: payroll.month, year: payroll.year, netSalary: payroll.netSalary }
      });

      deletedCount += 1;
    }

    res.json({
      matched: payrolls.length,
      deleted: deletedCount,
      message: 'Payrolls deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting payrolls in bulk:', error);
    res.status(500).json({ message: 'Server error deleting payrolls' });
  }
};

module.exports = {
  processPayroll,
  getBatchJobStatus,
  previewPayroll,
  bulkApprovePayroll,
  bulkDeletePayroll,
};
