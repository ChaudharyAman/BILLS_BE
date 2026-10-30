/**
 * controllers/payroll/payslip.js
 *
 * Payslip generation and email dispatch endpoints.
 */

const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const axios = require('axios');
const fs = require('fs');
const Payroll = require('../../models/Payroll');
const Settings = require('../../models/Settings');
const LeaveBalance = require('../../models/LeaveBalance');
const { getSalarySplits, buildPayslipEarningsLineItems, buildPayslipDeductionsLineItems, buildPayslipEmployerContributionsLineItems, calculateTaxForRegime } = require('../../utils/payrollMath');
const { monthName, getOrCreateConfig } = require('./common');

const {
  generateSinglePayslipPdf,
  createBulkPayslipsZip,
  getStoredPayslipPath,
  buildPayslipHtml,
  computeTaxWorksheet,
  launchSharedBrowser,
} = require('../../services/pdfGeneratorService');

/**
 * Helper to fetch accrued leave balance for an employee.
 */
async function getEmployeeLeaveBalance(userId, employeeId, year) {
  try {
    if (!employeeId) return 0;
    const targetId = employeeId._id || employeeId;
    const balances = await LeaveBalance.find({
      user: userId,
      employee: targetId,
      year: year || new Date().getFullYear(),
    });
    if (balances && balances.length > 0) {
      return balances.reduce((sum, b) => sum + (Number(b.closing) || 0), 0);
    }
  } catch (e) {
    console.warn('[Payslip] Could not fetch leave balance:', e.message);
  }
  return 0;
}

/**
 * Helper to retrieve financial-year payroll records and monthly TDS schedule (April-March).
 */
async function getFyPayrollsAndTds(userId, employeeId, currentMonth, currentYear) {
  let startYear, endYear;
  if (currentMonth >= 4) {
    startYear = currentYear;
    endYear = currentYear + 1;
  } else {
    startYear = currentYear - 1;
    endYear = currentYear;
  }

  const targetId = employeeId._id || employeeId;
  const fyPayrolls = await Payroll.find({
    user: userId,
    employee: targetId,
    $or: [
      { year: startYear, month: { $gte: 4 } },
      { year: endYear, month: { $lte: 3 } }
    ]
  }).sort({ year: 1, month: 1 }).lean();

  const tdsMonths = {
    4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0, 1: 0, 2: 0, 3: 0
  };

  for (const pr of fyPayrolls) {
    if (pr.deductions?.tds && pr.month in tdsMonths) {
      tdsMonths[pr.month] = Number(pr.deductions.tds) || 0;
    }
  }

  return { fyPayrolls, tdsMonths };
}

