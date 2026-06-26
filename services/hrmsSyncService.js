const axios = require('axios');
const Settings = require('../models/Settings');
const Employee = require('../models/Employee');
const PayrollConfig = require('../models/PayrollConfig');
const { decryptPayload } = require('../utils/cryptoHelper');
const { buildMasterSalaryStructure } = require('../utils/payrollMath');

// Helper to determine if a payload is AES-GCM encrypted
const isEncryptedPackage = (obj) => {
  return obj && typeof obj === 'object' && obj.data && obj.iv && obj.salt && obj.authTag;
};

/**
 * Fetch and upsert employee profiles from external multi-tenant HRMS.
 */
exports.syncEmployeesFromExternal = async (userId) => {
  const settings = await Settings.findOne({ user: userId });
  if (!settings || !settings.integration?.enabled) {
    throw new Error('HRMS integration is disabled or not configured for this organization.');
  }

  const { apiUrl, apiKey, externalTenantId, encryptionSecret } = settings.integration;
  if (!apiUrl) throw new Error('HRMS API URL is not configured.');

  try {
    const response = await axios.get(`${apiUrl.replace(/\/$/, '')}/api/v1/employees`, {
      params: { tenantId: externalTenantId },
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
      },
      timeout: 10000 // 10s timeout
    });

    let rawData = response.data;
    if (isEncryptedPackage(rawData)) {
      rawData = decryptPayload(rawData, encryptionSecret);
    }

    const employeesList = Array.isArray(rawData) ? rawData : (rawData?.employees || []);
    if (!employeesList.length) {
      return { created: 0, updated: 0, message: 'No employees found in external HRMS payload.' };
    }

    const config = await PayrollConfig.findOne({ user: userId }) || {};
    let createdCount = 0;
    let updatedCount = 0;
    const errors = [];

    for (const extEmp of employeesList) {
      try {
        const empId = String(
          extEmp.employeeId ||
          extEmp.employeeCode ||
          extEmp.emp_id ||
          extEmp.emp_code ||
          extEmp.employee_code ||
          extEmp.userId ||
          extEmp._id ||
          ''
        ).trim();

        const email = String(
          extEmp.email ||
          extEmp.corporate_email ||
          extEmp.work_email ||
          extEmp.personal?.workEmail ||
          extEmp.contact?.workEmail ||
          ''
        ).trim().toLowerCase();

        if (!empId || !email) {
          errors.push({ id: empId || 'unknown', error: 'Missing employeeId or email in sync record' });
          continue;
        }

        const phone = String(
          extEmp.phone ||
          extEmp.phone_number ||
          extEmp.contact_no ||
          extEmp.personal?.mobileNumber ||
          extEmp.contact?.mobileNumber ||
          ''
        ).trim();

        const rawGender = extEmp.gender || extEmp.personal?.gender || '';
        const gender = ['Male', 'Female', 'Other'].includes(rawGender) ? rawGender : '';

        const designation = extEmp.designation || extEmp.job_title || extEmp.employment?.designation || '';
        const location = extEmp.location || extEmp.city || extEmp.workLocation || extEmp.employment?.workLocation || '';

        const joiningDateVal = extEmp.joiningDate || extEmp.date_of_joining || extEmp.employment?.joiningDate;
        const joiningDate = joiningDateVal ? new Date(joiningDateVal) : new Date();

        const status = (
          extEmp.status === 'inactive' ||
          extEmp.is_active === false ||
          extEmp.isActive === false ||
          extEmp.employment?.status === 'inactive'
        ) ? 'inactive' : 'active';

        const monthlyCTC = Number(
          extEmp.monthlyCTC ||
          extEmp.ctc ||
          extEmp.base_salary_monthly ||
          extEmp.compensation?.ctc
        ) || 0;

        const panNumber = extEmp.panNumber || extEmp.pan || extEmp.identity?.panNumber || '';
        const aadharNumber = extEmp.aadharNumber || extEmp.aadhar || extEmp.aadhaar || extEmp.identity?.aadhaarNumber || '';

        const bankDetails = {
          accountName: (
            extEmp.bankDetails?.accountName ||
            extEmp.bankDetails?.accountHolderName ||
            extEmp.bank_account_name ||
            `${extEmp.firstName || extEmp.personal?.firstName || ''} ${extEmp.lastName || extEmp.personal?.lastName || ''}`.trim()
          ),
          accountNumber: extEmp.bankDetails?.accountNumber || extEmp.bank_account_no || '',
          ifscCode: extEmp.bankDetails?.ifscCode || extEmp.bank_ifsc || '',
          bankName: extEmp.bankDetails?.bankName || extEmp.bank_name || ''
        };

        const query = { user: userId, employeeId: empId };
        const updateData = {
          employeeId: empId,
          firstName: extEmp.firstName || extEmp.personal?.firstName || 'Unknown',
          lastName: extEmp.lastName || extEmp.personal?.lastName || 'Employee',
          email,
          phone,
          gender,
          designation,
          location,
          joiningDate,
          status,
          monthlyCTC,
          panNumber,
          aadharNumber,
          bankDetails,
          department: departmentId
        };

        // Determine / update salary structure
        const master = buildMasterSalaryStructure(updateData, config);
        updateData.salaryStructure = {
          basic: master.basicMaster,
          hra: master.hraMaster,
          conveyance: Number(extEmp.conveyance || extEmp.compensation?.conveyance) || 0,
          medicalAllowance: Number(extEmp.medicalAllowance || extEmp.compensation?.medicalAllowance) || 0,
          specialAllowance: master.specialAllowance,
          grossSalary: master.grossSalary,
          ctc: master.grossTotalSalary,
          otherAllowances: []
        };

        const existingEmp = await Employee.findOne(query);
        if (existingEmp) {
          await Employee.updateOne(query, { $set: updateData });
          updatedCount += 1;
        } else {
          await Employee.create({ ...updateData, user: userId });
          createdCount += 1;
        }
      } catch (err) {
        errors.push({ id: extEmp.employeeId || extEmp.emp_id || 'unknown', error: err.message });
      }
    }

    return { created: createdCount, updated: updatedCount, errors };
  } catch (error) {
    console.error('hrmsSyncService syncEmployees error:', error.message);
    throw new Error(`Sync connection failed: ${error.message}`);
  }
};

