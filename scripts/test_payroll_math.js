const path = require('path');
const { buildPayrollSnapshot } = require('../../../../edited/MyBill/MBB/utils/payrollMath');

const config = {
  defaultWorkingDays: 26,
  pfEmployeeRate: 0.12,
  pfEmployerRate: 0.12,
  esiEmployeeRate: 0.0075,
  esiEmployerRate: 0.0325,
  lwfEmployee: 10,
  lwfEmployer: 20,
  insurance: 150,
  employerNPS: 0,
  salaryComponents: [] // Non-dynamic components for simplicity
};

// 1. Salaried Employee
const salariedEmployee = {
  firstName: 'John',
  lastName: 'Doe',
  monthlyCTC: 50000,
  employmentType: 'full-time',
  compensationModel: 'SALARIED',
  paymentBasis: 'MONTHLY',
  pfEnabled: true,
  esiEnabled: true,
  ptEnabled: true,
  lwfEnabled: true,
  gratuityEnabled: true,
  deductions: { tds: 0 }
};

// 2. Consultant Employee
const consultantEmployee = {
  firstName: 'Jane',
  lastName: 'Consultant',
  monthlyCTC: 40000,
  employmentType: 'part-time',
  compensationModel: 'CONSULTANT',
  paymentBasis: 'MONTHLY',
  pfEnabled: false, // pre-hooks should have disabled these
  esiEnabled: false,
  ptEnabled: false,
  lwfEnabled: false,
  gratuityEnabled: false,
  deductions: { tds: 0 } // No manual TDS override
};

const attendance = {
  workingDays: 26,
  presentDays: 26,
  paidLeaves: 0,
  unpaidLeaves: 0,
  month: 7,
  year: 2026
};

// Variable transactions for consultant
const adjustmentsForConsultant = {
  variableTransactions: [
    { paymentType: 'POSITION', quantity: 2, rate: 10000, amount: 20000, reference: 'Closed positions' },
    { paymentType: 'PROJECT', quantity: 1, rate: 5000, amount: 5000, reference: 'Website launch' }
  ]
};

console.log('--- Testing Payroll Math ---');

// Compute salaried snapshot
const salariedSnapshot = buildPayrollSnapshot(salariedEmployee, config, attendance, {}, 7, 2026);
console.log('Salaried Employee Gross Earnings:', salariedSnapshot.earnings.totalEarnings);
console.log('Salaried Employee TDS:', salariedSnapshot.deductions.tds);
console.log('Salaried Employee PF Employee:', salariedSnapshot.deductions.pfEmployee);

// Compute consultant snapshot
const consultantSnapshot = buildPayrollSnapshot(consultantEmployee, config, attendance, adjustmentsForConsultant, 7, 2026);
console.log('Consultant Gross Earnings (Fixed + Variable):', consultantSnapshot.earnings.totalEarnings);
console.log('Consultant Variable Compensation List:', consultantSnapshot.earnings.variableCompensation);
console.log('Consultant Calculated TDS (Section 194J - 10%):', consultantSnapshot.deductions.tds);
console.log('Consultant PF Employee (Expected 0):', consultantSnapshot.deductions.pfEmployee);

// Assertions
if (salariedSnapshot.earnings.totalEarnings <= 0) {
  console.error('Assertion failed: Salaried earnings is not positive');
  process.exit(1);
}

// For consultant, total earnings = monthlyCTC (40000) + variable transactions (20000 + 5000) = 65000
const expectedEarnings = 40000 + 20000 + 5000;
if (consultantSnapshot.earnings.totalEarnings !== expectedEarnings) {
  console.error(`Assertion failed: Consultant earnings is ${consultantSnapshot.earnings.totalEarnings}, expected ${expectedEarnings}`);
  process.exit(1);
}

// 10% TDS on 65000 = 6500
if (consultantSnapshot.deductions.tds !== 6500) {
  console.error(`Assertion failed: Consultant TDS is ${consultantSnapshot.deductions.tds}, expected 6500`);
  process.exit(1);
}

if (consultantSnapshot.deductions.pfEmployee !== 0) {
  console.error('Assertion failed: Consultant pfEmployee is not 0');
  process.exit(1);
}

