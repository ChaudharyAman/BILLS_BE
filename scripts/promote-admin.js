const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const User = require('../models/User');
const connectDB = require('../db');

// Load env vars
dotenv.config({ path: path.resolve(__dirname, '../.env') });

async function promoteAdmin() {
  const email = process.argv[2];

  if (!email) {
    console.error('Please provide a user email as an argument.');
    console.log('Usage: node scripts/promote-admin.js user@example.com');
    process.exit(1);
  }

  try {
    await connectDB();

    const user = await User.findOne({ email });

    if (!user) {
      console.error(`User with email "${email}" not found.`);
      process.exit(1);
    }

    if (user.role === 'superadmin') {
      console.log(`User "${email}" is already a superadmin.`);
      process.exit(0);
    }

    user.role = 'superadmin';
    await user.save();

    console.log(`Successfully promoted user "${email}" to superadmin.`);
    process.exit(0);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

promoteAdmin();
