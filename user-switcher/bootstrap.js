const User = require('../models/User');
const MasterUser = require('./MasterUser');
const config = require('./config');

/**
 * Ensures the Master User account exists in the isolated MasterUser collection
 * AND purges any legacy master entries from the standard User model.
 */
const bootstrapMasterUser = async () => {
  try {
    const { username, email, password, role } = config.masterUser;

    if (!email) {
      console.warn('[USER-SWITCHER] Master user bootstrap skipped: no email configured');
      return null;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const cleanUsername = username.trim();

    // 1. Purge legacy master user from the standard User model so it is NOT visible there
    try {
      const removed = await User.deleteMany({
        $or: [
          { email: normalizedEmail },
          { username: cleanUsername },
        ],
      });
      if (removed.deletedCount > 0) {
        console.log(`[USER-SWITCHER] 🧹 Removed ${removed.deletedCount} legacy master user document(s) from standard User model`);
      }
    } catch (cleanErr) {
      console.warn('[USER-SWITCHER] Legacy User collection cleanup warning:', cleanErr.message);
    }

    // 2. Ensure MasterUser exists in the isolated MasterUser collection
    let master = await MasterUser.findOne({
      $or: [
        { email: normalizedEmail },
        { username: cleanUsername },
      ],
    });

    if (!master) {
      if (!password) {
        console.error('[USER-SWITCHER] ⚠️ Cannot auto-create Master User: MASTER_USER_PASSWORD environment variable is not defined.');
        return null;
      }
      master = new MasterUser({
        username: cleanUsername,
        email: normalizedEmail,
        password, // Handled by pre('save') bcrypt hash
        role: role || 'superadmin',
        isActive: true,
        isMasterUser: true,
        subscription: {
          plan: 'pro',
          status: 'active',
        },
      });

      await master.save();
      console.log(`[USER-SWITCHER] ✨ Created isolated Master User: ${master.username} (${master.email}) in MasterUser collection`);
    } else {
      let modified = false;

      // Note: We do NOT overwrite master.isActive if it was explicitly deactivated by an admin
      if (master.role !== 'superadmin') {
        master.role = 'superadmin';
        modified = true;
      }

      if (!master.isMasterUser) {
        master.isMasterUser = true;
        modified = true;
      }

      if (modified) {
        await master.save();
        console.log(`[USER-SWITCHER] 🔄 Updated isolated Master User: ${master.username} (${master.email}) in MasterUser collection`);
      } else {
        console.log(`[USER-SWITCHER] ✅ Master User ready in MasterUser collection: ${master.username} (${master.email}) (Active: ${master.isActive})`);
      }
    }

    return master;
  } catch (error) {
    console.error('[USER-SWITCHER] Failed to bootstrap Master User:', error.message);
    return null;
  }
};

module.exports = bootstrapMasterUser;