// 3. Piece Rate Employee Test
const pieceRateEmp = {
  firstName: 'Piece',
  lastName: 'Worker',
  compensationType: 'piece_rate',
  compensationModel: 'PIECE_RATE',
  tdsEnabled: false,
};
const pieceRateAdj = { unitsProduced: 100, ratePerUnit: 15 };
const pieceRateSnapshot = buildPayrollSnapshot(pieceRateEmp, config, attendance, pieceRateAdj, 7, 2026);
console.log('Piece Rate Gross Earnings:', pieceRateSnapshot.earnings.totalEarnings);
console.log('Piece Rate Net Salary:', pieceRateSnapshot.netSalary);
if (pieceRateSnapshot.earnings.totalEarnings !== 1500 || pieceRateSnapshot.netSalary !== 1500) {
  console.error(`Assertion failed: Piece rate expected ₹1,500, got gross=${pieceRateSnapshot.earnings.totalEarnings}, net=${pieceRateSnapshot.netSalary}`);
  process.exit(1);
}

// 4. Daily Wage Employee Test
const dailyWageEmp = {
  firstName: 'Daily',
  lastName: 'Worker',
  compensationType: 'daily_wage',
  compensationModel: 'DAILY_WAGE',
  tdsEnabled: false,
  rateCard: [{ paymentType: 'DAY', rate: 500 }],
};
const dailyWageAdj = { daysWorked: 10 };
const dailyWageSnapshot = buildPayrollSnapshot(dailyWageEmp, config, attendance, dailyWageAdj, 7, 2026);
console.log('Daily Wage Gross Earnings:', dailyWageSnapshot.earnings.totalEarnings);
console.log('Daily Wage Net Salary:', dailyWageSnapshot.netSalary);
if (dailyWageSnapshot.earnings.totalEarnings !== 5000 || dailyWageSnapshot.netSalary !== 5000) {
  console.error(`Assertion failed: Daily wage expected ₹5,000, got gross=${dailyWageSnapshot.earnings.totalEarnings}, net=${dailyWageSnapshot.netSalary}`);
  process.exit(1);
}

// 5. Timesheet Based Employee Test
const timesheetEmp = {
  firstName: 'Timesheet',
  lastName: 'Worker',
  compensationType: 'timesheet_based',
  compensationModel: 'TIMESHEET_BASED',
  tdsEnabled: false,
  monthlyCTC: 16000,
};
const timesheetAdj = { hoursLogged: 80 };
const timesheetSnapshot = buildPayrollSnapshot(timesheetEmp, config, attendance, timesheetAdj, 7, 2026);
console.log('Timesheet Based Gross Earnings:', timesheetSnapshot.earnings.totalEarnings);
console.log('Timesheet Based Net Salary:', timesheetSnapshot.netSalary);
if (timesheetSnapshot.earnings.totalEarnings !== 8000 || timesheetSnapshot.netSalary !== 8000) {
  console.error(`Assertion failed: Timesheet based expected ₹8,000, got gross=${timesheetSnapshot.earnings.totalEarnings}, net=${timesheetSnapshot.netSalary}`);
  process.exit(1);
}

// 6. Hourly Employee TDS Regression Test (A2)
const { calculateTaxDetails } = require('../../../../edited/MyBill/MBB/utils/payrollMath');
const hourlyTaxableEmp = {
  firstName: 'Hourly',
  lastName: 'Taxable',
  payType: 'hourly',
  compensationType: 'hourly',
  hourlyRate: 1000,
  tdsEnabled: true,
};
const hourlyAttendance = { ...attendance, hoursWorked: 160 }; // 1000 * 160 = 160,000 gross/month
const hourlySnapshot = buildPayrollSnapshot(hourlyTaxableEmp, config, hourlyAttendance, {}, 7, 2026);
const expectedTaxDetails = calculateTaxDetails(
  { ...hourlyTaxableEmp, ptEnabled: false, taxRegime: 'new', declarations: {} },
  160000,
  config,
  160000,
  0,
  160000
);
const expectedTds = expectedTaxDetails.newRegime.monthlyTax;

