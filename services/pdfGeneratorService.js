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
const { buildPayslipEarningsLineItems, buildPayslipDeductionsLineItems, buildTaxWorksheet } = require('../utils/payrollMath');
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

function computeTaxWorksheet(payroll, employee, options = {}) {
  if (payroll.taxWorksheet) return payroll.taxWorksheet;

  const fyPayrolls = Array.isArray(options) ? options : options?.fyPayrolls;
  const tdsMonthsInput = options?.tdsMonths || null;

  return buildTaxWorksheet({ payroll, employee, fyPayrolls, tdsMonthsInput });
}

/**
 * Builds clean, responsive A4 HTML template for payslip PDF (Spreadsheet Style).
 */
function buildPayslipHtml(payroll, employee, settings) {
  const companyName = settings?.companyName || 'Resource Gateway Consulting Private Limited';
  const companyLogo = settings?.logoUrl || '';
  const companyAddress = settings?.address || {};
  const addressLine = [
    companyAddress.line1 || 'C - 5/25, First Floor, Sector- 52',
    companyAddress.city || 'Gurgaon',
    companyAddress.state || 'Haryana',
    companyAddress.zip
  ].filter(Boolean).join(', ');

  const empSnap = payroll.employeeSnapshot || {};
  const emp = employee || payroll.employee || {};
  const firstName = empSnap.firstName || emp.firstName || '';
  const lastName = empSnap.lastName || emp.lastName || '';
  const employeeName = `${firstName} ${lastName}`.trim() || 'Employee';
  const empId = empSnap.employeeId || emp.employeeId || '-';
  const designation = empSnap.designation || emp.designation || '-';
  const deptName = emp.department?.name || empSnap.departmentName || '-';

  const monthLabel = monthName(payroll.month);
  const payPeriodLabel = `${monthLabel} ${payroll.year}`.toUpperCase();

  const isFnf = Boolean(payroll.isFullAndFinal || payroll.settlementType === 'full_and_final');
  const titleHeading = isFnf ? `FINAL SETTLEMENT STATEMENT — ${payPeriodLabel}` : `PAY SLIP FOR THE MONTH OF ${payPeriodLabel}`;

  const taxRegimeLabel = (emp.taxRegime || empSnap.taxRegime) === 'old' ? 'OLD TAX REGIME' : 'NEW TAX REGIME';

  // Calculations for Earnings & Deductions table
  const earningsItems = buildPayslipEarningsLineItems(payroll);
  const deductionsItems = buildPayslipDeductionsLineItems(payroll);

  const earnings = earningsItems.map(item => ({
    name: item.name,
    rate: item.amount,
    monthly: item.amount,
    arrear: item.details || '-'
  }));

  const deductions = deductionsItems.map(item => ({
    name: item.name + (item.details ? ` (${item.details})` : ''),
    amount: item.amount
  }));

  const maxRows = Math.max(earnings.length, deductions.length, 8);

  const totalEarningRate = earnings.reduce((sum, item) => sum + (Number(item.rate) || 0), 0);
  const totalEarningMonthly = earnings.reduce((sum, item) => sum + (Number(item.monthly) || 0), 0);
  const totalDeductions = deductions.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const netTakeHome = totalEarningMonthly - totalDeductions;

  // Tax Worksheet data
  const currentMonth = payroll.month;
  const currentYear = payroll.year;
  let startYear = currentYear;
  let endYear = currentYear;
  if (currentMonth !== undefined && currentYear !== undefined) {
    if (currentMonth >= 4) {
      startYear = currentYear;
      endYear = currentYear + 1;
    } else {
      startYear = currentYear - 1;
      endYear = currentYear;
    }
  }

  const worksheet = computeTaxWorksheet(payroll, emp);
  const compBreakdown = worksheet.componentBreakdown || [];
  const hraCalc = worksheet.hra || {};
  const tdsMonths = worksheet.tdsMonths || {};

  const decl = emp.declarations || empSnap.declarations || {};
  const epfVal = decl.epf || 0;
  const ppfVal = decl.ppf || 0;
  const homeLoanVal = decl.homeLoanPrincipal || 0;
  const licVal = decl.lic || 0;
  const elssVal = decl.elss || 0;
  const sec80CVal = decl.section80C || (epfVal + ppfVal + homeLoanVal + licVal + elssVal);
  const sec80CCapped = Math.min(150000, sec80CVal);
  const sec80DVal = decl.section80D || 0;
  const sec80CCDVal = decl.section80CCD1B || 0;
  const sec24bVal = decl.section24b || 0;
  const totalVIA = sec80CCapped + sec80DVal + sec80CCDVal;

  const monthsList = [
    { key: 4, name: 'April' },
    { key: 5, name: 'May' },
    { key: 6, name: 'June' },
    { key: 7, name: 'July' },
    { key: 8, name: 'August' },
    { key: 9, name: 'September' },
    { key: 10, name: 'October' },
    { key: 11, name: 'November' },
    { key: 12, name: 'December' },
    { key: 1, name: 'January' },
    { key: 2, name: 'February' },
    { key: 3, name: 'March' }
  ];

  let tableRowsHtml = '';
  for (let i = 0; i < maxRows; i++) {
    const earn = earnings[i] || null;
    const ded = deductions[i] || null;

    tableRowsHtml += `
      <tr>
        <td style="font-weight: 600; text-align: left;">${earn ? earn.name : ''}</td>
        <td style="text-align: right;">${earn ? formatCurrency(earn.rate) : ''}</td>
        <td style="text-align: right;">${earn ? formatCurrency(earn.monthly) : ''}</td>
        <td style="text-align: right; color: #666;">${earn ? earn.arrear : ''}</td>
        <td style="text-align: left;">${ded ? ded.name : ''}</td>
        <td style="font-weight: 600; text-align: right;">${ded ? formatCurrency(ded.amount) : ''}</td>
      </tr>
    `;
  }

  let compBreakdownHtml = '';
  compBreakdown.forEach(row => {
    compBreakdownHtml += `
      <tr>
        <td style="text-align: left; font-weight: 500;">${row.name}</td>
        <td style="text-align: right;">${formatCurrency(row.gross)}</td>
        <td style="text-align: right; color: #666;">${row.exempt ? formatCurrency(row.exempt) : '-'}</td>
        <td style="text-align: right;">${formatCurrency(row.taxable)}</td>
      </tr>
    `;
  });

  let tdsMonthsHtml = '';
  monthsList.forEach(m => {
    tdsMonthsHtml += `
      <tr>
        <td style="text-align: left; color: #4b5563;">${m.name}</td>
        <td style="text-align: right; font-weight: 500;">${formatCurrency(tdsMonths[m.key] || 0)}</td>
      </tr>
    `;
  });

  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <title>Payslip - ${employeeName} (${payPeriodLabel})</title>
    <style>
      @page {
        size: A4 portrait;
        margin: 6mm 8mm;
      }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: #000000;
        background: #ffffff;
        margin: 0;
        padding: 0;
        font-size: 9.5px;
        line-height: 1.35;
      }
      .sheet {
        border: 1px solid #000000;
        width: 100%;
        box-sizing: border-box;
      }
      .header-row {
        border-bottom: 1px solid #000000;
        padding: 8px 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .brand-title {
        font-size: 13px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: -0.01em;
      }
      .brand-sub {
        font-size: 8.5px;
        color: #374151;
        margin-top: 1px;
      }
      .heading-title {
        font-size: 10.5px;
        font-weight: 800;
        color: #0f172a;
        margin-top: 4px;
        letter-spacing: 0.02em;
      }
      .grid-table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }
      .grid-table td, .grid-table th {
        border-right: 1px solid #000000;
        border-bottom: 1px solid #000000;
        padding: 3.5px 5px;
        vertical-align: top;
        word-wrap: break-word;
      }
      .grid-table tr td:last-child, .grid-table tr th:last-child {
        border-right: none;
      }
      .bg-gray {
        background-color: #f3f4f6;
        font-weight: 700;
      }
      .bg-dark-section {
        background-color: #1e293b;
        color: #ffffff;
        font-weight: 800;
        text-align: center;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 3px 6px;
        border-bottom: 1px solid #000000;
      }
      .net-bar {
        background-color: #f3f4f6;
        border-bottom: 1px solid #000000;
        padding: 6px 12px;
        display: flex;
        justify-content: space-between;
        font-weight: 800;
        font-size: 11px;
      }
      .flex-between {
        display: flex;
        justify-content: space-between;
      }
      .text-muted { color: #4b5563; }
      .text-right { text-align: right; }
      .text-center { text-align: center; }
      .notice-footer {
        text-align: center;
        font-size: 8.5px;
        color: #6b7280;
        margin-top: 8px;
        letter-spacing: 0.05em;
      }
    </style>
  </head>
  <body>
    <div class="sheet">
      
      <!-- Company Header Block -->
      <div class="header-row">
        <div>
          ${companyLogo ? `<img src="${companyLogo}" style="max-height: 36px; margin-bottom: 4px; display: block;" />` : `<span style="font-weight: 800; font-size: 14px; color: #1e293b;">ResourceGateway</span>`}
        </div>
        <div style="text-align: center; flex: 1; padding: 0 10px;">
          <div class="brand-title">${companyName}</div>
          <div class="brand-sub">${addressLine}</div>
          <div class="heading-title">${titleHeading}</div>
        </div>
        <div style="font-weight: 800; font-size: 9px; text-align: right; white-space: nowrap;">
          ${taxRegimeLabel}
        </div>
      </div>

      <!-- Employee Information Grid -->
      <table class="grid-table">
        <tr>
          <td style="width: 33.33%;">
            <div class="flex-between"><span class="text-muted">Emp. Code</span> <span style="font-weight: 700;">${empId}</span></div>
            <div class="flex-between" style="margin-top: 2px;"><span class="text-muted">Name</span> <span style="font-weight: 700;">${employeeName}</span></div>
            <div class="flex-between" style="margin-top: 2px;"><span class="text-muted">Designation</span> <span style="font-weight: 700;">${designation}</span></div>
            <div class="flex-between" style="margin-top: 2px;"><span class="text-muted">Department</span> <span style="font-weight: 700;">${deptName}</span></div>
            <div class="flex-between" style="margin-top: 2px;"><span class="text-muted">Cost Centre</span> <span style="font-weight: 700;">TaaS</span></div>
            <div class="flex-between" style="margin-top: 2px;"><span class="text-muted">DOJ</span> <span style="font-weight: 700;">${formatDisplayDate(emp.joiningDate || empSnap.joiningDate)}</span></div>
          </td>
          <td style="width: 33.33%;">
            <div class="flex-between"><span class="text-muted">PF UAN No.</span> <span style="font-weight: 700;">${emp.uanNumber || empSnap.uanNumber || 'NA'}</span></div>
            <div class="flex-between" style="margin-top: 2px;"><span class="text-muted">Location</span> <span style="font-weight: 700;">${emp.location || empSnap.location || 'Gurgaon'}</span></div>
            <div class="flex-between" style="margin-top: 2px;"><span class="text-muted">Payment</span> <span style="font-weight: 700;">${payroll.paymentMethod || 'Bank Transfer'}</span></div>
            <div class="flex-between" style="margin-top: 2px;"><span class="text-muted">Bank A/c</span> <span style="font-weight: 700;">${emp.bankDetails?.accountNumber || empSnap.bankAccount || '-'}</span></div>
            <div class="flex-between" style="margin-top: 2px;"><span class="text-muted">PAN</span> <span style="font-weight: 700;">${emp.panNumber || empSnap.panNumber || '-'}</span></div>
            <div class="flex-between" style="margin-top: 2px;"><span class="text-muted">Gender</span> <span style="font-weight: 700;">${emp.gender || empSnap.gender || '-'}</span></div>
          </td>
          <td style="width: 33.34%;">
            <div class="flex-between"><span class="text-muted">Month Days</span> <span style="font-weight: 700;">${Number(payroll.workingDays || 30).toFixed(2)}</span></div>
            <div class="flex-between" style="margin-top: 2px;"><span class="text-muted">Payable Days</span> <span style="font-weight: 700;">${Number(payroll.paidDays || 30).toFixed(2)}</span></div>
            <div class="flex-between" style="margin-top: 2px;"><span class="text-muted">PF No.</span> <span style="font-weight: 700;">${emp.pfNumber || emp.pfNo || empSnap.pfNumber || 'NA'}</span></div>
            <div class="flex-between" style="margin-top: 2px;"><span class="text-muted">ESI No.</span> <span style="font-weight: 700;">${emp.esiNumber || empSnap.esiNumber || 'NA'}</span></div>
          </td>
        </tr>
      </table>

      <!-- Earnings / Deductions Subheader -->
      <table class="grid-table">
        <tr class="bg-gray text-center font-bold">
          <td style="width: 71.428%;">Earnings</td>
          <td style="width: 28.572%;">Deductions</td>
        </tr>
      </table>

      <!-- Earnings / Deductions Column Headers -->
      <table class="grid-table">
        <tr class="bg-gray font-bold text-center">
          <td style="width: 28.571%; text-align: left;">Description</td>
          <td style="width: 14.285%; text-align: right;">Rate</td>
          <td style="width: 14.285%; text-align: right;">Monthly</td>
          <td style="width: 14.287%; text-align: right;">Arrear</td>
          <td style="width: 14.285%; text-align: left;">Description</td>
          <td style="width: 14.287%; text-align: right;">Amount</td>
        </tr>
        ${tableRowsHtml}
        <!-- Totals Row -->
        <tr class="bg-gray font-bold">
          <td style="text-align: left;">CTC</td>
          <td style="text-align: right;">${formatCurrency(totalEarningRate)}</td>
          <td style="text-align: right;">${formatCurrency(totalEarningMonthly)}</td>
          <td style="text-align: right;">-</td>
          <td style="text-align: left;">Total Deduction</td>
          <td style="text-align: right;">${formatCurrency(totalDeductions)}</td>
        </tr>
      </table>

      <!-- Net Take Home Bar -->
      <div class="net-bar">
        <span>NET TAKE HOME FOR THE MONTH</span>
        <span style="font-size: 12px;">${formatCurrency(netTakeHome)}</span>
      </div>

      <!-- Income Tax Worksheet Banner -->
      <div class="bg-dark-section">
        Income Tax Worksheet for the period April ${startYear} - March ${endYear}
      </div>

      <!-- Tax Worksheet Main Grid (3 Columns) -->
      <table class="grid-table">
        <tr>
          <!-- Col 1-2: Component Breakdown & Tax Computations -->
          <td style="width: 40%; padding: 0;">
            <table class="grid-table" style="border: none;">
              <tr class="bg-gray font-bold text-center">
                <td style="text-align: left;">Description</td>
                <td style="text-align: right;">Gross</td>
                <td style="text-align: right;">Exempt</td>
                <td style="text-align: right;">Taxable</td>
              </tr>
              ${compBreakdownHtml}
              <tr class="bg-gray font-bold">
                <td style="text-align: left;">Gross Salary</td>
                <td style="text-align: right;">${formatCurrency(worksheet.grossSalary)}</td>
                <td style="text-align: right;">-</td>
                <td style="text-align: right;">${formatCurrency(worksheet.grossSalary)}</td>
              </tr>
              <tr>
                <td colspan="3" style="text-align: left;">Standard Deduction</td>
                <td style="text-align: right;">${formatCurrency(worksheet.standardDeduction)}</td>
              </tr>
              <tr class="bg-gray font-bold">
                <td colspan="3" style="text-align: left;">Taxable Income</td>
                <td style="text-align: right;">${formatCurrency(worksheet.taxableIncome)}</td>
              </tr>
              <tr>
                <td colspan="3" style="text-align: left;">Total Tax</td>
                <td style="text-align: right;">${formatCurrency(worksheet.totalTax)}</td>
              </tr>
              <tr>
                <td colspan="3" style="text-align: left;">Educational Cess (4%)</td>
                <td style="text-align: right;">${formatCurrency(worksheet.cess)}</td>
              </tr>
              <tr class="bg-gray font-bold">
                <td colspan="3" style="text-align: left;">Net Tax</td>
                <td style="text-align: right;">${formatCurrency(worksheet.netTax)}</td>
              </tr>
              <tr>
                <td colspan="3" style="text-align: left;">Tax Deducted Till Date</td>
                <td style="text-align: right;">${formatCurrency(worksheet.taxDeductedTillDate)}</td>
              </tr>
              <tr>
                <td colspan="3" style="text-align: left;">Tax to be Deducted</td>
                <td style="text-align: right;">${formatCurrency(worksheet.taxToDeducted)}</td>
              </tr>
              <tr class="bg-gray font-bold">
                <td colspan="3" style="text-align: left;">Tax Deduction this Month</td>
                <td style="text-align: right;">${formatCurrency(worksheet.taxDeductionThisMonth)}</td>
              </tr>
            </table>
          </td>

          <!-- Col 3-4: Chapter VI-A & 80C Deductions -->
          <td style="width: 40%; padding: 0;">
            <div class="bg-gray font-bold text-center" style="padding: 3.5px; border-bottom: 1px solid #000000;">
              Deduction Under Chapter VI-A
            </div>
            <div style="padding: 4px;">
              <div class="flex-between font-bold" style="border-bottom: 1px solid #e5e7eb; padding-bottom: 2px;">
                <span>Investments u/s 80C</span>
                <span>Amount</span>
              </div>
              <div class="flex-between text-muted" style="margin-top: 2px;"><span>Provident Fund (EPF)</span> <span>${formatCurrency(epfVal)}</span></div>
              <div class="flex-between text-muted" style="margin-top: 2px;"><span>Public Provident Fund (PPF)</span> <span>${formatCurrency(ppfVal)}</span></div>
              <div class="flex-between text-muted" style="margin-top: 2px;"><span>Principal - Housing Loan</span> <span>${formatCurrency(homeLoanVal)}</span></div>
              <div class="flex-between text-muted" style="margin-top: 2px;"><span>Life Insurance Premium</span> <span>${formatCurrency(licVal)}</span></div>
              <div class="flex-between text-muted" style="margin-top: 2px;"><span>ELSS Mutual Funds</span> <span>${formatCurrency(elssVal)}</span></div>
              <div class="flex-between font-bold" style="border-top: 1px solid #e5e7eb; margin-top: 4px; padding-top: 2px;">
                <span>Total of Investment u/s 80C</span>
                <span>${formatCurrency(sec80CVal)}</span>
              </div>
            </div>

            <div style="border-top: 1px solid #000000; padding: 4px;">
              <div class="flex-between font-bold" style="border-bottom: 1px solid #e5e7eb; padding-bottom: 2px;">
                <span>Section Details</span>
                <span>Value</span>
              </div>
              <div class="flex-between text-muted" style="margin-top: 2px;"><span>U/S 80C (Capped)</span> <span>${formatCurrency(sec80CCapped)}</span></div>
              <div class="flex-between text-muted" style="margin-top: 2px;"><span>U/S 80D (Medical)</span> <span>${formatCurrency(sec80DVal)}</span></div>
              <div class="flex-between text-muted" style="margin-top: 2px;"><span>U/S 80CCD (NPS)</span> <span>${formatCurrency(sec80CCDVal)}</span></div>
              <div class="flex-between text-muted" style="margin-top: 2px;"><span>Interest on Housing Loan u/s 24b</span> <span>${formatCurrency(sec24bVal)}</span></div>
              <div class="flex-between font-bold" style="border-top: 1px solid #e5e7eb; margin-top: 4px; padding-top: 2px;">
                <span>Total Deductions Chapter VI-A</span>
                <span>${formatCurrency(totalVIA)}</span>
              </div>
            </div>
          </td>

          <!-- Col 5: Month-wise TDS Detail -->
          <td style="width: 20%; padding: 0;">
            <div class="bg-gray font-bold text-center" style="padding: 3.5px; border-bottom: 1px solid #000000;">
              Tax Deducted Details
            </div>
            <table class="grid-table" style="border: none;">
              <tr class="bg-gray font-bold text-center">
                <td style="text-align: left;">Month</td>
                <td style="text-align: right;">Amount</td>
              </tr>
              ${tdsMonthsHtml}
            </table>
            <div style="border-top: 1px solid #000000; padding: 4px; background-color: #f9fafb;">
              <div class="flex-between font-bold" style="font-size: 8.5px;">
                <span>LEAVE BALANCE ON MONTH END</span>
                <span>0.00</span>
              </div>
            </div>
          </td>
        </tr>
      </table>

      <!-- HRA Calculation Section -->
      <div class="bg-dark-section">
        HRA Calculation
      </div>
      <table class="grid-table">
        <tr class="bg-gray font-bold text-center">
          <td>From</td>
          <td>To</td>
          <td>Rent Paid</td>
          <td>Actual HRA</td>
          <td>40/50% of Basic</td>
          <td>Rent - 10% of Basic</td>
          <td>Exempt HRA</td>
        </tr>
        <tr class="text-center">
          <td>April</td>
          <td>March</td>
          <td>${formatCurrency(hraCalc.rentPaid)}</td>
          <td>${formatCurrency(hraCalc.actualHRA)}</td>
          <td>${formatCurrency(hraCalc.basicPercent)}</td>
          <td>${formatCurrency(hraCalc.rentMinusBasic10)}</td>
          <td class="bg-gray font-bold">${formatCurrency(hraCalc.exemptHRA)}</td>
        </tr>
      </table>

    </div>

    <!-- Notice Footer -->
    <div class="notice-footer">
      THIS IS COMPUTER GENERATED PAY SLIP - SIGNATURE NOT REQUIRED.
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
  computeTaxWorksheet,
};