/**
 * Fetch monthly attendance summary from external multi-tenant Attendance system.
 */
exports.syncAttendanceFromExternal = async (userId, month, year) => {
  const settings = await Settings.findOne({ user: userId });
  if (!settings || !settings.integration?.enabled) {
    throw new Error('HRMS/Attendance integration is disabled.');
  }

  const { apiUrl, apiKey, externalTenantId, encryptionSecret } = settings.integration;
  if (!apiUrl) throw new Error('HRMS/Attendance API URL is not configured.');

  try {
    const response = await axios.get(`${apiUrl.replace(/\/$/, '')}/api/v1/attendance`, {
      params: { tenantId: externalTenantId, month, year },
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    let rawData = response.data;
    if (isEncryptedPackage(rawData)) {
      rawData = decryptPayload(rawData, encryptionSecret);
    }

    const attendanceRecords = Array.isArray(rawData) ? rawData : (rawData?.attendance || []);
    const localEmployees = await Employee.find({ user: userId }).select('_id employeeId');

    const mapped = [];
    localEmployees.forEach(emp => {
      const record = attendanceRecords.find(r => String(r.employeeId || r.emp_id || '').trim() === String(emp.employeeId).trim());
      if (record) {
        const totalWorkingDays = Number(record.workingDays || record.total_working_days) || settings.defaultWorkingDays || 26;
        const unpaidLeaves = Number(record.unpaidLeaves || record.unpaid_leaves) || 0;
        const paidLeaves = Number(record.paidLeaves || record.paid_leaves) || 0;
        const paidDays = Math.max(0, totalWorkingDays - unpaidLeaves);

        mapped.push({
          employeeId: emp._id,
          employeeNumber: emp.employeeId,
          workingDays: totalWorkingDays,
          paidDays: paidDays,
          unpaidLeaves: unpaidLeaves,
          paidLeaves: paidLeaves
        });
      }
    });

    return mapped;
  } catch (error) {
    console.error('hrmsSyncService syncAttendance error:', error.message);
    throw new Error(`Attendance fetch failed: ${error.message}`);
  }
};