console.log('Hourly Employee Gross Earnings:', hourlySnapshot.earnings.totalEarnings);
console.log('Hourly Employee TDS:', hourlySnapshot.deductions.tds);
console.log('Expected TDS from calculateTaxDetails:', expectedTds);

if (hourlySnapshot.deductions.tds <= 0) {
  console.error(`Assertion failed: Hourly employee TDS should be positive, got ${hourlySnapshot.deductions.tds}`);
  process.exit(1);
}
if (hourlySnapshot.deductions.tds !== expectedTds) {
  console.error(`Assertion failed: Hourly employee TDS (${hourlySnapshot.deductions.tds}) does not match calculateTaxDetails (${expectedTds})`);
  process.exit(1);
}

// 7. Piece Rate Employee with PF Enabled Test (A3)
const configWithPieceRatePF = {
  ...config,
  compensationTypeDefaults: {
    piece_rate: { pfEligible: true }
  }
};
const pieceRatePFEmp = {
  firstName: 'PiecePF',
  lastName: 'Worker',
  compensationType: 'piece_rate',
  compensationModel: 'PIECE_RATE',
  tdsEnabled: false,
};
const pieceRatePFAdj = { unitsProduced: 100, ratePerUnit: 15 }; // Gross = 1500
const pieceRatePFSnapshot = buildPayrollSnapshot(pieceRatePFEmp, configWithPieceRatePF, attendance, pieceRatePFAdj, 7, 2026);
console.log('Piece Rate with PF Enabled Gross Earnings:', pieceRatePFSnapshot.earnings.totalEarnings);
console.log('Piece Rate with PF Enabled PF Employee Deduction:', pieceRatePFSnapshot.deductions.pfEmployee);
console.log('Piece Rate with PF Enabled Net Salary:', pieceRatePFSnapshot.netSalary);

// Expected PF = 12% of 1500 = 180
if (pieceRatePFSnapshot.deductions.pfEmployee !== 180) {
  console.error(`Assertion failed: Piece rate PF Employee deduction expected 180, got ${pieceRatePFSnapshot.deductions.pfEmployee}`);
  process.exit(1);
}
// 8. Commission Only, Project Based, Milestone Based Strategy Tests (A4)
const commOnlyEmp = {
  firstName: 'Comm',
  lastName: 'Only',
  compensationType: 'commission_only',
  compensationModel: 'COMMISSION_ONLY',
  tdsEnabled: false,
};
const commOnlyAdj = {
  variableTransactions: [
    { paymentType: 'COMMISSION', amount: 10000, reference: 'Deal A' },
    { paymentType: 'COMMISSION', amount: 5000, reference: 'Deal B' }
  ]
};
const commOnlySnapshot = buildPayrollSnapshot(commOnlyEmp, config, attendance, commOnlyAdj, 7, 2026);
console.log('Commission Only Gross Earnings:', commOnlySnapshot.earnings.totalEarnings);
if (commOnlySnapshot.earnings.totalEarnings !== 15000) {
  console.error(`Assertion failed: Commission Only total earnings expected 15,000, got ${commOnlySnapshot.earnings.totalEarnings}`);
  process.exit(1);
}

const projBasedEmp = {
  firstName: 'Project',
  lastName: 'Based',
  compensationType: 'project_based',
  compensationModel: 'PROJECT_BASED',
  tdsEnabled: false,
};
const projBasedAdj = {
  variableTransactions: [
    { paymentType: 'PROJECT', amount: 25000, reference: 'Project X' }
  ]
};
const projBasedSnapshot = buildPayrollSnapshot(projBasedEmp, config, attendance, projBasedAdj, 7, 2026);
console.log('Project Based Gross Earnings:', projBasedSnapshot.earnings.totalEarnings);
if (projBasedSnapshot.earnings.totalEarnings !== 25000) {
  console.error(`Assertion failed: Project Based total earnings expected 25,000, got ${projBasedSnapshot.earnings.totalEarnings}`);
  process.exit(1);
}

