/**
 * payrollQueue.js
 *
 * Durable background job queue manager for payroll batch processing.
 * Creates a PayrollBatchRun tracking document and dispatches worker jobs asynchronously.
 */

const mongoose = require('mongoose');
const PayrollBatchRun = require('../models/PayrollBatchRun');
const { processBatchJob } = require('../workers/payrollWorker');

async function enqueueBatchJob({ userId, month, year, employeePayloads = [], saveAsDraft = false }) {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  if (mongoose.connection.readyState === 1) {
    await PayrollBatchRun.create({
      jobId,
      user: userId,
      month: Number(month),
      year: Number(year),
      saveAsDraft: Boolean(saveAsDraft),
      status: 'queued',
      total: employeePayloads.length,
      processed: 0,
      progressPercent: 0,
      success: [],
      errors: [],
      skippedNoActivity: [],
    });
  }

  // Asynchronous non-blocking dispatch
  setImmediate(() => {
    processBatchJob({
      jobId,
      userId,
      month: Number(month),
      year: Number(year),
      employeePayloads,
      saveAsDraft: Boolean(saveAsDraft),
    }).catch(err => {
      console.error(`Error executing async payroll batch worker for ${jobId}:`, err);
    });
  });

  return {
    jobId,
    status: 'queued',
    total: employeePayloads.length,
    message: 'Payroll processing enqueued successfully',
  };
}

module.exports = { enqueueBatchJob };
