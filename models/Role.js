const mongoose = require('mongoose');

const RoleSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },

  // Employment classification
  employmentType: { type: String, enum: ['full-time', 'part-time', 'contract', 'intern'], default: 'full-time' },

  // Pay structure
  payType: { type: String, enum: ['salaried', 'hourly'], default: 'salaried', required: true },
  useSalaryComponents: { type: Boolean, default: true },
  monthlyCTC: { type: Number, default: 0, min: 0 },
  hourlyRate: { type: Number, default: 0, min: 0 },

  // Statutory switches
  pfEnabled: { type: Boolean, default: true },
  esiEnabled: { type: Boolean, default: true },
  ptEnabled: { type: Boolean, default: true },
  lwfEnabled: { type: Boolean, default: true },
  gratuityEnabled: { type: Boolean, default: true },

  // CTC Integration switches
  includePfInCTC: { type: Boolean, default: false },
  includeGratuityInCTC: { type: Boolean, default: true },

  // Custom salary component ratios (Overrides)
  basicPercent: { type: Number, default: null, min: 0, max: 100 },
  hraPercent: { type: Number, default: null, min: 0, max: 100 },
}, { timestamps: true });

// Ensure unique job role names per user/company
RoleSchema.index({ user: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Role', RoleSchema);