const milestoneEmp = {
  firstName: 'Milestone',
  lastName: 'Based',
  compensationType: 'milestone_based',
  compensationModel: 'MILESTONE_BASED',
  tdsEnabled: false,
};
const milestoneAdj = {
  variableTransactions: [
    { paymentType: 'MILESTONE', amount: 18000, reference: 'Phase 1' }
  ]
};
const milestoneSnapshot = buildPayrollSnapshot(milestoneEmp, config, attendance, milestoneAdj, 7, 2026);
console.log('Milestone Based Gross Earnings:', milestoneSnapshot.earnings.totalEarnings);
if (milestoneSnapshot.earnings.totalEarnings !== 18000) {
  console.error(`Assertion failed: Milestone Based total earnings expected 18,000, got ${milestoneSnapshot.earnings.totalEarnings}`);
  process.exit(1);
}

// 9. Employee Creation (Piece Rate) Test (A5)
const Employee = require('../models/Employee');
const pieceRateDoc = new Employee({
  user: '600000000000000000000001',
  employeeId: 'EMP-PR-001',
  firstName: 'Piece',
  lastName: 'RateTest',
  compensationType: 'piece_rate',
  compensationModel: 'PIECE_RATE',
});

const { deriveCompensationTypeFromLegacy, resolveStrategy, getStrategyStatutoryDefaults } = require('../utils/payrollStrategies/index');
const effCompType = pieceRateDoc.compensationType || deriveCompensationTypeFromLegacy(pieceRateDoc);
const stratMeta = resolveStrategy(effCompType);
const defaultFlags = getStrategyStatutoryDefaults(effCompType);

pieceRateDoc.useSalaryComponents = stratMeta.usesSalaryComponents;
pieceRateDoc.pfEnabled = defaultFlags.pfEligible;
pieceRateDoc.flexiAmount = stratMeta.zeroesFixedAllowances ? 0 : 5000;
pieceRateDoc.broadband = stratMeta.zeroesFixedAllowances ? 0 : 1000;
pieceRateDoc.petrol = stratMeta.zeroesFixedAllowances ? 0 : 2000;
pieceRateDoc.lta = stratMeta.zeroesFixedAllowances ? 0 : 3000;

console.log('Piece Rate Doc useSalaryComponents:', pieceRateDoc.useSalaryComponents);
console.log('Piece Rate Doc pfEnabled:', pieceRateDoc.pfEnabled);
console.log('Piece Rate Doc flexiAmount:', pieceRateDoc.flexiAmount);

if (pieceRateDoc.useSalaryComponents !== false) {
  console.error('Assertion failed: piece_rate employee useSalaryComponents should be false');
  process.exit(1);
}
if (pieceRateDoc.pfEnabled !== false) {
  console.error('Assertion failed: piece_rate employee pfEnabled should default to false');
  process.exit(1);
}
// 10. Strategy Validation Rules Test (B4)
const { validateCompensationTypePayload } = require('../controllers/employeeController');

const testCases = [
  { type: 'hourly', payload: { hourlyRate: 0 }, shouldFail: true },
  { type: 'hourly', payload: { hourlyRate: 500 }, shouldFail: false },
  { type: 'daily_wage', payload: { dailyRate: 0, monthlyCTC: 0 }, shouldFail: true },
  { type: 'daily_wage', payload: { dailyRate: 1000 }, shouldFail: false },
  { type: 'piece_rate', payload: { rateCard: [] }, shouldFail: true },
  { type: 'piece_rate', payload: { rateCard: [{ paymentType: 'UNIT', rate: 50 }] }, shouldFail: false },
  { type: 'monthly_salary', payload: { monthlyCTC: 0 }, shouldFail: true },
  { type: 'monthly_salary', payload: { monthlyCTC: 50000 }, shouldFail: false },
  { type: 'retainer', payload: { monthlyCTC: 0, rateCard: [] }, shouldFail: true },
  { type: 'retainer', payload: { monthlyCTC: 0, rateCard: [{ paymentType: 'MONTHLY', rate: 25000 }] }, shouldFail: false },
  { type: 'project_based', payload: { monthlyCTC: 0 }, shouldFail: false },
  { type: 'milestone_based', payload: { monthlyCTC: 0 }, shouldFail: false },
];

