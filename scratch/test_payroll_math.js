const { buildMasterSalaryStructure } = require('../utils/payrollMath');

function assert(condition, message) {
  if (!condition) {
    console.error(`[FAIL] ${message}`);
    process.exit(1);
  } else {
    console.log(`[PASS] ${message}`);
  }
}

console.log('--- Testing Payroll Math Toggles and CTC Integration ---');

// Base Case: Everything enabled and included in CTC
const baseEmployee = {
  monthlyCTC: 30000,
  pfEnabled: true,
  esiEnabled: true,
  ptEnabled: true,
  lwfEnabled: true,
  gratuityEnabled: true,
  includePfInCTC: true,
  includeGratuityInCTC: true,
  insuranceAmount: 1000,
  flexiAmount: 0,
  broadband: 0,
  petrol: 0,
  lta: 0,
  employerNPS: 0,
  salaryStructure: { conveyance: 0, medicalAllowance: 0 },
  deductions: { professionalTax: 200, tds: 0 }
};

const baseResult = buildMasterSalaryStructure(baseEmployee);
console.log(`Stated CTC: ₹${baseResult.monthlyCTC}, Gross Total Salary (Total Cost): ₹${baseResult.grossTotalSalary}`);
assert(baseResult.monthlyCTC === 30000, 'Stated CTC should be 30000');
assert(baseResult.grossTotalSalary === 30000, 'When all employer costs are included in CTC, Gross Total Salary must equal Stated CTC');
assert(baseResult.pfEmployer === 1800, 'PF Employer should be 12% of 15000 = 1800');
assert(baseResult.pfEmployee === 1800, 'PF Employee should be 12% of 15000 = 1800');
assert(baseResult.gratuity === 721.5, 'Gratuity should be 4.81% of 15000 = 721.5');
assert(baseResult.lwfEmployer === 35, 'LWF Employer should be 35');
assert(baseResult.lwfEmployee === 15, 'LWF Employee should be 15');
assert(baseResult.professionalTax === 200, 'Professional tax should be 200');

// Test Case 1: PF Disabled
const pfDisabledEmployee = {
  ...baseEmployee,
  pfEnabled: false
};
const pfDisabledResult = buildMasterSalaryStructure(pfDisabledEmployee);
assert(pfDisabledResult.pfEmployer === 0, 'PF Employer should be 0 when pfEnabled is false');
assert(pfDisabledResult.pfEmployee === 0, 'PF Employee should be 0 when pfEnabled is false');
assert(pfDisabledResult.grossTotalSalary === 30000, 'Gross Total Salary should remain equal to Stated CTC');

// Test Case 2: ESI Disabled
const EsiDisabledEmployee = {
  ...baseEmployee,
  esiEnabled: false
};
const esiDisabledResult = buildMasterSalaryStructure(EsiDisabledEmployee);
assert(esiDisabledResult.esiEmployer === 0, 'ESI Employer should be 0 when esiEnabled is false');
assert(esiDisabledResult.esiEmployee === 0, 'ESI Employee should be 0 when esiEnabled is false');

// Test Case 3: PT Disabled
const ptDisabledEmployee = {
  ...baseEmployee,
  ptEnabled: false
};
const ptDisabledResult = buildMasterSalaryStructure(ptDisabledEmployee);
assert(ptDisabledResult.professionalTax === 0, 'Professional Tax should be 0 when ptEnabled is false');
assert(ptDisabledResult.totalDeductions === (ptDisabledResult.pfEmployee + ptDisabledResult.esiEmployee + ptDisabledResult.tds + ptDisabledResult.lwfEmployee), 'Deductions should exclude PT when disabled');

// Test Case 4: Gratuity Disabled
const gratuityDisabledEmployee = {
  ...baseEmployee,
  gratuityEnabled: false
};
const gratuityDisabledResult = buildMasterSalaryStructure(gratuityDisabledEmployee);
assert(gratuityDisabledResult.gratuity === 0, 'Gratuity should be 0 when gratuityEnabled is false');

// Test Case 5: LWF Disabled
const lwfDisabledEmployee = {
  ...baseEmployee,
  lwfEnabled: false
};
const lwfDisabledResult = buildMasterSalaryStructure(lwfDisabledEmployee);
assert(lwfDisabledResult.lwfEmployer === 0, 'LWF Employer should be 0 when lwfEnabled is false');
assert(lwfDisabledResult.lwfEmployee === 0, 'LWF Employee should be 0 when lwfEnabled is false');

// Test Case 6: Employer PF and Gratuity NOT included in CTC (Over-and-above liabilities)
const overAndAboveEmployee = {
  ...baseEmployee,
  includePfInCTC: false,
  includeGratuityInCTC: false
};
const overAndAboveResult = buildMasterSalaryStructure(overAndAboveEmployee);
console.log(`Stated CTC: ₹${overAndAboveResult.monthlyCTC}, Gross Total Salary (Total Cost): ₹${overAndAboveResult.grossTotalSalary}`);
assert(overAndAboveResult.monthlyCTC === 30000, 'Stated CTC remains 30000');
assert(overAndAboveResult.pfEmployer === 1800, 'PF Employer is still 1800');
assert(overAndAboveResult.gratuity === 721.5, 'Gratuity is still 721.5');
assert(overAndAboveResult.grossTotalSalary === 30000 + 1800 + 721.5, `Gross Total Salary should be Stated CTC + PF Employer + Gratuity: ${30000 + 1800 + 721.5}`);

console.log('--- ALL TEST CASES PASSED SUCCESSFULLY ---');
