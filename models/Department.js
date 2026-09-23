const mongoose = require('mongoose');
const softDeletePlugin = require('../middleware/softDeletePlugin');

const DepartmentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  profile: { type: mongoose.Schema.Types.ObjectId, ref: 'ClientProfile', required: false, index: true },
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, trim: true, uppercase: true },
  head: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
  description: { type: String, default: '' },
  budget: { type: Number, default: 0, min: 0 },
}, { timestamps: true });

DepartmentSchema.index({ profile: 1, name: 1 }, { unique: true, sparse: true });
DepartmentSchema.index({ profile: 1, code: 1 }, { unique: true, sparse: true });
DepartmentSchema.index({ user: 1, name: 1 }, { unique: true, sparse: true });
DepartmentSchema.index({ user: 1, code: 1 }, { unique: true, sparse: true });

DepartmentSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Department', DepartmentSchema);