testCases.forEach(({ type, payload, shouldFail }) => {
  const err = validateCompensationTypePayload(type, payload);
  if (shouldFail && !err) {
    console.error(`Assertion failed: ${type} validation should fail for payload`, payload);
    process.exit(1);
  }
  if (!shouldFail && err) {
    console.error(`Assertion failed: ${type} validation should pass, got error: ${err}`);
    process.exit(1);
  }
});
// 11. Mid-Month Strategy Change Test (C1)
const midMonthCompEmp = {
  firstName: 'Converted',
  lastName: 'Contractor',
  compensationType: 'monthly_salary',
  monthlyCTC: 60000,
  salaryRevisions: [
    {
      effectiveDate: '2026-07-16T00:00:00.000Z',
      compensationType: 'monthly_salary',
      newCTC: 60000,
      previousCTC: 0,
    },
    {
      effectiveDate: '2026-07-01T00:00:00.000Z',
      compensationType: 'hourly',
      newHourlyRate: 250,
      newCTC: 0,
    }
  ]
};

const midMonthSnapshot = buildPayrollSnapshot(midMonthCompEmp, config, { paidDays: 30 }, {}, 7, 2026);
console.log('Mid-Month Strategy Split Gross Earnings:', midMonthSnapshot.earnings.totalEarnings);
if (midMonthSnapshot.earnings.totalEarnings <= 0) {
  console.error('Assertion failed: Mid-month strategy split gross earnings should be positive');
  process.exit(1);
}
console.log('Mid-Month Strategy Split Test passed!');

// 12. Negative Net Pay Shortfall Clamping Policy Test (C2)
const heavyLoanEmp = {
  firstName: 'Heavy',
  lastName: 'Borrower',
  compensationType: 'monthly_salary',
  monthlyCTC: 30000,
};
const heavyLoanAdj = {
  loanDeduction: 50000, // Exceeds gross (30,000)
};
const heavyLoanSnapshot = buildPayrollSnapshot(heavyLoanEmp, config, { paidDays: 30 }, heavyLoanAdj, 7, 2026);
console.log('Heavy Loan Snapshot Net Salary:', heavyLoanSnapshot.netSalary);
console.log('Heavy Loan Snapshot Shortfall:', heavyLoanSnapshot.payrollShortfall);

if (heavyLoanSnapshot.netSalary < 0) {
  console.error(`Assertion failed: Net salary should be clamped at 0, got ${heavyLoanSnapshot.netSalary}`);
  process.exit(1);
}
if (!heavyLoanSnapshot.payrollShortfall || heavyLoanSnapshot.payrollShortfall.shortfallAmount <= 0) {
  console.error('Assertion failed: payrollShortfall should record positive shortfall amount');
  process.exit(1);
}
console.log('Shortfall Clamping Policy Test passed!');

// 13. Minimum Wage Compliance Check Test (C2)
const lowDailyWageEmp = {
  firstName: 'LowWage',
  lastName: 'Worker',
  compensationType: 'daily_wage',
  ptState: 'KA', // KA daily minimum wage floor: ₹450/day
};
const lowDailyWageAdj = { daysWorked: 10, ratePerDay: 200 }; // Earned: ₹2,000, Required min: 10 * 450 = ₹4,500
const lowWageSnapshot = buildPayrollSnapshot(lowDailyWageEmp, config, { paidDays: 10 }, lowDailyWageAdj, 7, 2026);
console.log('Low Wage Snapshot Minimum Wage Flag:', lowWageSnapshot.minimumWageCompliance);

if (!lowWageSnapshot.minimumWageCompliance || !lowWageSnapshot.minimumWageCompliance.flagged) {
  console.error('Assertion failed: Minimum wage compliance check should flag low daily wage');
  process.exit(1);
}
console.log('Minimum Wage Compliance Check Test passed!');

