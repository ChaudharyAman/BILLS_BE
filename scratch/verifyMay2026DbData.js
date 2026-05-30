const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const User = require('../models/User');
const Invoice = require('../models/Invoice');
const Expense = require('../models/Expense');
const Client = require('../models/Client');
const Settings = require('../models/Settings');
const Payroll = require('../models/Payroll');

async function run() {
  const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mybill';
  await mongoose.connect(mongoUri);

  const user = await User.findOne({ username: 'aman' });
  if (!user) {
    console.error('User "aman" not found');
    await mongoose.disconnect();
    return;
  }
  const userId = user._id;
  console.log(`\n========================================`);
  console.log(`Database Audit for User: ${user.username} (ID: ${userId})`);
  console.log(`========================================`);

  const start = new Date('2026-05-01T00:00:00.000Z');
  const end = new Date('2026-05-31T23:59:59.999Z');

  // --- 1. INVOICES ---
  const activeInvoiceStatuses = ['SENT', 'PAID', 'PARTIAL', 'UNPAID'];
  const invoices = await Invoice.find({
    user: userId,
    date: { $gte: start, $lte: end },
    status: { $in: activeInvoiceStatuses }
  }).lean();

  console.log(`\n--- 1. ACTIVE INVOICES FOR MAY 2026 (Count: ${invoices.length}) ---`);
  let calculatedOutputLiability = 0;
  let computedTotalIGST = 0;
  let computedTotalCGST = 0;
  let computedTotalSGST = 0;
  let totalTdsDeducted = 0;

  invoices.forEach(inv => {
    calculatedOutputLiability += Number(inv.taxTotal) || 0;
    computedTotalIGST += Number(inv.totalIGST) || 0;
    computedTotalCGST += Number(inv.totalCGST) || 0;
    computedTotalSGST += Number(inv.totalSGST) || 0;

    const tdsVal = Math.max(
      Number(inv.tds_amount) || 0,
      Number(inv.tdsAmount) || 0,
      Number(inv.tds) || 0
    );
    totalTdsDeducted += tdsVal;

    console.log(`- Invoice: ${inv.invoiceNo}`);
    console.log(`  Date: ${inv.date.toISOString().split('T')[0]} | Client: ${inv.client?.name || 'Unknown'}`);
    console.log(`  SubTotal: Rs ${inv.subTotal} | TaxTotal: Rs ${inv.taxTotal} | GrandTotal: Rs ${inv.grandTotal}`);
    console.log(`  Components -> IGST: Rs ${inv.totalIGST || 0} | CGST: Rs ${inv.totalCGST || 0} | SGST: Rs ${inv.totalSGST || 0}`);
    console.log(`  TDS Withheld -> tds_amount: Rs ${inv.tds_amount || 0} | tdsAmount: Rs ${inv.tdsAmount || 0} | tds: Rs ${inv.tds || 0} (Selected TDS: Rs ${tdsVal})`);
  });

  // --- 2. EXPENSES ---
  const activeExpenseStatuses = { $nin: ['DRAFT', 'CANCELLED'] };
  const expenses = await Expense.find({
    user: userId,
    date: { $gte: start, $lte: end },
    status: activeExpenseStatuses
  }).lean();

  console.log(`\n--- 2. ACTIVE EXPENSES FOR MAY 2026 (Count: ${expenses.length}) ---`);
  let calculatedInputCredit = 0;
  let totalTdsPayableExpense = 0;

  for (const exp of expenses) {
    calculatedInputCredit += Number(exp.taxTotal) || 0;
    if (exp.tds_applicable) {
      totalTdsPayableExpense += Number(exp.tds_amount) || 0;
    }
    console.log(`- Expense: ${exp.expenseNumber || 'N/A'}`);
    console.log(`  Date: ${exp.date.toISOString().split('T')[0]} | Vendor: ${exp.vendor?.name || 'Unknown'}`);
    console.log(`  SubTotal: Rs ${exp.subTotal} | TaxTotal: Rs ${exp.taxTotal} | GrandTotal: Rs ${exp.grandTotal}`);
    console.log(`  TDS Applicable: ${exp.tds_applicable || false} | TDS Amount: Rs ${exp.tds_amount || 0}`);
    console.log(`  Items:`, JSON.stringify(exp.items.map(i => ({ amount: i.amount, taxRate: i.taxRate, taxAmount: i.taxAmount })), null, 2));
  }

  // --- 3. PAYROLL TDS ---
  const payrolls = await Payroll.find({
    user: userId,
    status: { $nin: ['cancelled', 'draft'] },
    paymentDate: { $gte: start, $lte: end }
  }).lean();

  console.log(`\n--- 3. PAYROLL FOR MAY 2026 (Count: ${payrolls.length}) ---`);
  let totalTdsPayablePayroll = 0;
  payrolls.forEach(p => {
    const tds = Number(p.deductions?.tds) || 0;
    totalTdsPayablePayroll += tds;
    console.log(`- Payroll ID: ${p._id} | Date: ${p.paymentDate.toISOString().split('T')[0]} | Employee Name: ${p.employeeName || 'N/A'}`);
    console.log(`  TDS Deduction: Rs ${tds}`);
  });

  // --- 4. VENDOR STATE CODES COMPILATION ---
  const settings = await Settings.findOne({ user: userId }).select('gstin').lean();
  const userGstin = String(settings?.gstin || '').trim().toUpperCase();
  const userStateCode = /^[0-9]{2}/.test(userGstin) ? userGstin.substring(0, 2) : '';

  console.log(`\n--- 4. GST STATE CODE ANALYSIS ---`);
  console.log(`User GSTIN: "${userGstin}" (State Code: "${userStateCode}")`);

  const vendorRefIds = [...new Set(
    expenses.map(e => e.vendor?.vendorRef).filter(Boolean).map(String)
  )];
  const vendorDocs = vendorRefIds.length
    ? await Client.find({ _id: { $in: vendorRefIds } }).select('gstin name').lean()
    : [];
  const vendorGstinMap = new Map(vendorDocs.map(v => [String(v._id), String(v.gstin || '').trim().toUpperCase()]));

  console.log(`Vendors GSTIN mapping:`);
  vendorDocs.forEach(v => {
    console.log(`- Vendor ID: ${v._id} | Name: ${v.name} | GSTIN: "${v.gstin || ''}"`);
  });

  let calculatedInputIgst = 0;
  let calculatedInputCgstSgst = 0;

  for (const exp of expenses) {
    const vendorGstin = exp.vendor?.vendorRef
      ? (vendorGstinMap.get(String(exp.vendor.vendorRef)) || '')
      : '';
    const vendorStateCode = /^[0-9]{2}/.test(vendorGstin) ? vendorGstin.substring(0, 2) : '';
    const isInterState = userStateCode && vendorStateCode && userStateCode !== vendorStateCode;

    console.log(`Expense ${exp.expenseNumber || 'N/A'}: Vendor state: "${vendorStateCode}", Inter-state: ${!!isInterState}`);

    exp.items.forEach(item => {
      const taxAmt = Number(item.taxAmount) || 0;
      const effectiveTax = taxAmt > 0
        ? taxAmt
        : Math.round((Number(item.amount) || 0) * ((Number(item.taxRate) || 0) / 100) * 100) / 100;

      if (isInterState) {
        calculatedInputIgst += effectiveTax;
      } else {
        calculatedInputCgstSgst += effectiveTax;
      }
    });
  }

  // --- 5. OVERALL MATH VALIDATION ---
  console.log(`\n========================================`);
  console.log(`SUMMARY MATH CHECK AGAINST SCREEN DISPLAY`);
  console.log(`========================================`);
  console.log(`Output Liability (DB Sum): Rs ${calculatedOutputLiability} (Screen: Rs 14,598)`);
  console.log(`  IGST Output: Rs ${computedTotalIGST} (Screen: Rs 14,418.00)`);
  console.log(`  CGST Output: Rs ${computedTotalCGST} (Screen: Rs 90.00)`);
  console.log(`  SGST Output: Rs ${computedTotalSGST} (Screen: Rs 90.00)`);

  console.log(`Input Credit (DB Sum): Rs ${calculatedInputCredit} (Screen: Rs 5,786)`);
  console.log(`  IGST Credit (Calculated): Rs ${calculatedInputIgst} (Screen: Rs 0.00)`);
  console.log(`  CGST+SGST Credit (Calculated): Rs ${calculatedInputCgstSgst} (Screen: Rs 5,785.74)`);

  const computedNetGst = Math.max(calculatedOutputLiability - calculatedInputCredit, 0);
  console.log(`Net GST Payable (Output - Input): Rs ${computedNetGst} (Screen: Rs 8,812)`);

  console.log(`TDS Receivable (Withheld by Clients): Rs ${totalTdsDeducted} (Screen: Rs 8,000.00)`);
  
  const computedTdsPayable = totalTdsPayablePayroll + totalTdsPayableExpense;
  console.log(`TDS Payable (Payroll + Expense): Rs ${computedTdsPayable} (Screen: Rs 0.00)`);

  const computedCombined = Math.max(computedNetGst + computedTdsPayable - totalTdsDeducted, 0);
  console.log(`Combined Tax Payable (Net GST + TDS Payable - TDS Receivable): Rs ${computedCombined} (Screen: Rs 812.26)`);

  console.log(`\n========================================`);
  await mongoose.disconnect();
}

run().catch(console.error);
