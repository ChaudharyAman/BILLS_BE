/**
 * controllers/payroll/payslip.js
 *
 * Payslip generation and email dispatch endpoints.
 */

const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const Payroll = require('../../models/Payroll');
const Settings = require('../../models/Settings');
const { getSalarySplits, buildPayslipEarningsLineItems, buildPayslipDeductionsLineItems } = require('../../utils/payrollMath');
const { monthName, getOrCreateConfig } = require('./common');

const {
  generateSinglePayslipPdf,
  createBulkPayslipsZip,
  getStoredPayslipPath,
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

    const config = await getOrCreateConfig(req.user._id);
    const adjustments = {
      pfEnabled: payroll.employeeSnapshot?.pfEnabled,
      esiEnabled: payroll.employeeSnapshot?.esiEnabled,
      ptEnabled: payroll.employeeSnapshot?.ptEnabled,
      ptState: payroll.employeeSnapshot?.ptState || '',
      lwfEnabled: payroll.employeeSnapshot?.lwfEnabled,
      gratuityEnabled: payroll.employeeSnapshot?.gratuityEnabled,
      includePfInCTC: payroll.employeeSnapshot?.includePfInCTC,
      includeGratuityInCTC: payroll.employeeSnapshot?.includeGratuityInCTC,
      lopStrategy: payroll.lopStrategy || 'proportional',
      segmentLops: payroll.segmentLops || [],
    };
    const employeeData = payroll.employee || {
      ...payroll.employeeSnapshot,
      payType: payroll.payType,
      hourlyRate: payroll.hourlyRate,
      _id: payroll.populated('employee') || payroll.employee
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

    const regime = employeeData.taxRegime || 'new';
    const isOld = regime === 'old';
    const standardDeduction = isOld ? 50000 : 75000;

    const rentPaidMonthly = employeeData.declarations?.rentPaidMonthly || 0;
    const monthsCount = fyPayrolls.length || 1;
    const rentPaidTotal = rentPaidMonthly * monthsCount;
    const basic_10 = basicGross * 0.1;
    const rentMinusBasic10 = Math.max(0, rentPaidTotal - basic_10);
    const isMetro = employeeData.declarations?.isMetroCity || false;
    const basicPercent = basicGross * (isMetro ? 0.5 : 0.4);
    const exemptHra = isOld ? Math.round(Math.min(hraGross, rentMinusBasic10, basicPercent)) : 0;

    const componentBreakdown = [
      { name: 'Basic', gross: basicGross, exempt: 0, taxable: basicGross },
      { name: 'HRA', gross: hraGross, exempt: exemptHra, taxable: hraGross - exemptHra },
      { name: 'Flexi Allowance', gross: flexiGross, exempt: 0, taxable: flexiGross },
      { name: 'Special Allowance', gross: specialGross, exempt: 0, taxable: specialGross },
      { name: 'Meal', gross: mealGross, exempt: 0, taxable: mealGross },
      { name: 'Broadband', gross: broadbandGross, exempt: 0, taxable: broadbandGross },
      { name: 'Other', gross: otherGross, exempt: 0, taxable: otherGross },
      { name: 'Bonus', gross: bonusGross, exempt: 0, taxable: bonusGross },
      { name: 'Arrear', gross: arrearGross, exempt: 0, taxable: arrearGross }
    ];

    const grossSalary = basicGross + hraGross + flexiGross + specialGross + mealGross + broadbandGross + otherGross + bonusGross + arrearGross;
    const taxableIncome = Math.max(0, grossSalary - exemptHra - standardDeduction);

    let totalTax = 0;
    if (regime === 'new') {
      let temp = taxableIncome;
      if (temp > 2000000) {
        totalTax += (temp - 2000000) * 0.3;
        temp = 2000000;
      }
      if (temp > 1600000) {
        totalTax += (temp - 1600000) * 0.2;
        temp = 1600000;
      }
      if (temp > 1200000) {
        totalTax += (temp - 1200000) * 0.15;
        temp = 1200000;
      }
      if (temp > 800000) {
        totalTax += (temp - 800000) * 0.1;
        temp = 800000;
      }
      if (temp > 400000) {
        totalTax += (temp - 400000) * 0.05;
      }
      if (taxableIncome <= 700000) {
        totalTax = 0;
      }
    } else {
      let temp = taxableIncome;
      if (temp > 1000000) {
        totalTax += (temp - 1000000) * 0.3;
        temp = 1000000;
      }
      if (temp > 500000) {
        totalTax += (temp - 500000) * 0.2;
        temp = 500000;
      }
      if (temp > 250000) {
        totalTax += (temp - 250000) * 0.05;
      }
      if (taxableIncome <= 500000) {
        totalTax = 0;
      }
    }

    const cess = Math.round(totalTax * 0.04 * 100) / 100;
    const netTax = Math.round((totalTax + cess) * 100) / 100;

    const taxDeductedTillDate = Object.values(tdsMonths).reduce((s, v) => s + v, 0);
    const taxToDeducted = Math.max(0, netTax - taxDeductedTillDate);
    const taxDeductionThisMonth = Number(payroll.deductions?.tds || 0);

    const taxWorksheet = {
      regime,
      componentBreakdown,
      grossSalary,
      standardDeduction,
      taxableIncome,
      totalTax,
      cess,
      netTax,
      taxDeductedTillDate,
      taxToDeducted,
      taxDeductionThisMonth,
      tdsMonths,
      hra: {
        from: 'April',
        to: 'March',
        rentPaid: rentPaidTotal,
        actualHRA: hraGross,
        basicPercent,
        rentMinusBasic10,
        exemptHRA: exemptHra
      }
    };

    res.json({
      payslip: {
        employee: payroll.employee || employeeData,
        period: {
          month: payroll.month,
          year: payroll.year,
          monthName: monthName(payroll.month),
        },
        salarySplits: (payroll.salarySplits && payroll.salarySplits.length > 0) ? payroll.salarySplits : splits,
        earningsLineItems: buildPayslipEarningsLineItems(payroll),
        deductionsLineItems: buildPayslipDeductionsLineItems(payroll),
        periodInput: payroll.periodInput || {},
        isFullAndFinal: Boolean(payroll.isFullAndFinal || payroll.settlementType === 'full_and_final'),
        settlementType: payroll.settlementType || (payroll.isFullAndFinal ? 'full_and_final' : 'monthly'),
        fnfDetails: payroll.fnfDetails || null,
        complianceNotes: (() => {
          const notes = [];
          if (payroll.netSalary === 0 && payroll.deductions?.totalDeductions > payroll.earnings?.totalEarnings) {
            notes.push('Note: Net salary was clamped to ₹0 due to non-statutory deduction shortfall.');
          }
          return notes;
        })(),
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

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: smtpUser,
        pass: smtpPass
      },
      tls: {
        rejectUnauthorized: false
      }
    });

    const monthLabel = monthName(payroll.month);
    const payPeriodLabel = `${monthLabel} ${payroll.year}`;
    const employeeName = `${payroll.employeeSnapshot?.firstName || ''} ${payroll.employeeSnapshot?.lastName || ''}`.trim() || 'Employee';

    const fmt = (val) => `INR ${(Number(val) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    let earningsRows = '';
    const lineItems = buildPayslipEarningsLineItems(payroll);
    lineItems.forEach((item) => {
      earningsRows += `
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #f1f5f9; color: #475569;">
            <div style="font-weight: 500;">${item.name}</div>
            ${item.details ? `<div style="font-size: 11px; color: #94a3b8;">${item.details}</div>` : ''}
          </td>
          <td style="padding: 10px; border-bottom: 1px solid #f1f5f9; text-align: right; font-weight: 500; color: #1e293b;">${fmt(item.amount)}</td>
        </tr>`;
    });

    let deductionsRows = '';
    const deductionItems = buildPayslipDeductionsLineItems(payroll);
    deductionItems.forEach((item) => {
      deductionsRows += `
        <tr>
          <td style="padding: 10px; border-bottom: 1px solid #f1f5f9; color: #475569;">
            <div style="font-weight: 500;">${item.name}</div>
            ${item.details ? `<div style="font-size: 11px; color: #94a3b8;">${item.details}</div>` : ''}
          </td>
          <td style="padding: 10px; border-bottom: 1px solid #f1f5f9; text-align: right; font-weight: 500; color: #e11d48;">-${fmt(item.amount)}</td>
        </tr>`;
    });

    const emailHtmlBody = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Payslip for ${payPeriodLabel}</title>
      </head>
      <body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
        <table align="center" border="0" cellpadding="0" cellspacing="0" width="600" style="margin: 40px auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1); border: 1px solid #e2e8f0;">
          <tr>
            <td bgcolor="#0f172a" style="padding: 30px 40px; color: #ffffff;">
              <table width="100%" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <h1 style="margin: 0; font-size: 24px; font-weight: 700; tracking-tight: -0.025em;">${companyName}</h1>
                    <p style="margin: 5px 0 0 0; font-size: 14px; color: #94a3b8;">Salary Statement / Pay Slip</p>
                  </td>
                  <td align="right" style="vertical-align: top;">
                    <span style="background-color: rgba(255,255,255,0.1); padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; text-transform: uppercase;">${payroll.status}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <tr>
            <td style="padding: 30px 40px;">
              <table width="100%" border="0" cellpadding="0" cellspacing="0" style="margin-bottom: 25px;">
                <tr>
                  <td width="50%" style="vertical-align: top;">
                    <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #64748b; letter-spacing: 0.1em; margin-bottom: 5px;">Employee Details</div>
                    <div style="font-size: 15px; font-weight: 600; color: #0f172a;">${employeeName}</div>
                    <div style="font-size: 13px; color: #475569; margin-top: 2px;">ID: ${payroll.employeeSnapshot?.employeeId || '-'}</div>
                    <div style="font-size: 13px; color: #475569;">Designation: ${payroll.employeeSnapshot?.designation || '-'}</div>
                  </td>
                  <td width="50%" style="vertical-align: top; padding-left: 20px; border-left: 1px solid #e2e8f0;">
                    <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: #64748b; letter-spacing: 0.1em; margin-bottom: 5px;">Payroll Cycle</div>
                    <div style="font-size: 15px; font-weight: 600; color: #0f172a;">${payPeriodLabel}</div>
                    <div style="font-size: 13px; color: #475569; margin-top: 2px;">Working Days: ${payroll.workingDays}</div>
                    <div style="font-size: 13px; color: #475569;">Paid Days: ${payroll.paidDays} (LOP: ${payroll.lop})</div>
                  </td>
                </tr>
              </table>
              
              <table width="100%" border="0" cellpadding="0" cellspacing="0" style="margin-bottom: 25px;">
                <tr>
                  <td width="50%" style="vertical-align: top; padding-right: 15px;">
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" style="border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; font-size: 13px;">
                      <tr bgcolor="#f8fafc">
                        <td style="padding: 10px 12px; font-weight: 700; color: #475569; border-bottom: 1px solid #e2e8f0;">Earnings</td>
                        <td style="padding: 10px 12px; font-weight: 700; color: #475569; border-bottom: 1px solid #e2e8f0; text-align: right;">Amount</td>
                      </tr>
                      ${earningsRows}
                      <tr bgcolor="#f8fafc" style="font-weight: 700;">
                        <td style="padding: 12px 10px; color: #0f172a;">Total Earnings</td>
                        <td style="padding: 12px 10px; text-align: right; color: #0f172a;">${fmt(payroll.earnings?.totalEarnings)}</td>
                      </tr>
                    </table>
                  </td>
                  
                  <td width="50%" style="vertical-align: top; padding-left: 15px;">
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" style="border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; font-size: 13px;">
                      <tr bgcolor="#f8fafc">
                        <td style="padding: 10px 12px; font-weight: 700; color: #475569; border-bottom: 1px solid #e2e8f0;">Deductions</td>
                        <td style="padding: 10px 12px; font-weight: 700; color: #475569; border-bottom: 1px solid #e2e8f0; text-align: right;">Amount</td>
                      </tr>
                      ${deductionsRows}
                      <tr bgcolor="#f8fafc" style="font-weight: 700;">
                        <td style="padding: 12px 10px; color: #0f172a;">Total Deductions</td>
                        <td style="padding: 12px 10px; text-align: right; color: #0f172a;">${fmt(payroll.deductions?.totalDeductions)}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              
              <table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; margin-bottom: 25px;">
                <tr>
                  <td style="padding: 20px 24px;">
                    <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; color: #166534; letter-spacing: 0.1em;">Net Take Home Salary</div>
                    <div style="font-size: 28px; font-weight: 800; color: #166534; margin-top: 5px;">${fmt(payroll.netSalary)}</div>
                    <div style="font-size: 12px; color: #15803d; margin-top: 4px;">Payment Method: ${payroll.paymentMethod || 'Bank Transfer'} ${payroll.transactionId ? `(Txn: ${payroll.transactionId})` : ''}</div>
                  </td>
                </tr>
              </table>
              
              <table width="100%" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size: 12px; line-height: 18px; color: #64748b;">
                    <strong>Notes:</strong> ${payroll.remarks || payroll.notes || 'This is a system-generated statement. Please login to the employee portal to download/print your official PDF document.'}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <tr>
            <td bgcolor="#f8fafc" style="padding: 20px 40px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 12px; color: #94a3b8;">
              &copy; ${new Date().getFullYear()} ${companyName}. All rights reserved.
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    // Generate real PDF attachment
    const pdfBuffer = await generateSinglePayslipPdf({ payroll, settings });
    const attachmentFilename = `Payslip_${payroll.employeeSnapshot?.employeeId || 'EMP'}_${monthLabel}_${payroll.year}.pdf`;

    await transporter.sendMail({
      from: `"${companyName} HR & Payroll" <${process.env.SMTP_SENDER || 'payroll@flance.local'}>`,
      to: employeeEmail,
      subject: `Payslip Statement for ${payPeriodLabel} - ${employeeName}`,
      html: emailHtmlBody,
      attachments: [
        {
          filename: attachmentFilename,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    payroll.auditLog.push({
      status: payroll.status,
      changedBy: 'System Auto-Email',
      changedById: req.user._id,
      changedAt: new Date(),
      netSalary: payroll.netSalary,
      notes: `Payslip email with PDF attachment successfully sent to ${employeeEmail}`
    });
    await payroll.save();

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
