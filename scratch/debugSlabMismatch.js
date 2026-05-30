const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const Invoice = require('../models/Invoice');
const User = require('../models/User');

async function run() {
  const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mybill';
  await mongoose.connect(mongoUri);

  const user = await User.findOne({ username: 'aman' });
  const userId = user._id;

  const inv21 = await Invoice.findOne({ user: userId, invoiceNo: 'INV-021' }).lean();
  const inv22 = await Invoice.findOne({ user: userId, invoiceNo: 'INV-022' }).lean();

  console.log('--- INV-021 Raw Document ---');
  console.log(JSON.stringify(inv21, null, 2));

  console.log('\n--- INV-022 Raw Document ---');
  console.log(JSON.stringify(inv22, null, 2));

  await mongoose.disconnect();
}

run().catch(console.error);
