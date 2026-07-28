const mongoose = require('mongoose');
const softDeletePlugin = require('../middleware/softDeletePlugin');

const BusinessUnitSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, trim: true, uppercase: true },
  description: { type: String, default: '' },
  head: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  color: { type: String, default: '#2563eb' },
  isDefault: { type: Boolean, default: false },
}, { timestamps: true });

BusinessUnitSchema.index({ user: 1, name: 1 }, { unique: true });
BusinessUnitSchema.index({ user: 1, code: 1 }, { unique: true });

BusinessUnitSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('BusinessUnit', BusinessUnitSchema);