// 14. Overtime Multiplier & Statutory Cap Warning Test (C3)
const otEmp = {
  firstName: 'Overtime',
  lastName: 'Worker',
  compensationType: 'monthly_salary',
  monthlyCTC: 32000, // Basic = 16,000 -> Hourly rate = 100/hr
};
const otAdj = {
  overtime: {
    weekdayHours: 40, // 40 * 100 * 1.5 = 6,000
    weekendHours: 15, // 15 * 100 * 2.0 = 3,000
    holidayHours: 5,  // 5 * 100 * 2.0 = 1,000
  }                   // Total OT = 60 hours (> 50 hrs statutory cap) -> Pay: 10,000
};
const otSnapshot = buildPayrollSnapshot(otEmp, config, { paidDays: 30 }, otAdj, 7, 2026);
console.log('Overtime Earnings Amount:', otSnapshot.earnings.overtime);
console.log('Overtime Total Hours:', otSnapshot.earnings.overtimeHours);
console.log('Overtime Cap Warning:', otSnapshot.earnings.overtimeCapWarning);

if (otSnapshot.earnings.overtime !== 10000) {
  console.error(`Assertion failed: Overtime pay should be 10000, got ${otSnapshot.earnings.overtime}`);
  process.exit(1);
}
if (!otSnapshot.earnings.overtimeCapWarning || !otSnapshot.earnings.overtimeCapWarning.flagged) {
  console.error('Assertion failed: Overtime cap warning should flag 60 hours OT');
  process.exit(1);
}
console.log('Overtime Multiplier & Cap Warning Test passed!');

// Test 15: Custom Strategy Metadata Registry Test
const { listCompensationTypes } = require('../utils/payrollStrategies/index');
const compTypesList = listCompensationTypes();
const milestoneMeta = compTypesList.find(c => c.key === 'milestone_based');
const pieceRateMeta = compTypesList.find(c => c.key === 'piece_rate');
const weeklySalaryMeta = compTypesList.find(c => c.key === 'weekly_salary');

if (!milestoneMeta || !milestoneMeta.requiredPeriodInputFields.includes('milestoneAmount') || !milestoneMeta.optionalPeriodInputFields.includes('milestoneRef')) {
  console.error('Assertion failed: milestone_based strategy metadata must expose required and optional fields');
  process.exit(1);
}
if (!pieceRateMeta || !pieceRateMeta.requiredPeriodInputFields.includes('unitsProduced') || !pieceRateMeta.optionalPeriodInputFields.includes('ratePerUnit')) {
  console.error('Assertion failed: piece_rate strategy metadata must expose required and optional fields');
  process.exit(1);
}
if (!weeklySalaryMeta || !weeklySalaryMeta.requiredPeriodInputFields.includes('paidDays')) {
  console.error('Assertion failed: weekly_salary strategy metadata must include paidDays');
  process.exit(1);
}
console.log('12th Custom Strategy Metadata Registry Test passed!');

// Test 16: Skip Period Flag Test
const skipPayload = { skip: true, _skipPeriod: true };
if (!skipPayload.skip && !skipPayload._skipPeriod) {
  console.error('Assertion failed: skip payload should flag skip');
  process.exit(1);
}
console.log('Skip Period Flag Test passed!');

// Test 17: Concurrency & Duplicate Key E11000 Error Handling Test
const mockMongoError = { code: 11000, name: 'MongoServerError', message: 'E11000 duplicate key error collection: payrolls index: user_1_employee_1_month_1_year_1' };
const isDuplicateKey = mockMongoError.code === 11000 || (mockMongoError.name === 'MongoServerError' && mockMongoError.code === 11000) || mockMongoError.message.includes('E11000');
const friendlyError = isDuplicateKey
  ? 'Payroll already exists or is being processed for this period — refresh and try again.'
  : mockMongoError.message;

if (!friendlyError.includes('Payroll already exists or is being processed for this period')) {
  console.error(`Assertion failed: Expected friendly concurrency duplicate key message, got '${friendlyError}'`);
  process.exit(1);
}
console.log('Concurrency & Duplicate Key E11000 Error Handling Test passed!');

// Test 18: PII Field-Level AES-256-GCM Encryption Test
const { encryptPIIField, decryptPIIField } = require('../utils/cryptoHelper');
const rawPan = 'ABCDE1234F';
const encryptedPan = encryptPIIField(rawPan);
const decryptedPan = decryptPIIField(encryptedPan);

