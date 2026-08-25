const mongoose = require('mongoose');

const AdminAuditLogSchema = new mongoose.Schema({
  actorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  actorUsername: {
    type: String,
    default: '',
  },
  actorEmail: {
    type: String,
    default: '',
  },
  action: {
    type: String,
    required: true,
    enum: [
      'CREATE_USER',
      'UPDATE_USER_PLAN',
      'DELETE_USER',
      'UPDATE_TEAM_MEMBER',
      'ROLE_CHANGE',
      'SUPERADMIN_PROMOTION',
      'SUPERADMIN_DEMOTION',
      'RESET_USER_PASSWORD',
    ],
  },
  targetType: {
    type: String,
    required: true,
    enum: ['User', 'Company', 'TeamMember', 'AccessRole'],
  },
  targetId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
  },
  targetLabel: {
    type: String,
    default: '',
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
}, { timestamps: true });

AdminAuditLogSchema.index({ createdAt: -1 });
AdminAuditLogSchema.index({ actorId: 1 });
AdminAuditLogSchema.index({ action: 1 });

module.exports = mongoose.model('AdminAuditLog', AdminAuditLogSchema);
