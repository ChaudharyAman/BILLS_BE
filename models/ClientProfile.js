const mongoose = require('mongoose');
const softDeletePlugin = require('../middleware/softDeletePlugin');

const ClientProfileSchema = new mongoose.Schema({
  owner:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name:        { type: String, required: true, trim: true },
  code:        { type: String, required: true, trim: true, uppercase: true },
  clientTag:   { type: String, default: '' },
  logoUrl:     { type: String, default: '' },
  color:       { type: String, default: '#2563eb' },
  status:      { type: String, enum: ['active', 'archived'], default: 'active' },
  isDefault:   { type: Boolean, default: false },
  planOverride: { type: String, enum: ['inherit'], default: 'inherit' },
}, { timestamps: true });

ClientProfileSchema.index({ owner: 1, name: 1 }, { unique: true });
ClientProfileSchema.index({ owner: 1, code: 1 }, { unique: true });

ClientProfileSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('ClientProfile', ClientProfileSchema);