const generatePayslip = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    const payroll = await Payroll.findOne({ _id: req.params.id, user: req.user._id })
      .populate({
        path: 'employee',
        select: '+uanNumber +panNumber +aadharNumber +esiNumber +bankDetails.accountNumber +pfNumber +pfNo',
        populate: { path: 'department', select: 'name code' },
      });
    const settings = await Settings.findOne({ user: req.user._id }).lean();

    if (!payroll) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    if (!payroll.employee && !payroll.employeeSnapshot) {
      return res.status(404).json({ message: 'Employee record no longer exists for this payroll' });
    }

    const snap = payroll.employeeSnapshot || {};
    const emp = payroll.employee;
    const empObj = (typeof emp === 'object' && emp !== null) ? (emp.toObject ? emp.toObject() : emp) : {};

    const employeeData = (Object.keys(snap).length > 0)
      ? {
          ...empObj,
          ...snap,
          payType: payroll.payType || snap.payType,
          hourlyRate: payroll.hourlyRate || snap.hourlyRate,
          _id: snap._id || empObj._id || emp
        }
      : {
          ...empObj,
          payType: payroll.payType,
          hourlyRate: payroll.hourlyRate,
          _id: empObj._id || emp
        };

    const config = await getOrCreateConfig(req.user._id, new Date(payroll.year, payroll.month - 1, 1), req.activeProfileId || payroll.profile || null);
    const salaryComponents = config?.salaryComponents || [];
    const adjustments = {
      pfEnabled: employeeData.pfEnabled,
      esiEnabled: employeeData.esiEnabled,
      ptEnabled: employeeData.ptEnabled,
      ptState: employeeData.ptState || '',
      lwfEnabled: employeeData.lwfEnabled,
      gratuityEnabled: employeeData.gratuityEnabled,
      includePfInCTC: employeeData.includePfInCTC,
      includeGratuityInCTC: employeeData.includeGratuityInCTC,
      lopStrategy: payroll.lopStrategy || 'proportional',
      segmentLops: payroll.segmentLops || [],
    };
    const splits = getSalarySplits(
      employeeData,
      config,
      payroll.month,
      payroll.year,
      payroll.paidDays,
      payroll.workingDays,
      adjustments
    );

    const targetEmpId = payroll.employee?._id || payroll.employee || employeeData._id;
    const { fyPayrolls, tdsMonths } = await getFyPayrollsAndTds(req.user._id, targetEmpId, payroll.month, payroll.year);
    const leaveBalance = await getEmployeeLeaveBalance(req.user._id, targetEmpId, payroll.year);

    const taxWorksheet = computeTaxWorksheet(payroll, employeeData, { fyPayrolls, tdsMonths, salaryComponents });

    res.json({
      payslip: {
        employee: employeeData,
        period: {
          month: payroll.month,
          year: payroll.year,
          monthName: monthName(payroll.month),
        },
        leaveBalance: Number(leaveBalance) || 0,
        salaryComponents,
        salarySplits: (payroll.salarySplits && payroll.salarySplits.length > 0) ? payroll.salarySplits : splits,
        earningsLineItems: buildPayslipEarningsLineItems(payroll, { salaryComponents }),
        deductionsLineItems: buildPayslipDeductionsLineItems(payroll, { salaryComponents }),
        employerContributionsLineItems: buildPayslipEmployerContributionsLineItems(payroll, { salaryComponents }),
        periodInput: payroll.periodInput || {},
        isFullAndFinal: Boolean(payroll.isFullAndFinal || payroll.settlementType === 'full_and_final'),
        settlementType: payroll.settlementType || (payroll.isFullAndFinal ? 'full_and_final' : 'monthly'),
        fnfDetails: payroll.fnfDetails || null,
        complianceNotes: (() => {
          const notes = [];
          if (payroll.payrollShortfall?.statutoryOnly) {
            notes.push('Note: Statutory deductions (PF/ESI/PT/TDS) exceed gross earnings. Deductions have been capped to available earnings. Please review with your payroll manager.');
          } else if (payroll.netSalary === 0 && payroll.deductions?.totalDeductions > payroll.earnings?.totalEarnings) {
            notes.push('Note: Net salary was clamped to ₹0 due to non-statutory deduction shortfall.');
          }
          if (!settings?.companyName) {
            notes.push('Note: Company details are not fully configured in Settings. Complete your company profile to show correct letterhead.');
          }
          return notes;
        })(),
        company: settings || {},
        earnings: payroll.earnings,
        employerContributions: payroll.employerContributions,
        variablePay: payroll.variablePay,
        deductions: payroll.deductions,
        totalPayable: payroll.totalPayable,
        netSalary: payroll.netSalary,
        workingDays: payroll.workingDays,
        paidDays: payroll.paidDays,
        paidLeaves: payroll.paidLeaves,
        unpaidLeaves: payroll.unpaidLeaves,
        lop: payroll.lop,
        payType: payroll.payType,
        hoursWorked: payroll.hoursWorked,
        hourlyRate: payroll.hourlyRate,
        paymentMethod: payroll.paymentMethod,
        transactionId: payroll.transactionId,
        paymentDate: payroll.paymentDate,
        status: payroll.status,
        notes: payroll.notes,
        remarks: payroll.remarks,
        auditLog: payroll.auditLog || [],
        generatedAt: new Date(),
        company: settings ? {
          companyName: settings.companyName,
          contactName: settings.contactName,
          email: settings.email,
          phone: settings.phone,
          website: settings.website,
          gstin: settings.gstin,
          pan: settings.pan,
          logoUrl: settings.logoUrl,
          signatureUrl: settings.signatureUrl,
          address: settings.address,
        } : null,
        taxWorksheet,
      },
    });
  } catch (error) {
    console.error('Error generating payslip:', error);
    res.status(500).json({ message: 'Server error generating payslip' });
  }
};

