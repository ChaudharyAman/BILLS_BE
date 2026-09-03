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

function formatVal(val, showDash = true) {
  if (val === null || val === undefined || val === '' || Number(val) === 0) {
    return showDash ? '-' : '';
  }
  const n = Number(val);
  if (isNaN(n)) return val;
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function formatCurrency(val, showDash = true) {
  return formatVal(val, showDash);
}

function formatDisplayDate(dString) {
  if (!dString) return '-';
  const d = new Date(dString);
  return isNaN(d.getTime()) ? '-' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-');
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
  const companyName = settings?.companyName || '';
  const logoInitials = companyName
    ? companyName.split(' ').filter(Boolean).map(w => w[0]).join('').slice(0, 3).toUpperCase()
    : '—';
  const companyLogo = settings?.logoUrl || '';
  const companyAddress = settings?.address || {};
  const addressParts = [
    companyAddress.line1,
    companyAddress.city,
    companyAddress.state,
    companyAddress.zip
  ].filter(Boolean);
  const addressLine = addressParts.join(', ');

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

  const taxRegime = String(emp.taxRegime || empSnap.taxRegime || 'new').toUpperCase();
  const taxRegimeLabel = taxRegime.includes('OLD') ? 'OLD TAX REGIME' : 'NEW TAX REGIME';

  // Calculations for Earnings & Deductions table
  const earningsItems = buildPayslipEarningsLineItems(payroll);
  const deductionsItems = buildPayslipDeductionsLineItems(payroll);

  const earnings = earningsItems.map(item => ({
    name: item.name,
    rate: item.amount,
    monthly: item.amount,
    arrear: item.details || '-',
    total: item.amount
  }));

  const deductions = deductionsItems.map(item => ({
    name: item.name + (item.details ? ` (${item.details})` : ''),
    amount: item.amount
  }));

  const maxRows = Math.max(earnings.length, deductions.length, 3);

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

  const annualPF = (payroll.deductions?.pfEmployee || 0) * 12;
  const annualPT = (payroll.deductions?.professionalTax || 0) * 12;
  const annualGross = worksheet.grossSalary || (totalEarningMonthly * 12);
  const standardDeduction = worksheet.standardDeduction || (taxRegime.includes('NEW') ? 75000 : 50000);
  const chapterVIA = totalVIA > 0 ? totalVIA : (taxRegime.includes('OLD') ? Math.min(150000, annualPF) : 0);
  const taxableIncome = worksheet.taxableIncome !== undefined ? worksheet.taxableIncome : Math.max(0, annualGross - standardDeduction - annualPT - chapterVIA);

  const worksheetEarnings = (compBreakdown.length > 0)
    ? compBreakdown
    : earnings.map(e => ({
        name: e.name,
        gross: (Number(e.monthly) || 0) * 12,
        exempt: 0,
        taxable: (Number(e.monthly) || 0) * 12
      }));

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
      <tr style="font-size: 8.5px;">
        <td style="font-weight: 500; text-align: left;">${earn ? earn.name : ''}</td>
        <td style="text-align: right;">${earn ? formatCurrency(earn.rate) : ''}</td>
        <td style="text-align: right;">${earn ? formatCurrency(earn.monthly) : ''}</td>
        <td style="text-align: center;">${earn ? earn.arrear : ''}</td>
        <td style="text-align: right; font-weight: 600;">${earn ? formatCurrency(earn.total || earn.monthly) : ''}</td>
        <td style="text-align: left; font-weight: 500;">${ded ? ded.name : ''}</td>
        <td style="font-weight: 600; text-align: right; border-right: none;">${ded ? formatCurrency(ded.amount) : ''}</td>
      </tr>
    `;
  }

  let compBreakdownHtml = '';
  worksheetEarnings.forEach(row => {
    compBreakdownHtml += `
      <tr style="font-size: 8px;">
        <td style="text-align: left; font-weight: 500;">${row.name}</td>
        <td style="text-align: right;">${formatCurrency(row.gross)}</td>
        <td style="text-align: center; color: #666;">${row.exempt ? formatCurrency(row.exempt) : '-'}</td>
        <td style="text-align: right; border-right: none;">${formatCurrency(row.taxable)}</td>
      </tr>
    `;
  });

  let tdsMonthsHtml = '';
  let totalTds = 0;
  monthsList.forEach(m => {
    const amt = Number(tdsMonths[m.key]) || 0;
    totalTds += amt;
    tdsMonthsHtml += `
      <tr style="font-size: 8px;">
        <td style="text-align: left; color: #000;">${m.name}</td>
        <td style="text-align: right; font-weight: 500; border-right: none;">${formatCurrency(amt)}</td>
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
        font-size: 9px;
        line-height: 1.25;
      }
      .sheet {
        border: 2px solid #000000;
        width: 100%;
        box-sizing: border-box;
      }
      .header-row {
        border-bottom: 2px solid #000000;
        padding: 6px 12px;
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
        color: #000000;
        margin-top: 1px;
      }
      .heading-subbar {
        text-align: center;
        font-weight: 800;
        text-transform: uppercase;
        font-size: 9.5px;
        padding: 4px 6px;
        border-bottom: 1px solid #000000;
        letter-spacing: 0.03em;
      }
      .grid-table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }
      .grid-table td, .grid-table th {
        border-right: 1px solid #000000;
        border-bottom: 1px solid #000000;
        padding: 3px 5px;
        vertical-align: top;
        word-wrap: break-word;
      }
      .grid-table tr td:last-child, .grid-table tr th:last-child {
        border-right: none;
      }
      .bg-gray {
        background-color: #f9fafb;
        font-weight: 700;
      }
      .bg-dark-section {
        background-color: #0f2d59;
        color: #ffffff;
        font-weight: 800;
        text-align: center;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 3px 6px;
        border-bottom: 1px solid #000000;
        font-size: 8.5px;
      }
      .net-bar {
        background-color: #ffffff;
        border-bottom: 1px solid #000000;
        padding: 5px 12px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-weight: 800;
        font-size: 9.5px;
      }
      .flex-between {
        display: flex;
        justify-content: space-between;
      }
      .text-muted { color: #374151; }
      .text-right { text-align: right; }
      .text-center { text-align: center; }
      .footer-banner {
        background-color: #0f2d59;
        color: #ffffff;
        font-weight: 800;
        text-align: center;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 3.5px 6px;
        font-size: 8px;
        margin-top: 2px;
      }
    </style>
  </head>
  <body>
    <div class="sheet">
      
      <!-- Company Header Block -->
      <div class="header-row">
        <div style="width: 25%; display: flex; align-items: center;">
          ${companyLogo ? `<img src="${companyLogo}" style="max-height: 48px; max-width: 160px; object-fit: contain; display: block;" />` : `<span style="font-weight: 800; font-size: 14px; color: #1e293b;">${logoInitials}</span>`}
        </div>
        <div style="text-align: center; width: 75%; padding-right: 25px;">
          <div class="brand-title">${companyName}</div>
          ${addressLine ? `<div class="brand-sub">${addressLine}</div>` : ''}
        </div>
      </div>
      <div class="heading-subbar">
        ${titleHeading}
      </div>

      <!-- Employee Information Grid -->
      <table class="grid-table">
        <tr>
          <!-- Col 1: Emp. Code, Name, Designation, Department, Cost Centre, DOJ -->
          <td style="width: 33.33%;">
            <div class="flex-between"><span class="text-muted">Emp. Code</span> <span style="font-weight: 700;">${empId}</span></div>
            <div class="flex-between" style="margin-top: 1.5px;"><span class="text-muted">Name</span> <span style="font-weight: 700;">${employeeName}</span></div>
            <div class="flex-between" style="margin-top: 1.5px;"><span class="text-muted">Designation</span> <span style="font-weight: 700;">${designation}</span></div>
            <div class="flex-between" style="margin-top: 1.5px;"><span class="text-muted">Department</span> <span style="font-weight: 700;">${deptName}</span></div>
            <div class="flex-between" style="margin-top: 1.5px;"><span class="text-muted">Cost Centre</span> <span style="font-weight: 700;">${emp.costCentre || empSnap.costCentre || 'TaaS'}</span></div>
            <div class="flex-between" style="margin-top: 1.5px;"><span class="text-muted">DOJ</span> <span style="font-weight: 700;">${formatDisplayDate(emp.joiningDate || empSnap.joiningDate)}</span></div>
          </td>
          <!-- Col 2: PF UAN No., Month Days, Gender, Payable Days -->
          <td style="width: 25%;">
            <div class="flex-between"><span class="text-muted">PF UAN No.</span> <span style="font-weight: 700;">${emp.uanNumber || empSnap.uanNumber || 'NA'}</span></div>
            <div class="flex-between" style="margin-top: 12px;"><span class="text-muted">Month Days</span> <span style="font-weight: 700;">${Number(payroll.workingDays || 31).toFixed(2)}</span></div>
            <div class="flex-between" style="margin-top: 1.5px;"><span class="text-muted">Gender</span> <span style="font-weight: 700;">${emp.gender || empSnap.gender || 'Male'}</span></div>
            <div class="flex-between" style="margin-top: 1.5px;"><span class="text-muted">Payable Days</span> <span style="font-weight: 700;">${Number(payroll.paidDays || 31).toFixed(2)}</span></div>
          </td>
          <!-- Col 3: Location, Payment, Bank A/c, PAN, PF No., ESI No. -->
          <td style="width: 25%;">
            <div class="flex-between"><span class="text-muted">Location</span> <span style="font-weight: 700;">${emp.location || empSnap.location || 'Office'}</span></div>
            <div class="flex-between" style="margin-top: 1.5px;"><span class="text-muted">Payment</span> <span style="font-weight: 700;">${payroll.paymentMethod || 'Bank Transfer'}</span></div>
            <div class="flex-between" style="margin-top: 1.5px;"><span class="text-muted">Bank A/c</span> <span style="font-weight: 700;">${emp.bankDetails?.accountNumber || empSnap.bankAccount || '-'}</span></div>
            <div class="flex-between" style="margin-top: 1.5px;"><span class="text-muted">PAN</span> <span style="font-weight: 700;">${emp.panNumber || empSnap.panNumber || '-'}</span></div>
            <div class="flex-between" style="margin-top: 1.5px;"><span class="text-muted">PF No.</span> <span style="font-weight: 700;">${emp.pfNumber || emp.pfNo || empSnap.pfNumber || 'NA'}</span></div>
            <div class="flex-between" style="margin-top: 1.5px;"><span class="text-muted">ESI No.</span> <span style="font-weight: 700;">${emp.esiNumber || empSnap.esiNumber || 'NA'}</span></div>
          </td>
          <!-- Col 4: Tax Regime Badge -->
          <td style="width: 16.67%; text-align: center; vertical-align: top; border-right: none;">
            <div style="display: inline-block; border: 1px solid #000; padding: 2px 4px; font-weight: 800; font-size: 8px; text-transform: uppercase;">
              ${taxRegimeLabel}
            </div>
          </td>
        </tr>
      </table>

      <!-- Earnings & Deductions Section Header -->
      <table class="grid-table">
        <tr class="font-bold text-center">
          <td style="width: 58.333%; border-bottom: 1px solid #000;">Earnings</td>
          <td style="width: 41.667%; border-bottom: 1px solid #000; border-right: none;">Deductions</td>
        </tr>
      </table>

      <!-- Column Titles -->
      <table class="grid-table">
        <tr class="font-bold text-center" style="font-size: 8.5px;">
          <td style="width: 18%; text-align: left;">Description</td>
          <td style="width: 9%; text-align: right;">Rate</td>
          <td style="width: 9%; text-align: right;">Monthly</td>
          <td style="width: 7%; text-align: center;">Arrear</td>
          <td style="width: 15.333%; text-align: right;">Total Earning (Monthly)</td>
          <td style="width: 25%; text-align: left;">Description</td>
          <td style="width: 16.667%; text-align: right; border-right: none;">Amount</td>
        </tr>
        ${tableRowsHtml}
        <!-- Totals Row -->
        <tr class="bg-gray font-bold" style="font-size: 8.5px;">
          <td style="text-align: left;">CTC</td>
          <td style="text-align: right;">${formatCurrency(totalEarningMonthly)}</td>
          <td style="text-align: right;">${formatCurrency(totalEarningMonthly)}</td>
          <td style="text-align: center;">-</td>
          <td style="text-align: right; font-weight: 900;">${formatCurrency(totalEarningMonthly)}</td>
          <td style="text-align: left;">Total Deduction</td>
          <td style="text-align: right; font-weight: 900; border-right: none;">${formatCurrency(totalDeductions)}</td>
        </tr>
      </table>

      <!-- Net Take Home Bar -->
      <div class="net-bar">
        <span>NET TAKE HOME FOR THE MONTH</span>
        <span style="font-size: 11px; font-weight: 900;">${formatCurrency(netTakeHome)}</span>
      </div>

      <!-- Income Tax Worksheet Banner -->
      <div class="bg-dark-section">
        Income Tax Worksheet for the period April ${startYear} - March ${endYear}
      </div>

      <!-- Tax Worksheet Main Grid (3 Columns) -->
      <table class="grid-table">
        <tr>
          <!-- Col 1: Component Breakdown & Tax Computations (41.67%) -->
          <td style="width: 41.67%; padding: 0;">
            <table class="grid-table" style="border: none;">
              <tr class="bg-gray font-bold text-center" style="font-size: 8px;">
                <td style="width: 40%; text-align: left;">Description</td>
                <td style="width: 20%; text-align: right;">Gross</td>
                <td style="width: 15%; text-align: center;">Exempt</td>
                <td style="width: 25%; text-align: right; border-right: none;">Taxable</td>
              </tr>
              ${compBreakdownHtml}
              <tr style="font-size: 8px;"><td style="text-align: left;">Other</td><td style="text-align: center;">-</td><td style="text-align: center;">-</td><td style="text-align: center; border-right: none;">-</td></tr>
              <tr style="font-size: 8px;"><td style="text-align: left;">Bonus</td><td style="text-align: center;">-</td><td style="text-align: center;">-</td><td style="text-align: center; border-right: none;">-</td></tr>
              <tr style="font-size: 8px;"><td style="text-align: left;">Arrear</td><td style="text-align: center;">-</td><td style="text-align: center;">-</td><td style="text-align: center; border-right: none;">-</td></tr>
              <tr class="bg-gray font-bold" style="font-size: 8px; border-top: 1px solid #000;">
                <td style="text-align: left;">Gross Salary</td>
                <td style="text-align: right;">${formatCurrency(annualGross)}</td>
                <td style="text-align: center;">-</td>
                <td style="text-align: right; font-weight: 900; border-right: none;">${formatCurrency(annualGross)}</td>
              </tr>
              <tr style="font-size: 8px;"><td colspan="3" style="text-align: left;">Deduction - Income from House Property (Intt)</td><td style="text-align: center; border-right: none;">-</td></tr>
              <tr style="font-size: 8px;"><td colspan="3" style="text-align: left;">Standard Deduction</td><td style="text-align: right; border-right: none;">${formatCurrency(standardDeduction)}</td></tr>
              <tr style="font-size: 8px;"><td colspan="3" style="text-align: left;">Previous Employer Professional Tax</td><td style="text-align: center; border-right: none;">-</td></tr>
              <tr style="font-size: 8px;"><td colspan="3" style="text-align: left;">Professional Tax</td><td style="text-align: right; border-right: none;">${formatCurrency(annualPT)}</td></tr>
              <tr style="font-size: 8px;"><td colspan="3" style="text-align: left;">Under Chapter VI-A</td><td style="text-align: right; border-right: none;">${formatCurrency(chapterVIA)}</td></tr>
              <tr style="font-size: 8px;"><td colspan="3" style="text-align: left;">Any Other Income</td><td style="text-align: center; border-right: none;">-</td></tr>
              <tr class="bg-gray font-bold" style="font-size: 8px; border-top: 1px solid #000;"><td colspan="3" style="text-align: left;">Taxable Income</td><td style="text-align: right; font-weight: 900; border-right: none;">${formatCurrency(taxableIncome)}</td></tr>
              <tr style="font-size: 8px;"><td colspan="3" style="text-align: left;">Total Tax</td><td style="text-align: right; border-right: none;">${formatCurrency(worksheet.totalTax)}</td></tr>
              <tr style="font-size: 8px;"><td colspan="3" style="text-align: left;">Tax Rebate</td><td style="text-align: center; border-right: none;">-</td></tr>
              <tr style="font-size: 8px;"><td colspan="3" style="text-align: left;">Surcharge</td><td style="text-align: center; border-right: none;">-</td></tr>
              <tr style="font-size: 8px;"><td colspan="3" style="text-align: left;">Tax Due</td><td style="text-align: center; border-right: none;">-</td></tr>
              <tr style="font-size: 8px;"><td colspan="3" style="text-align: left;">Educational Cess</td><td style="text-align: right; border-right: none;">${formatCurrency(worksheet.cess)}</td></tr>
              <tr class="bg-gray font-bold" style="font-size: 8px;"><td colspan="3" style="text-align: left;">Net Tax</td><td style="text-align: right; border-right: none;">${formatCurrency(worksheet.netTax)}</td></tr>
              <tr style="font-size: 8px;"><td colspan="3" style="text-align: left;">Tax deducted (Previous Employer)</td><td style="text-align: center; border-right: none;">-</td></tr>
              <tr style="font-size: 8px;"><td colspan="3" style="text-align: left;">Tax Deducted Till date</td><td style="text-align: right; border-right: none;">${formatCurrency(worksheet.taxDeductedTillDate)}</td></tr>
              <tr style="font-size: 8px;"><td colspan="3" style="text-align: left;">Tax to be Deducted</td><td style="text-align: right; border-right: none;">${formatCurrency(worksheet.taxToDeducted)}</td></tr>
              <tr style="font-size: 8px;"><td colspan="3" style="text-align: left;">Tax/ Month</td><td style="text-align: center; border-right: none;">-</td></tr>
              <tr style="font-size: 8px;"><td colspan="3" style="text-align: left;">Tax on Non-Recurring Earnings</td><td style="text-align: center; border-right: none;">-</td></tr>
              <tr class="bg-gray font-bold" style="font-size: 8px;"><td colspan="3" style="text-align: left;">Tax Deduction for this month</td><td style="text-align: right; color: #78350f; border-right: none;">${formatCurrency(worksheet.taxDeductionThisMonth)}</td></tr>
            </table>
          </td>

          <!-- Col 2: Chapter VI-A & 80C Deductions (33.33%) -->
          <td style="width: 33.33%; padding: 0;">
            <div class="bg-gray font-bold text-center" style="padding: 2.5px; border-bottom: 1px solid #000000; font-size: 8px;">
              Deduction Under Chapter VI-A
            </div>
            <div style="background-color: #f3f4f6; font-weight: 700; padding: 2px 4px; border-bottom: 1px solid #000000; font-size: 8px;">
              Investments u/s 80C
            </div>
            <div style="padding: 3px; font-size: 8px;">
              <div class="flex-between" style="margin-top: 1px;"><span>Provident Fund</span> <span>${formatVal(epfVal || annualPF, false) || '0.00'}</span></div>
              <div class="flex-between" style="margin-top: 1px;"><span>Public Provident Fund</span> <span>${formatCurrency(ppfVal)}</span></div>
              <div class="flex-between" style="margin-top: 1px;"><span>Principal - Housing Loan</span> <span>${formatCurrency(homeLoanVal)}</span></div>
              <div class="flex-between" style="margin-top: 1px;"><span>Life Insurance Premium</span> <span>${formatCurrency(licVal)}</span></div>
              <div class="flex-between" style="margin-top: 1px;"><span>Mutual Fund</span> <span>${formatCurrency(elssVal)}</span></div>
              <div class="flex-between" style="margin-top: 1px;"><span>Atal Pension Yojna</span> <span>-</span></div>
              <div class="flex-between font-bold bg-gray" style="border-top: 1px solid #000; margin-top: 3px; padding-top: 1px;">
                <span>Total of Investment u/s 80C</span>
                <span>${formatVal(sec80CVal || annualPF, false) || '0.00'}</span>
              </div>
            </div>

            <div style="border-top: 1px solid #000000; padding: 3px; font-size: 8px;">
              <div class="flex-between" style="margin-top: 1px;"><span>U/S 80C</span> <span>${formatCurrency(sec80CCapped || annualPF)}</span></div>
              <div class="flex-between" style="margin-top: 1px;"><span>U/S 80D</span> <span>${formatCurrency(sec80DVal)}</span></div>
              <div class="flex-between" style="margin-top: 1px;"><span>U/S 80CCD</span> <span>${formatCurrency(sec80CCDVal)}</span></div>
              <div class="flex-between" style="margin-top: 1px;"><span>U/S 80 G</span> <span>-</span></div>
            </div>

            <div style="border-top: 1px solid #000000; padding: 3px; font-size: 8px; background-color: #f9fafb;">
              <div class="flex-between font-bold"><span>Total of Ded Under Chapter</span> <span>${formatCurrency(totalVIA || annualPF)}</span></div>
              <div class="flex-between" style="margin-top: 1px;"><span>Interest on Housing Loan</span> <span>${formatCurrency(sec24bVal)}</span></div>
              <div class="flex-between" style="margin-top: 1px;"><span>Max Allowed</span> <span>-</span></div>
            </div>
          </td>

          <!-- Col 3: Month-wise TDS Detail (25%) -->
          <td style="width: 25%; padding: 0; border-right: none;">
            <div class="bg-gray font-bold text-center" style="padding: 2.5px; border-bottom: 1px solid #000000; font-size: 8px;">
              Tax Deducted Details
            </div>
            <table class="grid-table" style="border: none;">
              <tr class="bg-gray font-bold text-center" style="font-size: 8px;">
                <td style="width: 50%; text-align: left;">Month</td>
                <td style="width: 50%; text-align: right; border-right: none;">Amount</td>
              </tr>
              ${tdsMonthsHtml}
              <tr class="bg-gray font-bold" style="font-size: 8px; border-top: 1px solid #000;">
                <td style="text-align: left;">Total</td>
                <td style="text-align: right; border-right: none;">${formatCurrency(totalTds)}</td>
              </tr>
            </table>
            <div style="border-top: 1px solid #000000; padding: 4px; background-color: #f9fafb;">
              <div class="flex-between font-bold" style="font-size: 8px;">
                <span>LEAVE BALANCE AS ON MONTH END</span>
                <span>${Number(payroll.leaveBalance || 0).toFixed(2)}</span>
              </div>
            </div>
          </td>
        </tr>
      </table>

      <!-- HRA Calculation Section -->
      <div style="background-color: #f3f4f6; font-weight: 700; padding: 2px 5px; border-bottom: 1px solid #000000; font-size: 8px;">
        HRA Calculation
      </div>
      <table class="grid-table" style="font-size: 8px;">
        <tr class="bg-gray font-bold text-center">
          <td style="width: 8%;">From</td>
          <td style="width: 8%;">To</td>
          <td style="width: 17%;">Rent Paid</td>
          <td style="width: 17%;">Actual HRA</td>
          <td style="width: 17%;">40/50% of Basic</td>
          <td style="width: 17%;">Rent - 10% of Basic</td>
          <td style="width: 16%; border-right: none;">Exempt HRA</td>
        </tr>
        <tr class="text-center">
          <td>April</td>
          <td>March</td>
          <td>${formatCurrency(hraCalc.rentPaid)}</td>
          <td>${formatCurrency(hraCalc.actualHRA || ((worksheetEarnings.find(e => e.name.toLowerCase().includes('hra'))?.gross) || 0))}</td>
          <td>${formatCurrency(hraCalc.basicPercent || (((worksheetEarnings.find(e => e.name.toLowerCase().includes('basic'))?.gross) || 0) * 0.4))}</td>
          <td>${formatCurrency(hraCalc.rentMinusBasic10)}</td>
          <td class="bg-gray font-bold" style="border-right: none;">${formatCurrency(hraCalc.exemptHRA || ((worksheetEarnings.find(e => e.name.toLowerCase().includes('hra'))?.gross) || 0))}</td>
        </tr>
        <tr class="bg-gray font-bold text-center">
          <td colspan="2">Total</td>
          <td colspan="5" style="border-right: none;">-</td>
        </tr>
      </table>

    </div>

    <!-- Computer Generated Footer Banner -->
    <div class="footer-banner">
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
