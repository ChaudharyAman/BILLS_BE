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

  const start = new Date('2026-05-01T00:00:00.000Z');
  const end = new Date('2026-05-31T23:59:59.999Z');

  const invoices = await Invoice.find({
    user: userId,
    date: { $gte: start, $lte: end },
    status: { $in: ['SENT', 'PAID', 'PARTIAL', 'UNPAID'] }
  }).lean();

  console.log('\n--- MAY 2026 INVOICES RAW ITEMS ---');
  invoices.forEach(inv => {
    console.log(`InvoiceNo: ${inv.invoiceNo}`);
    console.log(`  subTotal: ${inv.subTotal}, taxTotal: ${inv.taxTotal}, grandTotal: ${inv.grandTotal}`);
    console.log('  Items Raw:', JSON.stringify(inv.items, null, 2));
  });

  await mongoose.disconnect();
}

run().catch(console.error);