const getPayslipPdf = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    const payroll = await Payroll.findOne({ _id: req.params.id, user: req.user._id })
      .populate({
        path: 'employee',
        populate: { path: 'department', select: 'name code' },
      });

    if (!payroll) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    const settings = await Settings.findOne({ user: req.user._id }).lean();
    const isEncryptedReq = req.query.encrypted === 'true' || req.headers['x-encrypt-pdf'] === 'true';

    let userPassword = null;
    if (isEncryptedReq) {
      const emp = payroll.employee || payroll.employeeSnapshot || {};
      const firstName = emp.firstName || payroll.employeeSnapshot?.firstName || '';
      const lastName = emp.lastName || payroll.employeeSnapshot?.lastName || '';
      const cleanName = (firstName + lastName).replace(/\s+/g, '').toUpperCase();
      const namePart = cleanName.slice(0, 4).padEnd(4, 'X');

      const dateRef = emp.dateOfBirth ? new Date(emp.dateOfBirth) : (emp.joiningDate ? new Date(emp.joiningDate) : new Date());
      const day = String(dateRef.getUTCDate ? dateRef.getUTCDate() : dateRef.getDate()).padStart(2, '0');
      const month = String((dateRef.getUTCMonth ? dateRef.getUTCMonth() : dateRef.getMonth()) + 1).padStart(2, '0');
      userPassword = `${namePart}${day}${month}`;
    }

    const targetEmpId = payroll.employee?._id || payroll.employee || (payroll.employeeSnapshot && payroll.employeeSnapshot._id);
    const leaveBalance = await getEmployeeLeaveBalance(req.user._id, targetEmpId, payroll.year);
    const { fyPayrolls, tdsMonths } = await getFyPayrollsAndTds(req.user._id, targetEmpId, payroll.month, payroll.year);
    const config = await getOrCreateConfig(req.user._id, new Date(payroll.year, payroll.month - 1, 1), req.activeProfileId || payroll.profile || null);
    const salaryComponents = config?.salaryComponents || [];

    // Serve persisted file for non-encrypted paid payrolls if available and up-to-date
    const storedPath = getStoredPayslipPath(payroll._id);
    if (!isEncryptedReq && payroll.status === 'paid' && fs.existsSync(storedPath)) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="Payslip_${payroll.employeeSnapshot?.employeeId || 'EMP'}_${monthName(payroll.month)}_${payroll.year}.pdf"`);
      return fs.createReadStream(storedPath).pipe(res);
    }

    const pdfBuffer = await generateSinglePayslipPdf({
      payroll,
      settings,
      userPassword,
      options: {
        leaveBalance,
        salaryComponents,
        taxWorksheetOptions: { fyPayrolls, tdsMonths, salaryComponents }
      }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Payslip_${payroll.employeeSnapshot?.employeeId || 'EMP'}_${monthName(payroll.month)}_${payroll.year}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('Error generating PDF payslip:', error);
    res.status(500).json({ message: 'Server error generating PDF payslip', error: error.message });
  }
};

const bulkPayslipPdf = async (req, res) => {
  let browser = null;
  try {
    const { ids, month, year, department } = req.body || {};
    const query = { user: req.user._id };

    if (Array.isArray(ids) && ids.length > 0) {
      const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(String(id)));
      query._id = { $in: validIds };
    } else {
      if (month !== undefined && month !== '') query.month = Number(month);
      if (year !== undefined && year !== '') query.year = Number(year);
    }

    let payrolls = await Payroll.find(query)
      .populate({
        path: 'employee',
        populate: { path: 'department', select: 'name code' },
      });

    if (department && mongoose.Types.ObjectId.isValid(String(department))) {
      payrolls = payrolls.filter(p => p.employee?.department?._id?.toString() === String(department));
    }

    if (!payrolls || payrolls.length === 0) {
      return res.status(404).json({ message: 'No matching payroll records found for bulk PDF generation' });
    }

    const settings = await Settings.findOne({ user: req.user._id }).lean();
    const payslipFiles = [];

    // Launch single browser instance for the entire batch to conserve memory and avoid timeouts
    browser = await launchSharedBrowser();

    const config = await getOrCreateConfig(req.user._id, new Date(year || new Date().getFullYear(), (month || 1) - 1, 1), req.activeProfileId || null);
    const salaryComponents = config?.salaryComponents || [];

    for (const payroll of payrolls) {
      const empId = payroll.employeeSnapshot?.employeeId || payroll.employee?.employeeId || 'EMP';
      const mName = monthName(payroll.month);
      const filename = `Payslip_${empId}_${mName}_${payroll.year}.pdf`;
      const targetEmpId = payroll.employee?._id || payroll.employee || (payroll.employeeSnapshot && payroll.employeeSnapshot._id);
      const leaveBalance = await getEmployeeLeaveBalance(req.user._id, targetEmpId, payroll.year);
      
      const buffer = await generateSinglePayslipPdf({
        payroll,
        settings,
        browser,
        options: { leaveBalance, salaryComponents }
      });
      payslipFiles.push({ filename, buffer });
    }

    const zipBuffer = await createBulkPayslipsZip(payslipFiles);

    const archiveName = `Payslips_${month ? monthName(Number(month)) : 'Batch'}_${year || new Date().getFullYear()}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${archiveName}"`);
    return res.send(zipBuffer);
  } catch (error) {
    console.error('Error generating bulk payslip ZIP:', error);
    res.status(500).json({ message: 'Server error generating bulk payslip ZIP', error: error.message });
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.warn('Error closing shared browser in bulkPayslipPdf:', e.message);
      }
    }
  }
};

