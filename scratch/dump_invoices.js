const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const Invoice = require('../models/Invoice');

async function dump() {
  const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mybill';
  await mongoose.connect(mongoUri);
  const invoices = await Invoice.find({ invoiceNo: '1' }).lean();
  console.log('=== INVOICES WITH NO "1" ===');
  invoices.forEach(inv => {
    console.log(JSON.stringify(inv, null, 2));
  });
  await mongoose.disconnect();
}

dump().catch(console.error);
