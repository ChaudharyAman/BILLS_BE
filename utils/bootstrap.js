const User = require('../models/User');

const bootstrapAdmin = async () => {
  const adminEmail = 'demo@gmail.com';
  
  try {
    const user = await User.findOne({ email: adminEmail });
    
    if (user) {
      if (user.role !== 'superadmin') {
        user.role = 'superadmin';
        await user.save();
        console.log(`[BOOTSTRAP] Successfully promoted ${adminEmail} to superadmin.`);
      }
    } else {
      console.log(`[BOOTSTRAP] Admin user ${adminEmail} not found. Register this email to auto-promote.`);
    }
  } catch (error) {
    console.error(`[BOOTSTRAP] Error promoting admin: ${error.message}`);
  }
};

module.exports = bootstrapAdmin;
