const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const Invoice = require('../models/Invoice');
const User = require('../models/User');

async function fixInconsistentInvoices() {
  const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mybill';
  console.log(`Connecting to MongoDB at: ${mongoUri}`);
  
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB successfully.');

  const defaultUser = await User.findOne({});
  if (!defaultUser) {
    console.error('No users found in the database. Cannot fix invoices without a user association.');
    await mongoose.disconnect();
    return;
  }
  console.log(`Using default user for orphan invoices: ${defaultUser.username} (${defaultUser._id})`);

  const invoices = await Invoice.find({});
  console.log(`Found ${invoices.length} total invoices in the database.`);

  let fixCount = 0;

  for (const invoice of invoices) {
    let modified = false;

    // Fix orphan invoices by assigning a default user
    if (!invoice.user) {
      console.log(`[FIXING] Invoice ${invoice.invoiceNo} has no associated user. Assigning to default user.`);
      invoice.user = defaultUser._id;
      modified = true;
    }

    // 1. If status is PAID, balanceDue must be 0 and advancePaid must be grandTotal - tds
    if (invoice.status === 'PAID') {
      const targetAdvance = Math.round(((invoice.grandTotal || 0) - (invoice.tds || 0)) * 100) / 100;
      if (invoice.balanceDue !== 0 || invoice.advancePaid !== targetAdvance) {
        console.log(`[FIXING] Invoice ${invoice.invoiceNo} (${invoice.client?.name || 'Unknown'}): status is PAID but has inconsistent balance/advance.`);
        console.log(`  - Old advance: ${invoice.advancePaid}, Old balance: ${invoice.balanceDue}`);
        
        invoice.advancePaid = targetAdvance;
        invoice.balanceDue = 0;
        modified = true;
        
        console.log(`  - New advance: ${invoice.advancePaid}, New balance: ${invoice.balanceDue}`);
      }
    }

    // 2. If balanceDue is 0 and status is not DRAFT/CANCELLED, status must be PAID
    if (invoice.balanceDue === 0 && invoice.status !== 'DRAFT' && invoice.status !== 'CANCELLED' && invoice.status !== 'PAID') {
      console.log(`[FIXING] Invoice ${invoice.invoiceNo} (${invoice.client?.name || 'Unknown'}): balanceDue is 0 but status is ${invoice.status}. Promoting to PAID.`);
      invoice.status = 'PAID';
      modified = true;
    }

    if (modified) {
      await invoice.save();
      
      // Also attempt to sync ledger if the sync function exists
      try {
        const { syncIncomeFromInvoice } = require('../services/invoiceIncomeSync');
        await syncIncomeFromInvoice(invoice);
        console.log(`  - Synchronized with Income ledger.`);
      } catch (e) {
        console.log(`  - Note: Ledger sync skipped or not available (${e.message})`);
      }
      
      fixCount++;
    }
  }

  console.log(`\nSelf-healing complete. Fixed ${fixCount} inconsistent invoices.`);
  await mongoose.disconnect();
  console.log('Disconnected from MongoDB.');
}

fixInconsistentInvoices().catch(err => {
  console.error('Error during self-healing migration:', err);
  process.exit(1);
});