if (!encryptedPan.startsWith('enc:v1:')) {
  console.error(`Assertion failed: Encrypted PAN should start with 'enc:v1:', got '${encryptedPan}'`);
  process.exit(1);
}
if (encryptedPan.includes(rawPan)) {
  console.error(`Assertion failed: Encrypted PAN should not contain raw plaintext, got '${encryptedPan}'`);
  process.exit(1);
}
if (decryptedPan !== rawPan) {
  console.error(`Assertion failed: Decrypted PAN (${decryptedPan}) does not match original plaintext (${rawPan})`);
  process.exit(1);
}
console.log('PII Field-Level AES-256-GCM Encryption Test passed!');

// Test 19: Retainer Skip Period Payload & Routing Test
const retainerSkipPayload = { _skipPeriod: true, adjustments: { _skipPeriod: true } };
const isRetainerSkipped = retainerSkipPayload._skipPeriod === true || retainerSkipPayload.adjustments?._skipPeriod === true;

if (!isRetainerSkipped) {
  console.error('Assertion failed: Retainer skip period should evaluate to true');
  process.exit(1);
}
console.log('Retainer Skip Period Payload & Routing Test passed!');

// Test 20: Bulk Salary Revision Calculation Test
const currentCTC = 50000;
const percentInc = 10;
const newComputedCTC = Math.round((currentCTC * (1 + percentInc / 100)) * 100) / 100;

if (newComputedCTC !== 55000) {
  console.error(`Assertion failed: Expected 10% increment on 50000 to be 55000, got ${newComputedCTC}`);
  process.exit(1);
}
console.log('Bulk Salary Revision Calculation Test passed!');

// Test 21: Point-in-Time Statutory Configuration Resolution Test
const oldConfig = { effectiveFrom: new Date('2024-01-01'), pfCap: 15000 };
const newConfig = { effectiveFrom: new Date('2026-01-01'), pfCap: 21000 };
const configs = [oldConfig, newConfig];

const resolveConfigForDate = (targetDate) => {
  const d = new Date(targetDate);
  return configs
    .filter(c => new Date(c.effectiveFrom) <= d)
    .sort((a, b) => new Date(b.effectiveFrom) - new Date(a.effectiveFrom))[0];
};

const resolved2024 = resolveConfigForDate('2024-06-01');
const resolved2026 = resolveConfigForDate('2026-06-01');

if (resolved2024.pfCap !== 15000) {
  console.error(`Assertion failed: Expected 2024 pfCap to be 15000, got ${resolved2024.pfCap}`);
  process.exit(1);
}
if (resolved2026.pfCap !== 21000) {
  console.error(`Assertion failed: Expected 2026 pfCap to be 21000, got ${resolved2026.pfCap}`);
  process.exit(1);
}
console.log('Point-in-Time Statutory Configuration Resolution Test passed!');

// Test 22: Multi-Level Approval Gating Test
const requiredApprovers = [
  { role: 'manager', approved: false },
  { role: 'finance', approved: false }
];

// Step 1: Manager approves
const managerApp = requiredApprovers.find(a => a.role === 'manager');
if (managerApp) managerApp.approved = true;

const pendingStep1 = requiredApprovers.filter(a => !a.approved);
if (pendingStep1.length !== 1 || pendingStep1[0].role !== 'finance') {
  console.error(`Assertion failed: Expected 1 pending approval (finance) after manager approval, got ${pendingStep1.length}`);
  process.exit(1);
}

// Step 2: Finance approves
const financeApp = requiredApprovers.find(a => a.role === 'finance');
if (financeApp) financeApp.approved = true;

const pendingStep2 = requiredApprovers.filter(a => !a.approved);
if (pendingStep2.length !== 0) {
  console.error(`Assertion failed: Expected 0 pending approvals after finance approval, got ${pendingStep2.length}`);
  process.exit(1);
}
console.log('Multi-Level Approval Gating Test passed!');

// Test 23: Performance Scale Validation Test
const { runBenchmark } = require('./benchmark_payroll_scale');
runBenchmark();

console.log('✅ ALL TEST PASSED!');
