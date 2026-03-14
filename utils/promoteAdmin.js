const mongoose = require('mongoose');
const User = require('../models/User');
const connectDB = require('../db');
const dotenv = require('dotenv');

dotenv.config();

const promoteUser = async (identifier) => {
  try {
    await connectDB();
    
    const user = await User.findOne({ 
      $or: [{ email: identifier }, { username: identifier }] 
    });

    if (!user) {
      console.error('User not found.');
      process.exit(1);
    }

    user.role = 'superadmin';
    await user.save();
    
    console.log(`Success! User ${user.username} (${user.email}) has been promoted to superadmin.`);
    process.exit(0);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

const identifier = process.argv[2];
if (!identifier) {
  console.log('Usage: node promoteAdmin.js <email_or_username>');
  process.exit(1);
}

promoteUser(identifier);
