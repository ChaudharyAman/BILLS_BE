/**
 * controllers/payroll/integrations.js
 *
 * External HRMS integrations: employee sync, attendance sync, and inbound webhooks.
 */

const Employee = require('../../models/Employee');
const PayrollConfig = require('../../models/PayrollConfig');
const hrmsSyncService = require('../../services/hrmsSyncService');
const { decryptPayload } = hrmsSyncService;
const { resolvePayrollRoleTemplate } = hrmsSyncService;
const { buildMasterSalaryStructure } = require('../../utils/payrollMath');

const syncEmployees = async (req, res) => {
  try {
    const result = await hrmsSyncService.syncEmployeesFromExternal(req.user._id);
    res.json({ message: 'Employee directory sync completed successfully.', ...result });
  } catch (error) {
    console.error('Webhook/Sync Employees error:', error.message);
    res.status(500).json({ message: `Sync failed: ${error.message}` });
  }
};

const syncAttendance = async (req, res) => {
  try {
    const month = Number(req.query.month) || (new Date().getMonth() + 1);
    const year = Number(req.query.year) || new Date().getFullYear();
    const result = await hrmsSyncService.syncAttendanceFromExternal(req.user._id, month, year);
    res.json({ attendance: result });
  } catch (error) {
    console.error('Webhook/Sync Attendance error:', error.message);
    res.status(500).json({ message: `Attendance sync failed: ${error.message}` });
  }
};

