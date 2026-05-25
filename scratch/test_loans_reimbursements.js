const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../db');
const User = require('../models/User');
const Employee = require('../models/Employee');
const Loan = require('../models/Loan');
const ReimbursementClaim = require('../models/ReimbursementClaim');
const Payroll = require('../models/Payroll');
const { processPayroll, markPayrollAsPaid } = require('../controllers/payrollController');

function assert(condition, message) {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  } else {
    console.log(`[PASS] ${message}`);
  }
}

async function runTests() {
  console.log('--- Connecting to Test DB ---');
  await connectDB();

  console.log('--- Setting Up Test Data ---');
  // 1. Create a dummy tenant user
  const userEmail = `tenant-${Date.now()}@test.com`;
  const user = await User.create({
    username: `user-${Date.now()}`,
    name: 'Test Tenant',
    email: userEmail,
    password: 'password123',
    role: 'user',
    subscription: { plan: 'pro', status: 'active' }
  });

  // 2. Create a dummy employee
  const employee = await Employee.create({
    user: user._id,
    employeeId: `EMP-${Date.now()}`,
    firstName: 'John',
    lastName: 'Doe',
    email: `john-${Date.now()}@test.com`,
    joiningDate: new Date('2025-01-01'),
    monthlyCTC: 30000,
    pfEnabled: true,
    esiEnabled: false,
    ptEnabled: false,
    lwfEnabled: false,
    gratuityEnabled: false,
    includePfInCTC: true,
    includeGratuityInCTC: false,
    status: 'active'
  });

  // 3. Create a Loan for John Doe
  const loan = await Loan.create({
    user: user._id,
    employee: employee._id,
    principalAmount: 5000,
    emiAmount: 2000,
    interestRate: 0,
    remainingBalance: 5000,
    status: 'active' // directly active for test
  });

  // 4. Create an approved Reimbursement claim for John Doe
  const claim = await ReimbursementClaim.create({
    user: user._id,
    employee: employee._id,
    category: 'petrol',
    amount: 1500,
    status: 'approved',
    createdAt: new Date(2026, 4, 15) // May 2026
  });

  console.log('--- Simulating Payroll Processing ---');
  // Mock req & res for processPayroll
  const mockReqProcess = {
    user: { _id: user._id },
    body: {
      month: 5,
      year: 2026,
      employees: [
        {
          employeeId: employee._id.toString(),
          workingDays: 26,
          paidDays: 26
        }
      ]
    }
  };

  let processStatus = 0;
  let processJsonData = null;
  const mockResProcess = {
    status: (code) => {
      processStatus = code;
      return mockResProcess;
    },
    json: (data) => {
      processJsonData = data;
      return mockResProcess;
    }
  };

  await processPayroll(mockReqProcess, mockResProcess);

  assert(processJsonData && processJsonData.success && processJsonData.success.length > 0, 'Payroll processing should succeed');
  const payrollId = processJsonData.success[0].payrollId;

  // Let's find the created payroll document
  const payroll = await Payroll.findById(payrollId);
  assert(payroll !== null, 'Payroll document should be successfully created');
  assert(payroll.deductions.loanDeduction === 2000, `Expected Loan EMI deduction of 2000, got ${payroll.deductions.loanDeduction}`);
  assert(payroll.totalReimbursementApproved === 1500, `Expected totalReimbursementApproved of 1500, got ${payroll.totalReimbursementApproved}`);

  console.log('--- Simulating Payroll Payment (Loan Repayment Reduction) ---');
  // Mock req & res for markPayrollAsPaid
  const mockReqPaid = {
    user: { _id: user._id },
    params: { id: payrollId.toString() },
    body: {
      paymentDate: new Date(),
      paymentMethod: 'UPI'
    }
  };

  let paidJsonData = null;
  const mockResPaid = {
    status: (code) => mockResPaid,
    json: (data) => {
      paidJsonData = data;
      return mockResPaid;
    }
  };

  await markPayrollAsPaid(mockReqPaid, mockResPaid);

  // Load Loan and check remaining balance and ledger
  const updatedLoan = await Loan.findById(loan._id);
  assert(updatedLoan.remainingBalance === 3000, `Loan remaining balance should be reduced to 3000, got ${updatedLoan.remainingBalance}`);
  assert(updatedLoan.repaymentLedger.length === 1, 'Repayment ledger should contain 1 entry');
  assert(updatedLoan.repaymentLedger[0].amountPaid === 2000, `Repayment amount should be 2000, got ${updatedLoan.repaymentLedger[0].amountPaid}`);

  console.log('--- Cleaning Up Test Data ---');
  await User.deleteOne({ _id: user._id });
  await Employee.deleteOne({ _id: employee._id });
  await Loan.deleteOne({ _id: loan._id });
  await ReimbursementClaim.deleteOne({ _id: claim._id });
  await Payroll.deleteOne({ _id: payrollId });

  console.log('--- PHASE 2: ALL TESTS PASSED CLEANLY ---');
  process.exit(0);
}

runTests().catch(err => {
  console.error('[FAIL] Unexpected error during test run:', err);
  process.exit(1);
});
