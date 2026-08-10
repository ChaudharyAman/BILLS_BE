/**
 * payslipPdf.test.js
 *
 * Unit tests for server-side PDF generation, PDF password encryption,
 * ZIP archive creation, and payslip PDF controller endpoints.
 */

'use strict';

const {
  buildPayslipHtml,
  encryptPdfBuffer,
  createBulkPayslipsZip,
  getStoredPayslipPath,
} = require('../../services/pdfGeneratorService');
const { PDFDocument } = require('@cantoo/pdf-lib');
const fs = require('fs');

describe('Payslip PDF Generator & Security Tests', () => {

  const samplePayroll = {
    _id: '66a1234567890123456789ab',
    month: 7,
    year: 2026,
    workingDays: 30,
    paidDays: 30,
    lop: 0,
    status: 'paid',
    earnings: { basic: 40000, hra: 20000, totalEarnings: 60000 },
    deductions: { pfEmployee: 1800, professionalTax: 200, totalDeductions: 2000 },
    netSalary: 58000,
    paymentMethod: 'Bank Transfer',
    transactionId: 'TXN998877',
    employeeSnapshot: {
      employeeId: 'EMP101',
      firstName: 'Jane',
      lastName: 'Doe',
      designation: 'Senior Engineer',
      departmentName: 'Engineering',
    },
  };

  const sampleSettings = {
    companyName: 'Acme Corp',
    logoUrl: 'https://example.com/logo.png',
    signatureUrl: 'https://example.com/sig.png',
    pan: 'ABCDE1234F',
    gstin: '07ABCDE1234F1Z5',
  };

  test('buildPayslipHtml produces structured HTML with company and payroll details', () => {
    const html = buildPayslipHtml({ ...samplePayroll, leaveBalance: 14.5 }, samplePayroll.employeeSnapshot, sampleSettings);
    expect(typeof html).toBe('string');
    expect(html).toContain('Acme Corp');
    expect(html).toContain('Jane Doe');
    expect(html).toContain('EMP101');
    expect(html).toMatch(/July 2026/i);
    expect(html).toContain('₹58,000.00');
    expect(html).toContain('14.50');
  });

  test('encryptPdfBuffer returns password-protected PDF bytes via pdf-lib', async () => {
    // Create simple unencrypted PDF using pdf-lib
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    const pdfBytes = await doc.save();
    const rawBuffer = Buffer.from(pdfBytes);

    const userPassword = 'JANE0105';
    const encryptedBuffer = await encryptPdfBuffer(rawBuffer, userPassword);

    expect(encryptedBuffer).toBeDefined();
    expect(Buffer.isBuffer(encryptedBuffer)).toBe(true);
    expect(encryptedBuffer.length).toBeGreaterThan(0);

    // Verify loading without password throws error or requires password
    await expect(PDFDocument.load(encryptedBuffer)).rejects.toThrow();
  });

  test('createBulkPayslipsZip bundles multiple PDF buffers into a single ZIP archive', async () => {
    const file1 = { filename: 'Payslip_EMP101_July_2026.pdf', buffer: Buffer.from('%PDF-1.4 test content 1') };
    const file2 = { filename: 'Payslip_EMP102_July_2026.pdf', buffer: Buffer.from('%PDF-1.4 test content 2') };

    const zipBuffer = await createBulkPayslipsZip([file1, file2]);
    expect(Buffer.isBuffer(zipBuffer)).toBe(true);
    expect(zipBuffer.length).toBeGreaterThan(0);

    // PK zip signature header
    expect(zipBuffer.subarray(0, 2).toString('hex')).toBe('504b');
  });

  test('getStoredPayslipPath returns valid uploads path for payroll ID', () => {
    const pPath = getStoredPayslipPath('66a1234567890123456789ab');
    expect(pPath).toContain('payslip_66a1234567890123456789ab.pdf');
  });

  test('calculateTaxForRegime computes 25% slab for income between 20L and 24L without overtaxing', () => {
    const { calculateTaxForRegime } = require('../../utils/payrollMath');
    // 22L (2,200,000) taxable income: 20k + 40k + 60k + 80k + (2L * 0.25 = 50k) = 250,000
    const tax = calculateTaxForRegime('new', 2200000);
    expect(tax).toBe(250000);
  });

  test('calculateTaxForRegime computes Section 87A marginal relief for income between 12L and marginal boundary', () => {
    const { calculateTaxForRegime } = require('../../utils/payrollMath');
    // 12L (1,200,000) taxable income: 0 tax
    expect(calculateTaxForRegime('new', 1200000)).toBe(0);

    // 12.2L (1,220,000) taxable income:
    // Raw tax: (12.2L-12L)*0.15 + 60k = 63,000
    // Excess income over 12L: 20,000
    // Marginal relief caps tax to 20,000
    expect(calculateTaxForRegime('new', 1220000)).toBe(20000);
  });
});
