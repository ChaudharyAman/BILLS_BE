const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const Invoice = require('../models/Invoice');
const User = require('../models/User');

const GST_CLASSES = ['B2B', 'B2C', 'Export', 'NilRated'];

function classifyInvoice(row = {}) {
  if (GST_CLASSES.includes(row.gstInvoiceType)) return row.gstInvoiceType;
  if (GST_CLASSES.includes(row.invoiceType)) return row.invoiceType;
  const items = Array.isArray(row.items) ? row.items : [];
  if (items.length && items.every((item) => item.isNilRated === true || Number(item.taxRate) === 0)) return 'NilRated';
  if (/international|export/i.test(String(row.placeOfSupply || ''))) return 'Export';
  if (/^[0-9A-Z]{15}$/.test(String(row.client?.gstin || '').trim().toUpperCase())) return 'B2B';
  return 'B2C';
}

async function run() {
  const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mybill';
  await mongoose.connect(mongoUri);

  const user = await User.findOne({ username: 'aman' });
  const userId = user._id;

  const start = new Date('2014-02-14T00:00:00.000Z');
  const end = new Date('2026-05-30T23:59:59.999Z');

  const invoices = await Invoice.find({
    user: userId,
    date: { $gte: start, $lte: end },
    status: { $in: ['SENT', 'PAID', 'PARTIAL', 'UNPAID'] }
  }).lean();

  const nilRatedInvoices = invoices.filter(inv => classifyInvoice(inv) === 'NilRated');

  console.log(`Found ${nilRatedInvoices.length} Nil-rated invoices:\n`);

  nilRatedInvoices.forEach((inv, idx) => {
    console.log(`[${idx+1}] Invoice No: ${inv.invoiceNo}`);
    console.log(`    Date: ${new Date(inv.date).toLocaleDateString('en-IN')}`);
    console.log(`    Client Name: ${inv.client?.name}`);
    console.log(`    Subtotal: Rs ${inv.subTotal}`);
    console.log(`    Tax Total: Rs ${inv.taxTotal}`);
    console.log(`    Grand Total: Rs ${inv.grandTotal}`);
    console.log(`    Classification Source (gstInvoiceType/invoiceType): ${inv.gstInvoiceType || 'None'} / ${inv.invoiceType || 'None'}`);
    console.log(`    Items:`);
    inv.items?.forEach((item, itemIdx) => {
      console.log(`      Item ${itemIdx+1}: name="${item.name}", taxRate=${item.taxRate}%, taxAmount=Rs ${item.taxAmount}, isNilRated=${item.isNilRated || false}`);
    });
    console.log('');
  });

  await mongoose.disconnect();
}

run().catch(console.error);
