const mongoose = require('mongoose');

const PayrollConfigSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  basicPercent: { type: Number, default: 0.5 },
  hraPercent: { type: Number, default: 0.5 },
  pfRate: { type: Number, default: 0.12 },
  pfCap: { type: Number, default: 15000 },
  pfEmployerRate: { type: Number, default: 0.12 },
  pfCalculationType: { type: String, enum: ['percent', 'fixed'], default: 'percent' },
  pfAmountEmployee: { type: Number, default: 1800 },
  pfAmountEmployer: { type: Number, default: 1800 },
  esiEmployeeRate: { type: Number, default: 0.0075 },
  esiEmployerRate: { type: Number, default: 0.0325 },
  esiBasicThreshold: { type: Number, default: 21000 },
  lwfEmployer: { type: Number, default: 35 },
  lwfEmployee: { type: Number, default: 15 },
  gratuityRate: { type: Number, default: 0.0481 },
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
    ]
  },
}, { timestamps: true });

module.exports = mongoose.model('PayrollConfig', PayrollConfigSchema);
