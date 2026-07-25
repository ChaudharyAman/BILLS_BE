/**
 * controllers/payroll/integrations.js
 *
 * External HRMS integrations: employee sync, attendance sync, and inbound webhooks.
 *
 * All employee field-mapping logic lives in hrmsSyncService.mapHrmsEmployeeToUpdateData.
 * This file only owns HTTP-boundary concerns (request parsing, response formatting).
 */

const Employee     = require('../../models/Employee');
const PayrollConfig = require('../../models/PayrollConfig');
const { decryptPayload } = require('../../utils/cryptoHelper');
const hrmsSyncService = require('../../services/hrmsSyncService');

// ─────────────────────────────────────────────────────────────────────────────
// Pull sync handlers (protected by JWT middleware)
// ─────────────────────────────────────────────────────────────────────────────

const syncEmployees = async (req, res) => {
  try {
    const result = await hrmsSyncService.syncEmployeesFromExternal(req.user._id);
    res.json({ message: 'Employee directory sync completed successfully.', ...result });
  } catch (error) {
    console.error('Sync Employees error:', error.message);
    res.status(500).json({ message: `Sync failed: ${error.message}` });
  }
};

const syncAttendance = async (req, res) => {
  try {
    const month = Number(req.query.month) || (new Date().getMonth() + 1);
    const year  = Number(req.query.year)  || new Date().getFullYear();
    const result = await hrmsSyncService.syncAttendanceFromExternal(req.user._id, month, year);
    res.json({ attendance: result });
  } catch (error) {
    console.error('Sync Attendance error:', error.message);
    res.status(500).json({ message: `Attendance sync failed: ${error.message}` });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Inbound webhook handler (authenticated via HMAC — no JWT)
// ─────────────────────────────────────────────────────────────────────────────

const receiveHrmsWebhook = async (req, res) => {
  try {
    const userId = req.tenantUserId;
    const { encryptionSecret, apiUrl, apiKey, externalTenantId } = req.integrationSettings;

    // Decrypt payload if TalentCIO has payload encryption enabled
    let payload = req.body;
    if (payload && payload.data && payload.iv && payload.salt && payload.authTag) {
      payload = decryptPayload(payload, encryptionSecret);
    }

    const employeeData = payload.employee || payload;
    if (!employeeData) {
      return res.status(400).json({ message: 'Missing employee data in webhook body.' });
    }

    // Load local PayrollConfig so salary-structure computation uses current rates
    const config = await PayrollConfig.findOne({ user: userId });

    // Map raw HRMS record → MyBill Employee updateData (shared logic, fixes #1 + #2)
    const { empId, updateData } = await hrmsSyncService.mapHrmsEmployeeToUpdateData(
      employeeData, userId, config
    );

    const query = { user: userId, employeeId: empId };
    const existingEmp = await Employee.findOne(query);
    if (existingEmp) {
      await Employee.updateOne(query, { $set: updateData });
    } else {
      await Employee.create({ ...updateData, user: userId });
    }

    // Sync payroll config from HRMS in background so rate changes take effect
    // without requiring a manual sync (#4). Non-fatal if HRMS is temporarily unavailable.
    if (apiUrl && apiKey && externalTenantId) {
      hrmsSyncService.syncPayrollConfigFromExternal(
        userId, apiUrl, apiKey, externalTenantId, encryptionSecret
      ).catch(err =>
        console.warn('[receiveHrmsWebhook] Background config sync failed (non-fatal):', err.message)
      );
    }

    res.json({ message: 'Webhook employee update processed successfully.' });
  } catch (error) {
    console.error('HRMS Webhook processor error:', error.message);
    res.status(500).json({ message: `Webhook error: ${error.message}` });
  }
};

module.exports = {
  syncEmployees,
  syncAttendance,
  receiveHrmsWebhook,
};
