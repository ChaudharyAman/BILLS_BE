const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const ProfileShareSchema = new mongoose.Schema({
  profile:     { type: mongoose.Schema.Types.ObjectId, ref: 'ClientProfile', required: true, index: true },
  createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  shareType:   { type: String, enum: ['USER_INVITE', 'PUBLIC_LINK'], required: true },

  // USER_INVITE fields
  sharedWithUser:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  sharedWithEmail: { type: String, trim: true, lowercase: true, default: '' },

  // PUBLIC_LINK fields
  token:        { type: String },
  passcodeHash: { type: String, default: null },

  // Lifecycle
  status:    { type: String, enum: ['active', 'revoked', 'expired'], default: 'active', index: true },
  expiresAt: { type: Date, default: null },

  // Dynamic rules
  rules: {
    accessLevel: { type: String, enum: ['VIEW_ONLY', 'CAN_EDIT'], default: 'VIEW_ONLY' },
    modules: { type: [String], default: [] }, // empty = all modules
    modulePermissions: { type: Map, of: String, default: {} }, // optional override: { invoices: 'edit', reports: 'view' }
    hiddenFields: { type: [String], default: [] },
    dateRange: {
      from: { type: Date, default: null },
      to:   { type: Date, default: null },
    },
    watermarkLabel: { type: String, default: '' },
    allowPdfDownload: { type: Boolean, default: true },
    allowDataExport:  { type: Boolean, default: false },
  },

  // Audit trail
  lastAccessedAt: { type: Date, default: null },
  accessCount:    { type: Number, default: 0 },
  accessLog: [{
    at: { type: Date, default: Date.now },
    ip: { type: String, default: '' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  }],
}, { timestamps: true });

ProfileShareSchema.index({ token: 1 }, { unique: true, sparse: true });
ProfileShareSchema.index({ profile: 1, status: 1 });
ProfileShareSchema.index({ sharedWithUser: 1, status: 1 });

ProfileShareSchema.methods.checkPasscode = async function (candidate) {
  if (!this.passcodeHash) return true;
  return bcrypt.compare(candidate || '', this.passcodeHash);
};

module.exports = mongoose.model('ProfileShare', ProfileShareSchema);
