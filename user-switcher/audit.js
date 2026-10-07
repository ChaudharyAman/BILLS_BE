const mongoose = require('mongoose');

/**
 * SwitchAuditLog Model
 * Records every impersonation action, switch, exit, and login for non-repudiation.
 */
const switchAuditSchema = new mongoose.Schema({
  action: {
    type: String,
    enum: ['MASTER_LOGIN', 'SWITCH_USER', 'EXIT_SWITCH', 'IMPERSONATED_ACTION'],
    required: true,
  },
  masterId: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
  },
  masterUsername: {
    type: String,
    default: '',
  },
  masterEmail: {
    type: String,
    default: '',
  },
  targetUserId: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  targetUsername: {
    type: String,
    default: '',
  },
  ip: {
    type: String,
    default: '',
  },
  userAgent: {
    type: String,
    default: '',
  },
  method: {
    type: String,
    default: '',
  },
  path: {
    type: String,
    default: '',
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

const SwitchAuditLog = mongoose.models.SwitchAuditLog || mongoose.model('SwitchAuditLog', switchAuditSchema);

/**
 * Helper to record audit events non-blockingly
 */
const logSwitchAuditEvent = async ({
  action,
  req,
  masterUser,
  targetUser,
  details = {},
}) => {
  try {
    const ip = req?.ip || req?.socket?.remoteAddress || '';
    const userAgent = req?.headers?.['user-agent'] || '';

    const entry = new SwitchAuditLog({
      action,
      masterId: masterUser?._id || masterUser?.id || 'unknown',
      masterUsername: masterUser?.username || '',
      masterEmail: masterUser?.email || '',
      targetUserId: targetUser?._id || targetUser?.id || null,
      targetUsername: targetUser?.username || '',
      ip,
      userAgent,
      method: req?.method || '',
      path: req?.originalUrl || req?.path || '',
      details,
    });

    await entry.save();
  } catch (err) {
    console.error('[USER-SWITCHER-AUDIT] Failed to save audit log:', err.message);
  }
};

module.exports = {
  SwitchAuditLog,
  logSwitchAuditEvent,
};
