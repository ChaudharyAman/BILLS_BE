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
  gratuityRate: { type: Number, default: 0.0481 },
  defaultWorkingDays: { type: Number, default: 26 },
  defaultInsurance: { type: Number, default: 1000 },
  ltaMaxPercent: { type: Number, default: 0.0833 },
}, { timestamps: true });

module.exports = mongoose.model('PayrollConfig', PayrollConfigSchema);
