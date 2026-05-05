const User = require('../models/User');

const bootstrapAdmin = async () => {
  const enabled = String(process.env.BOOTSTRAP_ADMIN_ENABLED || '').toLowerCase() === 'true';
  const adminEmail = String(process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();

  if (!enabled || !adminEmail) {
    return;
  }
  
  try {
    const user = await User.findOne({ email: adminEmail });
    
    if (user) {
      if (user.role !== 'superadmin') {
        user.role = 'superadmin';
        await user.save();
        console.log(`[BOOTSTRAP] Successfully promoted ${adminEmail} to superadmin.`);
      }
    } else {
      console.log(`[BOOTSTRAP] Admin user ${adminEmail} not found. Bootstrap skipped.`);
    }
  } catch (error) {
    console.error(`[BOOTSTRAP] Error promoting admin: ${error.message}`);
  }
};

module.exports = bootstrapAdmin;
