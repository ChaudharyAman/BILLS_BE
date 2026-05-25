const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../db');
const User = require('../models/User');
const Employee = require('../models/Employee');
const Payroll = require('../models/Payroll');
const AuditLog = require('../models/AuditLog');
const {
  processPayroll,
  bulkApprovePayroll,
  updatePayroll,
  reopenPayroll,
  markPayrollAsPaid
} = require('../controllers/payrollController');

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
  const userEmail = `tenant-work-${Date.now()}@test.com`;
  const user = await User.create({
    username: `user-work-${Date.now()}`,
    name: 'Test Tenant Work',
    email: userEmail,
    password: 'password123',
    role: 'user',
    subscription: { plan: 'pro', status: 'active' }
  });

  const employee = await Employee.create({
    user: user._id,
    employeeId: `EMP-WORK-${Date.now()}`,
    firstName: 'Alice',
    lastName: 'Smith',
    email: `alice-${Date.now()}@test.com`,
    joiningDate: new Date('2025-01-01'),
    monthlyCTC: 40000,
    pfEnabled: true,
    esiEnabled: true,
    ptEnabled: true,
    lwfEnabled: true,
    gratuityEnabled: true,
    includePfInCTC: true,
    includeGratuityInCTC: true,
    status: 'active',
    taxRegime: 'old',
    declarations: { section80C: 120000 }
  });

  console.log('--- Phase 3 Test: Processing Payroll ---');
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

  let processJsonData = null;
  const mockResProcess = {
    status: (code) => mockResProcess,
    json: (data) => {
      processJsonData = data;
      return mockResProcess;
    }
  };

  await processPayroll(mockReqProcess, mockResProcess);

  assert(processJsonData && processJsonData.success && processJsonData.success.length > 0, 'Payroll processing should succeed');
  const payrollId = processJsonData.success[0].payrollId;

  // Let's load the payroll
  let payroll = await Payroll.findById(payrollId);
  assert(payroll !== null, 'Payroll document should exist');
  assert(payroll.status === 'processed', 'Status should be processed by default');
  
  // Verify employeeSnapshot is correctly populated
  assert(payroll.employeeSnapshot !== undefined, 'employeeSnapshot should be populated');
  assert(payroll.employeeSnapshot.firstName === 'Alice', `Expected Alice, got ${payroll.employeeSnapshot.firstName}`);
  assert(payroll.employeeSnapshot.taxRegime === 'old', `Expected old, got ${payroll.employeeSnapshot.taxRegime}`);
  assert(payroll.employeeSnapshot.declarations.section80C === 120000, 'declarations section80C should match');
  assert(payroll.employeeSnapshot.pfEnabled === true, 'pfEnabled in snapshot should be true');

  // Verify initial workflow log
  assert(payroll.approvalWorkflow.length === 1, 'Should have 1 workflow log');
  assert(payroll.approvalWorkflow[0].status === 'processed', 'Initial workflow log should be processed');

  // Verify AuditLog exists
  let logs = await AuditLog.find({ targetPayroll: payrollId });
  assert(logs.length === 1, 'One AuditLog should be created for payroll process');
  assert(logs[0].action === 'PAYROLL_PROCESSED', 'Action should be PAYROLL_PROCESSED');

  console.log('--- Phase 3 Test: Bulk Approving Payroll ---');
  const mockReqApprove = {
    user: { _id: user._id },
    body: {
      ids: [payrollId.toString()],
      remarks: 'Looks good, approve it!'
    }
  };
  let approveJsonData = null;
  const mockResApprove = {
    status: (code) => mockResApprove,
    json: (data) => {
      approveJsonData = data;
      return mockResApprove;
    }
  };

  await bulkApprovePayroll(mockReqApprove, mockResApprove);

  payroll = await Payroll.findById(payrollId);
  assert(payroll.status === 'approved', 'Status should transition to approved');
  assert(payroll.approvalWorkflow.length === 2, 'Should have 2 workflow entries');
  assert(payroll.approvalWorkflow[1].status === 'approved', 'Second entry status should be approved');
  assert(payroll.approvalWorkflow[1].remarks === 'Looks good, approve it!', 'Remarks should match');

  // Check audit log for approval
  logs = await AuditLog.find({ targetPayroll: payrollId, action: 'PAYROLL_APPROVED' });
  assert(logs.length === 1, 'Approval AuditLog should exist');

  console.log('--- Phase 3 Test: Testing Core Edit Lock on Approved Payroll ---');
  const mockReqEditApproved = {
    user: { _id: user._id },
    params: { id: payrollId.toString() },
    body: {
      notes: 'New notes',
      workingDays: 20 // core field modification
    }
  };

  let editStatus = 200;
  let editJson = null;
  const mockResEditApproved = {
    status: (code) => {
      editStatus = code;
      return mockResEditApproved;
    },
    json: (data) => {
      editJson = data;
      return mockResEditApproved;
    }
  };

  await updatePayroll(mockReqEditApproved, mockResEditApproved);
  assert(editStatus === 400, `Expected 400 due to locked core fields, got ${editStatus}`);
  assert(editJson.message.includes('locked'), 'Response message should mention locking');

  // Test metadata update on approved payroll
  const mockReqMetadataEdit = {
    user: { _id: user._id },
    params: { id: payrollId.toString() },
    body: {
      notes: 'Updating notes',
      paymentMethod: 'Bank'
    }
  };
  editStatus = 200;
  await updatePayroll(mockReqMetadataEdit, mockResEditApproved);
  assert(editStatus === 200, 'Should allow editing metadata fields even when approved');
  payroll = await Payroll.findById(payrollId);
  assert(payroll.notes === 'Updating notes', 'Notes should be updated');

  console.log('--- Phase 3 Test: Re-opening Approved Payroll ---');
  const mockReqReopen = {
    user: { _id: user._id },
    params: { id: payrollId.toString() },
    body: {
      remarks: 'Need to adjust attendance'
    }
  };
  let reopenJson = null;
  const mockResReopen = {
    status: (code) => mockResReopen,
    json: (data) => {
      reopenJson = data;
      return mockResReopen;
    }
  };

  await reopenPayroll(mockReqReopen, mockResReopen);
  payroll = await Payroll.findById(payrollId);
  assert(payroll.status === 'processed', 'Should transition back to processed');
  assert(payroll.approvalWorkflow.length === 3, `Should have added reopening entry (got ${payroll.approvalWorkflow.length})`);
  assert(payroll.approvalWorkflow[payroll.approvalWorkflow.length - 1].status === 'processed', 'Last status should be processed');
  assert(payroll.approvalWorkflow[payroll.approvalWorkflow.length - 1].remarks === 'Need to adjust attendance', 'Reopen remarks should match');

  logs = await AuditLog.find({ targetPayroll: payrollId, action: 'PAYROLL_REOPENED' });
  assert(logs.length === 1, 'Reopened AuditLog should exist');

  console.log('--- Phase 3 Test: Payment Locking Enforcement ---');
  // Process -> Approved -> Paid
  // 1. Re-approve
  payroll.status = 'approved';
  await payroll.save();

  // 2. Mark as paid
  const mockReqPaid = {
    user: { _id: user._id },
    params: { id: payrollId.toString() },
    body: {
      paymentMethod: 'UPI'
    }
  };
  await markPayrollAsPaid(mockReqPaid, mockResReopen);

  payroll = await Payroll.findById(payrollId);
  assert(payroll.status === 'paid', 'Status should be paid');

  // Try to re-open paid payroll
  let reopenStatus = 200;
  let reopenErrJson = null;
  const mockResReopenPaid = {
    status: (code) => {
      reopenStatus = code;
      return mockResReopenPaid;
    },
    json: (data) => {
      reopenErrJson = data;
      return mockResReopenPaid;
    }
  };
  await reopenPayroll(mockReqReopen, mockResReopenPaid);
  assert(reopenStatus === 400, 'Re-opening paid payroll must return 400 Bad Request');

  console.log('--- Cleaning Up Test Data ---');
  await User.deleteOne({ _id: user._id });
  await Employee.deleteOne({ _id: employee._id });
  await Payroll.deleteOne({ _id: payrollId });
  await AuditLog.deleteMany({ user: user._id });

  console.log('--- PHASE 3: ALL TESTS PASSED CLEANLY ---');
  process.exit(0);
}

runTests().catch(err => {
  console.error('[FAIL] Unexpected error during test run:', err);
  process.exit(1);
});
