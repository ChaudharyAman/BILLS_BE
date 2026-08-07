/**
 * controllers/payroll/index.js
 *
 * Central export hub for all decomposed payroll controller modules.
 * Re-exports every handler function to preserve exact backward compatibility.
 */

const { processPayroll, getBatchJobStatus, previewPayroll, bulkApprovePayroll, bulkDeletePayroll } = require('./processRun');
const { getPayrolls, getPayrollById, updatePayroll, markPayrollAsPaid, reopenPayroll, deletePayroll, processFullAndFinalSettlement } = require('./lifecycle');
const { generatePayslip, getPayslipPdf, bulkPayslipPdf, emailPayslip } = require('./payslip');
const { getPayrollConfig, updatePayrollConfig, calculateSalary, getCompensationTypes } = require('./config');
const { buildPayrollWorkbook, buildPayrollInputsWorkbook, exportPayrollExcel, exportPayrollInputsExcel, getPayrollTrend, getPayrollAuditLog } = require('./reporting');
const { syncEmployees, syncAttendance, receiveHrmsWebhook } = require('./integrations');
const { getOrCreateConfig } = require('./common');

module.exports = {
  processPayroll,
  getBatchJobStatus,
  previewPayroll,
  bulkApprovePayroll,
  bulkDeletePayroll,
  getPayrolls,
  getPayrollById,
  updatePayroll,
  markPayrollAsPaid,
  reopenPayroll,
  deletePayroll,
  processFullAndFinalSettlement,
  generatePayslip,
  getPayslipPdf,
  bulkPayslipPdf,
  emailPayslip,
  getPayrollConfig,
  updatePayrollConfig,
  calculateSalary,
  getCompensationTypes,
  buildPayrollWorkbook,
  buildPayrollInputsWorkbook,
  exportPayrollExcel,
  exportPayrollInputsExcel,
  getPayrollTrend,
  getPayrollAuditLog,
  syncEmployees,
  syncAttendance,
  receiveHrmsWebhook,
  __private__: {
    getOrCreateConfig,
    buildPayrollWorkbook,
    buildPayrollInputsWorkbook,
  },
};