const emailPayslip = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    const payroll = await Payroll.findOne({ _id: req.params.id, user: req.user._id }).populate('employee');
    if (!payroll) return res.status(404).json({ message: 'Payroll not found' });

    const employeeEmail = payroll.employeeSnapshot?.email || payroll.employee?.email;
    if (!employeeEmail) {
      return res.status(400).json({ message: 'Employee email address is not configured.' });
    }

    const settings = await Settings.findOne({ user: req.user._id }).lean() || {};
    const companyName = settings.companyName || 'Flance';
    
    const smtpHost = process.env.SMTP_HOST || 'smtp.mailtrap.io';
    const smtpPort = Number(process.env.SMTP_PORT) || 2525;
    const smtpUser = process.env.SMTP_USER || '';
    const smtpPass = process.env.SMTP_PASS || '';
    const smtpSecure = process.env.SMTP_SECURE === 'true' || smtpPort === 465;

    const transportOptions = {
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      tls: {
        rejectUnauthorized: false
      }
    };
    if (smtpUser) {
      transportOptions.auth = {
        user: smtpUser,
        pass: smtpPass
      };
    }

    const targetEmpId = payroll.employee?._id || payroll.employee || (payroll.employeeSnapshot && payroll.employeeSnapshot._id);
    const leaveBalance = await getEmployeeLeaveBalance(req.user._id, targetEmpId, payroll.year);
    const { fyPayrolls, tdsMonths } = await getFyPayrollsAndTds(req.user._id, targetEmpId, payroll.month, payroll.year);

    const monthLabel = monthName(payroll.month);
    const payPeriodLabel = `${monthLabel} ${payroll.year}`;
    const employeeName = `${payroll.employeeSnapshot?.firstName || ''} ${payroll.employeeSnapshot?.lastName || ''}`.trim() || 'Employee';

    const config = await getOrCreateConfig(req.user._id, new Date(payroll.year, payroll.month - 1, 1), req.activeProfileId || payroll.profile || null);
    const salaryComponents = config?.salaryComponents || [];

    const emailHtmlBody = buildPayslipHtml(payroll, payroll.employee, settings, {
      leaveBalance,
      salaryComponents,
      taxWorksheetOptions: { fyPayrolls, tdsMonths }
    });

    // Generate real PDF attachment with leave balance & complete tax schedule
    const pdfBuffer = await generateSinglePayslipPdf({
      payroll,
      settings,
      options: {
        leaveBalance,
        salaryComponents,
        taxWorksheetOptions: { fyPayrolls, tdsMonths, salaryComponents }
      }
    });
    const attachmentFilename = `Payslip_${payroll.employeeSnapshot?.employeeId || 'EMP'}_${monthLabel}_${payroll.year}.pdf`;

    const brevoApiKey = process.env.BREVO_API_KEY || process.env.SMTP_PASS;
    const senderEmail = settings.email || process.env.EMAIL_FROM || process.env.SMTP_SENDER || 'payroll@flance.com';
    const senderName = `${companyName} HR & Payroll`;
    const subjectStr = `Payslip Statement for ${payPeriodLabel} - ${employeeName}`;

    let emailSent = false;

    // 1. Custom Tenant SMTP if enabled in Settings
    if (settings?.smtp?.enabled && settings.smtp.host) {
      try {
        console.log(`[EMAIL] Dispatching payslip via custom SMTP (${settings.smtp.host}) to ${employeeEmail}`);
        const mailService = require('../../utils/mailService');
        await mailService.sendMail({
          to: employeeEmail,
          subject: subjectStr,
          html: emailHtmlBody,
          attachments: [
            {
              filename: attachmentFilename,
              content: pdfBuffer,
              contentType: 'application/pdf',
            },
          ],
          settings,
        });
        emailSent = true;
      } catch (smtpErr) {
        console.error('[EMAIL] Custom SMTP failed, falling back to system mailer:', smtpErr.message);
      }
    }

    // 2. Try Brevo HTTP API (High reliability fallback)
    if (!emailSent && brevoApiKey && brevoApiKey.startsWith('xkeysib-')) {
      try {
        console.log(`[EMAIL] Dispatching payslip via Brevo API to ${employeeEmail}`);
        const brevoPayload = {
          sender: { name: senderName, email: senderEmail },
          to: [{ email: employeeEmail }],
          subject: subjectStr,
          htmlContent: emailHtmlBody,
          attachment: [
            {
              name: attachmentFilename,
              content: pdfBuffer.toString('base64'),
            }
          ]
        };

        const apiRes = await axios.post('https://api.brevo.com/v3/smtp/email', brevoPayload, {
          headers: {
            'api-key': brevoApiKey,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        });
        console.log(`[EMAIL] Brevo API Success messageId: ${apiRes.data?.messageId}`);
        emailSent = true;
      } catch (apiErr) {
        console.error('[EMAIL] Brevo API failed, falling back to system SMTP:', apiErr.response?.data || apiErr.message);
      }
    }

    // 3. Fallback to System Nodemailer SMTP
    if (!emailSent) {
      const mailService = require('../../utils/mailService');
      await mailService.sendMail({
        to: employeeEmail,
        subject: subjectStr,
        html: emailHtmlBody,
        attachments: [
          {
            filename: attachmentFilename,
            content: pdfBuffer,
            contentType: 'application/pdf',
          },
        ],
        settings: null, // triggers env fallback
      });
    }

    await Payroll.updateOne(
      { _id: payroll._id },
      {
        $push: {
          auditLog: {
            status: payroll.status,
            changedBy: 'System Auto-Email',
            changedById: req.user._id,
            changedAt: new Date(),
            netSalary: payroll.netSalary,
            notes: `Payslip email with PDF attachment successfully sent to ${employeeEmail}`
          }
        }
      }
    );

    res.json({ message: `Payslip email with PDF attachment successfully sent to ${employeeEmail}.` });
  } catch (error) {
    console.error('Error sending payslip email:', error.message);
    res.status(500).json({ message: `Failed to dispatch payslip email: ${error.message}` });
  }
};

module.exports = {
  generatePayslip,
  getPayslipPdf,
  bulkPayslipPdf,
  emailPayslip,
};
