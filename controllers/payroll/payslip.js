/**
 * controllers/payroll/payslip.js
 *
 * Payslip generation and email dispatch endpoints.
 */

const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const axios = require('axios');
const Payroll = require('../../models/Payroll');
const Settings = require('../../models/Settings');
const LeaveBalance = require('../../models/LeaveBalance');
const { getSalarySplits, buildPayslipEarningsLineItems, buildPayslipDeductionsLineItems, calculateTaxForRegime } = require('../../utils/payrollMath');
const { monthName, getOrCreateConfig } = require('./common');

const {
  generateSinglePayslipPdf,
  createBulkPayslipsZip,
  getStoredPayslipPath,
  buildPayslipHtml,
  computeTaxWorksheet,
} = require('../../services/pdfGeneratorService');
const fs = require('fs');

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

    const config = await getOrCreateConfig(req.user._id);
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

    const currentMonth = payroll.month;
    const currentYear = payroll.year;
    let startYear, endYear;
    if (currentMonth >= 4) {
      startYear = currentYear;
      endYear = currentYear + 1;
    } else {
      startYear = currentYear - 1;
      endYear = currentYear;
    }

    const fyPayrolls = await Payroll.find({
      user: req.user._id,
      employee: employeeData._id,
      $or: [
        { year: startYear, month: { $gte: 4 } },
        { year: endYear, month: { $lte: 3 } }
      ]
    }).sort({ year: 1, month: 1 });

    let basicGross = 0;
    let hraGross = 0;
    let flexiGross = 0;
    let specialGross = 0;
    let mealGross = 0;
    let broadbandGross = 0;
    let otherGross = 0;
    let bonusGross = 0;
    let arrearGross = 0;

    const tdsMonths = {
      4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0, 12: 0, 1: 0, 2: 0, 3: 0
    };

    for (const pr of fyPayrolls) {
      basicGross += Number(pr.earnings?.basic || 0);
      hraGross += Number(pr.earnings?.hra || 0);
      flexiGross += Number(pr.earnings?.flexiAmount || pr.earnings?.flexi || 0);
      specialGross += Number(pr.earnings?.specialAllowance || pr.earnings?.special || 0);
      mealGross += Number(pr.earnings?.mealAllowance || pr.earnings?.meal || 0);
      broadbandGross += Number(pr.earnings?.broadband || 0);
      
      let otherVal = Number(pr.earnings?.petrol || 0) + 
                     Number(pr.earnings?.lta || 0) + 
                     Number(pr.earnings?.conveyance || 0) + 
                     Number(pr.earnings?.medicalAllowance || 0);
      if (Array.isArray(pr.earnings?.otherEarnings)) {
        otherVal += pr.earnings.otherEarnings.reduce((s, o) => s + (Number(o.amount) || 0), 0);
      }
      otherGross += otherVal;

      let bonusVal = 0;
      if (pr.variablePay) {
        bonusVal += Number(pr.variablePay.joiningBonus || 0) +
                    Number(pr.variablePay.loyaltyBonus || 0) +
                    Number(pr.variablePay.incentive || 0) +
                    Number(pr.variablePay.specialBonus || 0) +
                    Number(pr.variablePay.otherAllowanceArrear || 0);
      }
      bonusGross += bonusVal;

      if (pr.deductions?.tds && pr.month in tdsMonths) {
        tdsMonths[pr.month] = Number(pr.deductions.tds) || 0;
      }
    }

    let leaveBalance = 0;
    try {
      const targetEmpId = payroll.employee || (payroll.employeeSnapshot && payroll.employeeSnapshot._id);
      if (targetEmpId) {
        const balances = await LeaveBalance.find({
          user: req.user._id,
          employee: targetEmpId,
          year: payroll.year || new Date().getFullYear(),
        });
        if (balances && balances.length > 0) {
          leaveBalance = balances.reduce((sum, b) => sum + (Number(b.closing) || 0), 0);
        }
      }
    } catch (e) {
      console.warn('[Payslip] Could not fetch leave balance:', e.message);
    }

    const taxWorksheet = computeTaxWorksheet(payroll, employeeData, { fyPayrolls, tdsMonths });

    res.json({
      payslip: {
        employee: employeeData,
        period: {
          month: payroll.month,
          year: payroll.year,
          monthName: monthName(payroll.month),
        },
        leaveBalance: Number(leaveBalance) || 0,
        salarySplits: (payroll.salarySplits && payroll.salarySplits.length > 0) ? payroll.salarySplits : splits,
        earningsLineItems: buildPayslipEarningsLineItems(payroll),
        deductionsLineItems: buildPayslipDeductionsLineItems(payroll),
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
      const day = String(dateRef.getDate()).padStart(2, '0');
      const month = String(dateRef.getMonth() + 1).padStart(2, '0');
      userPassword = `${namePart}${day}${month}`;
    }

    // Serve persisted file for non-encrypted paid payrolls if available
    const storedPath = getStoredPayslipPath(payroll._id);
    if (!isEncryptedReq && payroll.status === 'paid' && fs.existsSync(storedPath)) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="Payslip_${payroll.employeeSnapshot?.employeeId || 'EMP'}_${monthName(payroll.month)}_${payroll.year}.pdf"`);
      return fs.createReadStream(storedPath).pipe(res);
    }

    const pdfBuffer = await generateSinglePayslipPdf({ payroll, settings, userPassword });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Payslip_${payroll.employeeSnapshot?.employeeId || 'EMP'}_${monthName(payroll.month)}_${payroll.year}.pdf"`);
    return res.send(pdfBuffer);
  } catch (error) {
    console.error('Error generating PDF payslip:', error);
    res.status(500).json({ message: 'Server error generating PDF payslip', error: error.message });
  }
};

