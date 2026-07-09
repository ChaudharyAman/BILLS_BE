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

console.log('✅ ALL TEST PASSED!');