const receiveHrmsWebhook = async (req, res) => {
  try {
    const userId = req.tenantUserId;
    const { encryptionSecret } = req.integrationSettings;
    
    let payload = req.body;
    if (payload && payload.data && payload.iv && payload.salt && payload.authTag) {
      payload = decryptPayload(payload, encryptionSecret);
    }

    const employeeData = payload.employee || payload;
    if (!employeeData) {
      return res.status(400).json({ message: 'Missing employee data in webhook body.' });
    }

    const empId = String(
      employeeData.employeeId ||
      employeeData.employeeCode ||
      employeeData.emp_id ||
      employeeData.emp_code ||
      employeeData.employee_code ||
      employeeData.userId ||
      employeeData._id ||
      ''
    ).trim();

    const email = String(
      employeeData.email ||
      employeeData.corporate_email ||
      employeeData.work_email ||
      employeeData.personal?.workEmail ||
      employeeData.contact?.workEmail ||
      ''
    ).trim().toLowerCase();

    if (!empId || !email) {
      return res.status(400).json({ message: 'Invalid employee payload structure: missing employeeId/email.' });
    }

    const phone = String(
      employeeData.phone ||
      employeeData.phone_number ||
      employeeData.contact_no ||
      employeeData.personal?.mobileNumber ||
      employeeData.contact?.mobileNumber ||
      ''
    ).trim();

    const rawGender = employeeData.gender || employeeData.personal?.gender || '';
    const gender = ['Male', 'Female', 'Other'].includes(rawGender) ? rawGender : '';

    const designation = employeeData.designation || employeeData.job_title || employeeData.employment?.designation || '';
    const location = employeeData.location || employeeData.city || employeeData.workLocation || employeeData.employment?.workLocation || '';

    const joiningDateVal = employeeData.joiningDate || employeeData.date_of_joining || employeeData.employment?.joiningDate;
    const joiningDate = joiningDateVal ? new Date(joiningDateVal) : new Date();

    const status = (
      employeeData.status === 'inactive' ||
      employeeData.is_active === false ||
      employeeData.isActive === false ||
      employeeData.employment?.status === 'inactive'
    ) ? 'inactive' : 'active';

    const monthlyCTC = Number(
      employeeData.monthlyCTC ||
      employeeData.ctc ||
      employeeData.base_salary_monthly ||
      employeeData.compensation?.ctc
    ) || 0;

    const panNumber = employeeData.panNumber || employeeData.pan || employeeData.identity?.panNumber || '';
    const aadharNumber = employeeData.aadharNumber || employeeData.aadhar || employeeData.aadhaar || employeeData.identity?.aadhaarNumber || '';
    const uanNumber = employeeData.uanNumber || employeeData.bankDetails?.uanNumber || '';

    const bankDetails = {
      accountName: (
        employeeData.bankDetails?.accountName ||
        employeeData.bankDetails?.accountHolderName ||
        employeeData.bank_account_name ||
        `${employeeData.firstName || employeeData.personal?.firstName || ''} ${employeeData.lastName || employeeData.personal?.lastName || ''}`.trim()
      ),
      accountNumber: employeeData.bankDetails?.accountNumber || employeeData.bank_account_no || '',
      ifscCode: employeeData.bankDetails?.ifscCode || employeeData.bank_ifsc || '',
      bankName: employeeData.bankDetails?.bankName || employeeData.bank_name || ''
    };

    let departmentName = String(employeeData.department || employeeData.dept || '').trim();
    if ((departmentName.startsWith('"') && departmentName.endsWith('"')) || (departmentName.startsWith("'") && departmentName.endsWith("'"))) {
      departmentName = departmentName.slice(1, -1).trim();
    }
    let departmentId = null;
    if (departmentName) {
      const Department = require('../../models/Department');
      const escapeRegex = require('../../utils/escapeRegex');
      let dept = await Department.findOne({
        user: userId,
        name: { $regex: new RegExp(`^${escapeRegex(departmentName)}$`, 'i') },
      });
      if (!dept) {
        let baseCode = departmentName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5).toUpperCase();
        if (!baseCode) baseCode = 'DEPT';
        let code = baseCode;
        let counter = 1;
        while (await Department.exists({ user: userId, code })) {
          code = `${baseCode}${counter}`;
          counter += 1;
        }
        dept = await Department.create({
          user: userId,
          name: departmentName,
          code,
          description: 'Auto-created during webhook sync',
        });
      }
      if (dept) departmentId = dept._id;
    }

    const pfEnabled = employeeData.compensation?.pfEnabled !== undefined ? employeeData.compensation.pfEnabled : true;
    const esiEnabled = employeeData.compensation?.esiEnabled !== undefined ? employeeData.compensation.esiEnabled : true;
    const ptEnabled = employeeData.compensation?.ptEnabled !== undefined ? employeeData.compensation.ptEnabled : true;
    const lwfEnabled = employeeData.compensation?.lwfEnabled !== undefined ? employeeData.compensation.lwfEnabled : true;
    const gratuityEnabled = employeeData.compensation?.gratuityEnabled !== undefined ? employeeData.compensation.gratuityEnabled : true;
    const includePfInCTC = employeeData.compensation?.includePfInCTC !== undefined ? employeeData.compensation.includePfInCTC : false;
    const includeGratuityInCTC = employeeData.compensation?.includeGratuityInCTC !== undefined ? employeeData.compensation.includeGratuityInCTC : true;
    const basicPercent = employeeData.compensation?.basicPercent !== undefined && employeeData.compensation.basicPercent !== null ? Number(employeeData.compensation.basicPercent) : null;
    const hraPercent = employeeData.compensation?.hraPercent !== undefined && employeeData.compensation.hraPercent !== null ? Number(employeeData.compensation.hraPercent) : null;
    const useSalaryComponents = employeeData.compensation?.useSalaryComponents !== undefined ? employeeData.compensation.useSalaryComponents : true;
    const ptState = employeeData.compensation?.ptState || '';

    const extBreakup = employeeData.compensation?.salaryBreakup || {};
    const broadband = Number(extBreakup.broadband || employeeData.broadband || 0);
    const petrol = Number(extBreakup.petrol || employeeData.petrol || 0);
    const lta = Number(extBreakup.lta || employeeData.lta || 0);
    const employerNPS = Number(extBreakup.employerNPS || extBreakup.nps || employeeData.employerNPS || employeeData.nps || 0);
    const insuranceAmount = Number(extBreakup.insuranceAmount || extBreakup.insurance || employeeData.insuranceAmount || employeeData.insurance || 0);
    const conveyance = Number(extBreakup.conveyance || employeeData.conveyance || 0);
    const medicalAllowance = Number(extBreakup.medical || extBreakup.medicalAllowance || employeeData.medical || employeeData.medicalAllowance || 0);
    const flexiAmount = Number(extBreakup.flexi || extBreakup.flexiAllowance || employeeData.flexiAmount || employeeData.flexi || 0);

    const basic = Number(extBreakup.basic || 0);
    const hra = Number(extBreakup.hra || 0);

    const standardBreakupKeys = new Set([
      'basic', 'hra', 'conveyance', 'medical', 'medicalallowance',
      'flexi', 'flexiallowance', 'flexiamount',
      'broadband', 'petrol', 'lta', 'nps', 'employernps',
      'insurance', 'insuranceamount', 'specialallowance', 'special',
      'pfenabled', 'esienabled', 'ptenabled', 'lwfenabled', 'gratuityenabled',
      'includepfinctc', 'includegratuityinctc', 'basicpercent', 'hrapercent',
      'usesalarycomponents', 'ptstate',
      'paytype',
      'annualctc', 'monthlyctc', 'monthlygross', 'monthlygross',
      'specialallowance', 'pfemployer', 'pfemployee', 'gratuity',
      'lwfemployer', 'lwfemployee', 'esiemployer', 'esiemployee',
      'professionaltax', 'professionaltaxval', 'tds', 'nettakehome',
      'flatsalary'
    ]);

    const otherAllowances = [];
    for (const [key, value] of Object.entries(extBreakup)) {
      if (!standardBreakupKeys.has(key.toLowerCase())) {
        const numVal = Number(value);
        if (Number.isFinite(numVal) && numVal > 0) {
          otherAllowances.push({
            name: key,
            amount: numVal
          });
        }
      }
    }

    const hrmsPayType = String(extBreakup.payType || extBreakup.paytype || 'salaried').toLowerCase();
    const roleTemplate = await resolvePayrollRoleTemplate(userId, hrmsPayType);

    const resolvedPfEnabled = hrmsPayType === 'salaried' ? pfEnabled : roleTemplate.pfEnabled;
    const resolvedEsiEnabled = hrmsPayType === 'salaried' ? esiEnabled : roleTemplate.esiEnabled;
    const resolvedPtEnabled = hrmsPayType === 'salaried' ? ptEnabled : roleTemplate.ptEnabled;
    const resolvedLwfEnabled = hrmsPayType === 'salaried' ? lwfEnabled : roleTemplate.lwfEnabled;
    const resolvedGratuityEnabled = hrmsPayType === 'salaried' ? gratuityEnabled : roleTemplate.gratuityEnabled;
    const resolvedIncludePfInCTC = hrmsPayType === 'salaried' ? includePfInCTC : roleTemplate.includePfInCTC;
    const resolvedIncludeGratuityInCTC = hrmsPayType === 'salaried' ? includeGratuityInCTC : roleTemplate.includeGratuityInCTC;
    const resolvedUseSalaryComponents = hrmsPayType === 'salaried' ? useSalaryComponents : roleTemplate.useSalaryComponents;

    const query = { user: userId, employeeId: empId };
    const updateData = {
      employeeId: empId,
      firstName: employeeData.firstName || employeeData.personal?.firstName || 'Unknown',
      lastName: employeeData.lastName || employeeData.personal?.lastName || 'Employee',
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
      uanNumber,
      bankDetails,
      department: departmentId,
      role: roleTemplate.roleId,
      payType: roleTemplate.payType,
      employmentType: roleTemplate.employmentType,
      pfEnabled: resolvedPfEnabled,
      esiEnabled: resolvedEsiEnabled,
      ptEnabled: resolvedPtEnabled,
      lwfEnabled: resolvedLwfEnabled,
      gratuityEnabled: resolvedGratuityEnabled,
      includePfInCTC: resolvedIncludePfInCTC,
      includeGratuityInCTC: resolvedIncludeGratuityInCTC,
      basicPercent,
      hraPercent,
      useSalaryComponents: resolvedUseSalaryComponents,
      ptState,
      broadband,
      petrol,
      lta,
      employerNPS,
      insuranceAmount,
      flexiAmount,
      basic,
      hra,
      salaryStructure: {
        basic,
        hra,
        conveyance,
        medicalAllowance,
        otherAllowances
      }
    };

    const config = await PayrollConfig.findOne({ user: userId }) || {};
    const master = buildMasterSalaryStructure(updateData, config);
    updateData.salaryStructure = {
      basic: master.basicMaster,
      hra: master.hraMaster,
      conveyance: conveyance,
      medicalAllowance: medicalAllowance,
      specialAllowance: master.specialAllowance,
      grossSalary: master.grossSalary,
      ctc: master.grossTotalSalary,
      otherAllowances: otherAllowances
    };

    const existingEmp = await Employee.findOne(query);
    if (existingEmp) {
      await Employee.updateOne(query, { $set: updateData });
    } else {
      await Employee.create({ ...updateData, user: userId });
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
