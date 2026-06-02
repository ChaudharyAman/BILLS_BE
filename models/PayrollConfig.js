const mongoose = require('mongoose');

const PayrollConfigSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  basicPercent: { type: Number, default: 0.5 },
  hraPercent: { type: Number, default: 0.5 },
  pfRate: { type: Number, default: 0.12 },
  pfCap: { type: Number, default: 15000 },
  pfEmployerRate: { type: Number, default: 0.12 },
  esiEmployeeRate: { type: Number, default: 0.0075 },
  esiEmployerRate: { type: Number, default: 0.0325 },
  esiBasicThreshold: { type: Number, default: 21000 },
  lwfEmployer: { type: Number, default: 35 },
  lwfEmployee: { type: Number, default: 15 },
  gratuityRate: { type: Number, default: 0.12 },
  defaultWorkingDays: { type: Number, default: 30 },
  defaultInsurance: { type: Number, default: 0 },
  ltaMaxPercent: { type: Number, default: 0.0833 },
  salaryComponents: {
    type: Array,
    default: () => [
      { id: 'basic',                    name: 'Basic Salary',                  type: 'earning',   taxable: true,  linkedTo: 'ctc_percent',   linkValue: 0.5,           frequency: 'monthly' },
      { id: 'hra',                      name: 'HRA',                           type: 'earning',   taxable: false, linkedTo: 'basic_percent', linkValue: 0.5,             frequency: 'monthly' },
      { id: 'special',                  name: 'Special Allowance',             type: 'earning',   taxable: true,  linkedTo: 'remainder',     linkValue: 0,             frequency: 'monthly' },
      { id: 'flexi',                    name: 'Flexi Allowance',               type: 'earning',   taxable: false, linkedTo: 'fixed',         linkValue: 0,             frequency: 'monthly' },
      { id: 'broadband',                name: 'Broadband',                     type: 'earning',   taxable: false, linkedTo: 'fixed',         linkValue: 0,             frequency: 'monthly' },
      { id: 'petrol',                   name: 'Petrol',                        type: 'earning',   taxable: false, linkedTo: 'fixed',         linkValue: 0,             frequency: 'monthly' },
      { id: 'lta',                      name: 'LTA',                           type: 'earning',   taxable: false, linkedTo: 'fixed',         linkValue: 0,             frequency: 'monthly' },
      { id: 'conveyance',               name: 'Conveyance',                    type: 'earning',   taxable: false, linkedTo: 'fixed',         linkValue: 0,             frequency: 'monthly' },
      { id: 'medical',                  name: 'Medical Allowance',             type: 'earning',   taxable: false, linkedTo: 'fixed',         linkValue: 0,             frequency: 'monthly' },
      { id: 'pf_rate_employee',         name: 'PF Rate - Employee',            type: 'deduction', taxable: false, linkedTo: 'basic_percent', linkValue: 0.12,          frequency: 'monthly' },
      { id: 'pf_rate_employer',         name: 'PF Rate - Employer',            type: 'deduction', taxable: false, linkedTo: 'basic_percent', linkValue: 0.12,          frequency: 'monthly' },
      { id: 'pf_salary_ceiling',        name: 'PF Salary Ceiling',             type: 'deduction', taxable: false, linkedTo: 'fixed',         linkValue: 15000,         frequency: 'monthly' },
      { id: 'esi_rate_employee',        name: 'ESI Rate - Employee',           type: 'deduction', taxable: false, linkedTo: 'ctc_percent',   linkValue: 0.0075,        frequency: 'monthly' },
      { id: 'esi_rate_employer',        name: 'ESI Rate - Employer',           type: 'deduction', taxable: false, linkedTo: 'ctc_percent',   linkValue: 0.0325,        frequency: 'monthly' },
      { id: 'esi_threshold',            name: 'ESI Applicable if Basic below', type: 'deduction', taxable: false, linkedTo: 'fixed',         linkValue: 21000,         frequency: 'monthly' },
      { id: 'lwf_employer',             name: 'LWF - Employer',                type: 'deduction', taxable: false, linkedTo: 'fixed',         linkValue: 35,            frequency: 'monthly' },
      { id: 'lwf_employee',             name: 'LWF - Employee',                type: 'deduction', taxable: false, linkedTo: 'fixed',         linkValue: 15,            frequency: 'monthly' },
      { id: 'gratuity_rate',            name: 'Gratuity Rate',                 type: 'deduction', taxable: false, linkedTo: 'basic_percent', linkValue: 0.12,          frequency: 'monthly' },
      { id: 'default_working_days',     name: 'Default Working Days per Month',type: 'earning',   taxable: false, linkedTo: 'fixed',         linkValue: 30,            frequency: 'monthly' },
      { id: 'default_insurance_amount', name: 'Default Insurance Amount',       type: 'deduction', taxable: false, linkedTo: 'fixed',         linkValue: 0,             frequency: 'monthly' },
      { id: 'lta_max_percent',          name: 'LTA Max % of Basic',            type: 'earning',   taxable: false, linkedTo: 'basic_percent', linkValue: 0.0833,        frequency: 'monthly' },
    ]
  },
}, { timestamps: true });

module.exports = mongoose.model('PayrollConfig', PayrollConfigSchema);
