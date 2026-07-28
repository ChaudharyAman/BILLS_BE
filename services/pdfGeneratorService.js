/**
 * services/pdfGeneratorService.js
 *
 * Server-side PDF generation service for payslips using Puppeteer,
 * pdf-lib encryption, and archiver ZIP bundling.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('@cantoo/pdf-lib');
const { buildPayslipEarningsLineItems, buildPayslipDeductionsLineItems } = require('../utils/payrollMath');
const { monthName } = require('../controllers/payroll/common');

function getArchiver() {
  return eval('require')('archiver');
}

function getPuppeteer() {
  return eval('require')('puppeteer');
}

function formatCurrency(val) {
  const num = Number(val) || 0;
  return `₹${num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDisplayDate(dString) {
  if (!dString) return '-';
  const d = new Date(dString);
  return isNaN(d.getTime()) ? '-' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Builds clean, responsive A4 HTML template for payslip PDF.
 */
function buildPayslipHtml(payroll, employee, settings) {
  const companyName = settings?.companyName || 'Flance';
  const companyLogo = settings?.logoUrl || '';
  const companySignature = settings?.signatureUrl || '';
  const companyAddress = settings?.address || {};
  const addressStr = [companyAddress.line1, companyAddress.line2, companyAddress.city, companyAddress.state, companyAddress.zip]
    .filter(Boolean).join(', ');

  const empSnap = payroll.employeeSnapshot || {};
  const empName = `${empSnap.firstName || employee?.firstName || ''} ${empSnap.lastName || employee?.lastName || ''}`.trim() || 'Employee';
  const empId = empSnap.employeeId || employee?.employeeId || '-';
  const designation = empSnap.designation || employee?.designation || '-';
  const deptName = employee?.department?.name || empSnap.departmentName || '-';

  const monthLabel = monthName(payroll.month);
  const payPeriodLabel = `${monthLabel} ${payroll.year}`;

  const earningsItems = buildPayslipEarningsLineItems(payroll);
  const deductionsItems = buildPayslipDeductionsLineItems(payroll);

  let earningsRows = '';
  earningsItems.forEach((item) => {
    earningsRows += `
      <tr>
        <td style="padding: 8px 10px; border-bottom: 1px solid #f1f5f9; color: #334155;">
          <div style="font-weight: 600; font-size: 13px;">${item.name}</div>
          ${item.details ? `<div style="font-size: 11px; color: #64748b;">${item.details}</div>` : ''}
        </td>
        <td style="padding: 8px 10px; border-bottom: 1px solid #f1f5f9; text-align: right; font-weight: 600; color: #0f172a; font-size: 13px;">${formatCurrency(item.amount)}</td>
      </tr>`;
  });

  let deductionsRows = '';
  deductionsItems.forEach((item) => {
    deductionsRows += `
      <tr>
        <td style="padding: 8px 10px; border-bottom: 1px solid #f1f5f9; color: #334155;">
          <div style="font-weight: 600; font-size: 13px;">${item.name}</div>
          ${item.details ? `<div style="font-size: 11px; color: #64748b;">${item.details}</div>` : ''}
        </td>
        <td style="padding: 8px 10px; border-bottom: 1px solid #f1f5f9; text-align: right; font-weight: 600; color: #e11d48; font-size: 13px;">-${formatCurrency(item.amount)}</td>
      </tr>`;
  });

  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <title>Payslip - ${empName} (${payPeriodLabel})</title>
    <style>
      @page {
        size: A4 portrait;
        margin: 12mm 15mm;
      }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        color: #0f172a;
        background: #ffffff;
        margin: 0;
        padding: 0;
        font-size: 12px;
        line-height: 1.4;
      }
      .header-table {
        width: 100%;
        border-bottom: 2px solid #0f172a;
        padding-bottom: 12px;
        margin-bottom: 16px;
      }
      .company-name {
        font-size: 22px;
        font-weight: 800;
        color: #0f172a;
        letter-spacing: -0.02em;
      }
      .subtitle {
        font-size: 13px;
        color: #475569;
        font-weight: 600;
        margin-top: 2px;
      }
      .details-grid {
        width: 100%;
        border-collapse: collapse;
        margin-bottom: 16px;
        background: #f8fafc;
        border-radius: 8px;
        border: 1px solid #e2e8f0;
      }
      .details-grid td {
        padding: 10px 12px;
        vertical-align: top;
        font-size: 12px;
      }
      .label-title {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        color: #64748b;
        letter-spacing: 0.05em;
        margin-bottom: 3px;
      }
      .val-bold {
        font-size: 13px;
        font-weight: 700;
        color: #0f172a;
      }
      .val-text {
        color: #334155;
        font-size: 12px;
      }
      .tables-container {
        width: 100%;
        border-collapse: collapse;
        margin-bottom: 16px;
      }
      .tables-container td {
        vertical-align: top;
      }
      .item-table {
        width: 100%;
        border-collapse: collapse;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        overflow: hidden;
      }
      .item-table th {
        background: #f1f5f9;
        padding: 8px 10px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        color: #475569;
        border-bottom: 1px solid #cbd5e1;
        text-align: left;
      }
      .item-table th.right {
        text-align: right;
      }
      .item-table tr.total-row td {
        background: #f8fafc;
        font-weight: 700;
        border-top: 2px solid #cbd5e1;
        font-size: 13px;
        color: #0f172a;
      }
      .net-box {
        width: 100%;
        background: #f0fdf4;
        border: 1px solid #86efac;
        border-radius: 8px;
        padding: 14px 18px;
        margin-bottom: 16px;
      }
      .net-title {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        color: #166534;
        letter-spacing: 0.05em;
      }
      .net-amount {
        font-size: 26px;
        font-weight: 800;
        color: #15803d;
        margin: 4px 0;
      }
      .net-sub {
        font-size: 11px;
        color: #166534;
      }
      .footer-section {
        margin-top: 20px;
        padding-top: 12px;
        border-top: 1px solid #e2e8f0;
        width: 100%;
      }
      .signature-img {
        max-height: 48px;
        margin-top: 6px;
      }
      .badge-status {
        display: inline-block;
        padding: 4px 10px;
        background: #0f172a;
        color: #ffffff;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
      }
    </style>
  </head>
  <body>
    <table class="header-table" border="0" cellpadding="0" cellspacing="0">
      <tr>
        <td style="vertical-align: middle;">
          ${companyLogo ? `<img src="${companyLogo}" style="max-height: 50px; margin-bottom: 6px; display: block;" />` : ''}
          <div class="company-name">${companyName}</div>
          ${addressStr ? `<div style="font-size: 11px; color: #475569; margin-top: 2px;">${addressStr}</div>` : ''}
          <div class="subtitle">Payslip for ${payPeriodLabel}</div>
        </td>
        <td align="right" style="vertical-align: top;">
          <div class="badge-status">${payroll.status || 'PAID'}</div>
          ${settings?.pan ? `<div style="font-size: 11px; color: #64748b; margin-top: 8px;">PAN: ${settings.pan}</div>` : ''}
          ${settings?.gstin ? `<div style="font-size: 11px; color: #64748b;">GSTIN: ${settings.gstin}</div>` : ''}
        </td>
      </tr>
    </table>

    <table class="details-grid" border="0" cellpadding="0" cellspacing="0">
      <tr>
        <td width="33%">
          <div class="label-title">Employee Details</div>
          <div class="val-bold">${empName}</div>
          <div class="val-text">Emp ID: ${empId}</div>
          <div class="val-text">Designation: ${designation}</div>
          <div class="val-text">Department: ${deptName}</div>
        </td>
        <td width="33%" style="border-left: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0;">
          <div class="label-title">Attendance & Cycle</div>
          <div class="val-bold">Pay Period: ${payPeriodLabel}</div>
          <div class="val-text">Working Days: ${payroll.workingDays || 0}</div>
          <div class="val-text">Paid Days: ${payroll.paidDays || 0} (LOP: ${payroll.lop || 0})</div>
          ${payroll.payType === 'hourly' ? `<div class="val-text">Hours Worked: ${payroll.hoursWorked || 0} hrs</div>` : ''}
        </td>
        <td width="34%">
          <div class="label-title">Payment & Statutory</div>
          <div class="val-text">Bank Name: ${employee?.bankDetails?.bankName || '-'}</div>
          <div class="val-text">Account No: ${employee?.bankDetails?.accountNumber || empSnap.bankAccount || '-'}</div>
          <div class="val-text">PAN: ${employee?.panNumber || empSnap.panNumber || '-'}</div>
          <div class="val-text">UAN: ${employee?.uanNumber || empSnap.uanNumber || '-'}</div>
        </td>
      </tr>
    </table>

    <table class="tables-container" border="0" cellpadding="0" cellspacing="0">
      <tr>
        <td width="49%" style="padding-right: 1%;">
          <table class="item-table" border="0" cellpadding="0" cellspacing="0">
            <thead>
              <tr>
                <th>Earnings</th>
                <th class="right">Amount</th>
              </tr>
            </thead>
            <tbody>
              ${earningsRows}
              <tr class="total-row">
                <td style="padding: 10px;">Total Earnings</td>
                <td class="right" style="padding: 10px;">${formatCurrency(payroll.earnings?.totalEarnings)}</td>
              </tr>
            </tbody>
          </table>
        </td>

        <td width="49%" style="padding-left: 1%;">
          <table class="item-table" border="0" cellpadding="0" cellspacing="0">
            <thead>
              <tr>
                <th>Deductions</th>
                <th class="right">Amount</th>
              </tr>
            </thead>
            <tbody>
              ${deductionsRows}
              <tr class="total-row">
                <td style="padding: 10px;">Total Deductions</td>
                <td class="right" style="padding: 10px; color: #e11d48;">${formatCurrency(payroll.deductions?.totalDeductions)}</td>
              </tr>
            </tbody>
          </table>
        </td>
      </tr>
    </table>

    <div class="net-box">
      <table width="100%" border="0" cellpadding="0" cellspacing="0">
        <tr>
          <td>
            <div class="net-title">Net Salary Payable</div>
            <div class="net-amount">${formatCurrency(payroll.netSalary)}</div>
            <div class="net-sub">Payment Mode: ${payroll.paymentMethod || 'Bank Transfer'} ${payroll.transactionId ? `| Txn Ref: ${payroll.transactionId}` : ''} ${payroll.paymentDate ? `| Paid On: ${formatDisplayDate(payroll.paymentDate)}` : ''}</div>
          </td>
        </tr>
      </table>
    </div>

    <div class="footer-section">
      <table width="100%" border="0" cellpadding="0" cellspacing="0">
        <tr>
          <td style="font-size: 11px; color: #64748b; vertical-align: bottom;">
            <div>This is a computer-generated payslip document and does not require a physical signature unless mandated.</div>
            <div style="margin-top: 4px; font-weight: 600;">Generated on ${formatDisplayDate(new Date())}</div>
          </td>
          ${companySignature ? `
          <td align="right" style="vertical-align: bottom;">
            <div style="font-size: 11px; font-weight: 700; color: #475569; margin-bottom: 2px;">Authorized Signatory</div>
            <img src="${companySignature}" class="signature-img" />
          </td>` : ''}
        </tr>
      </table>
    </div>
  </body>
  </html>
  `;
}

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads', 'payslips');

function ensureUploadsDirExists() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

function getStoredPayslipPath(payrollId) {
  ensureUploadsDirExists();
  return path.join(UPLOADS_DIR, `payslip_${payrollId}.pdf`);
}

/**
 * Renders HTML string to PDF buffer via Puppeteer.
 */
async function renderHtmlToPdf(htmlString) {
  const puppeteer = getPuppeteer();
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(htmlString, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '12mm', right: '12mm' },
    });
    return Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}

/**
 * Encrypts a PDF Buffer using @cantoo/pdf-lib with user/owner password.
 */
async function encryptPdfBuffer(pdfBuffer, userPassword) {
  if (!userPassword) return pdfBuffer;
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  pdfDoc.encrypt({
    userPassword: String(userPassword),
    ownerPassword: String(userPassword) + '_owner',
    permissions: {
      printing: 'highResolution',
      modifying: false,
      copying: false,
      annotating: false,
      fillingForms: false,
      contentAccessibility: true,
      documentAssembly: false,
    },
  });
  const encryptedBytes = await pdfDoc.save();
  return Buffer.from(encryptedBytes);
}

/**
 * Generates single PDF buffer for a payroll record.
 */
async function generateSinglePayslipPdf({ payroll, settings, userPassword = null }) {
  const html = buildPayslipHtml(payroll, payroll.employee, settings);
  const rawPdfBuffer = await renderHtmlToPdf(html);
  if (userPassword) {
    return encryptPdfBuffer(rawPdfBuffer, userPassword);
  }
  return rawPdfBuffer;
}

/**
 * Packs multiple payslip PDF buffers into a ZIP archive buffer.
 */
async function createBulkPayslipsZip(payslipFiles) {
  const archiver = getArchiver();
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const buffers = [];

    archive.on('data', (data) => buffers.push(data));
    archive.on('end', () => resolve(Buffer.concat(buffers)));
    archive.on('error', (err) => reject(err));

    payslipFiles.forEach(({ filename, buffer }) => {
      archive.append(buffer, { name: filename });
    });

    archive.finalize();
  });
}

module.exports = {
  buildPayslipHtml,
  renderHtmlToPdf,
  encryptPdfBuffer,
  generateSinglePayslipPdf,
  createBulkPayslipsZip,
  getStoredPayslipPath,
};