const bulkPayslipPdf = async (req, res) => {
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

    for (const payroll of payrolls) {
      const empId = payroll.employeeSnapshot?.employeeId || payroll.employee?.employeeId || 'EMP';
      const mName = monthName(payroll.month);
      const filename = `Payslip_${empId}_${mName}_${payroll.year}.pdf`;
      const buffer = await generateSinglePayslipPdf({ payroll, settings });
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

    const transporter = nodemailer.createTransport(transportOptions);

    const monthLabel = monthName(payroll.month);
    const payPeriodLabel = `${monthLabel} ${payroll.year}`;
    const employeeName = `${payroll.employeeSnapshot?.firstName || ''} ${payroll.employeeSnapshot?.lastName || ''}`.trim() || 'Employee';

    const emailHtmlBody = buildPayslipHtml(payroll, payroll.employee, settings);

    // Generate real PDF attachment
    const pdfBuffer = await generateSinglePayslipPdf({ payroll, settings });
    const attachmentFilename = `Payslip_${payroll.employeeSnapshot?.employeeId || 'EMP'}_${monthLabel}_${payroll.year}.pdf`;

    const brevoApiKey = process.env.BREVO_API_KEY || process.env.SMTP_PASS;
    const senderEmail = process.env.EMAIL_FROM || process.env.SMTP_SENDER || 'ilumaaventures@gmail.com';
    const senderName = `${companyName} HR & Payroll`;
    const subjectStr = `Payslip Statement for ${payPeriodLabel} - ${employeeName}`;

    let emailSent = false;

    // 1. Try Brevo HTTP API first (High reliability)
    if (brevoApiKey && brevoApiKey.startsWith('xkeysib-')) {
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
        console.error('[EMAIL] Brevo API failed, falling back to SMTP:', apiErr.response?.data || apiErr.message);
      }
    }

    // 2. Fallback to Nodemailer SMTP
    if (!emailSent) {
      const smtpHost = process.env.SMTP_HOST || process.env.EMAIL_HOST || 'smtp-relay.brevo.com';
      const smtpPort = Number(process.env.SMTP_PORT || process.env.EMAIL_PORT) || 587;
      const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER || '';
      const smtpPass = process.env.SMTP_PASS || brevoApiKey || '';
      const smtpSecure = process.env.SMTP_SECURE === 'true' || smtpPort === 465;

      const transportOptions = {
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        tls: { rejectUnauthorized: false }
      };
      if (smtpUser) {
        transportOptions.auth = { user: smtpUser, pass: smtpPass };
      }

      const transporter = nodemailer.createTransport(transportOptions);
      await transporter.sendMail({
        from: `"${senderName}" <${senderEmail}>`,
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
