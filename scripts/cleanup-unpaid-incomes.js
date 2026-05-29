const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const Income = require('../models/Income');
const Invoice = require('../models/Invoice');

async function cleanupUnpaidIncomes() {
  const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mybill';
  console.log(`Connecting to MongoDB at: ${mongoUri}`);
  
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB successfully.');

  // Find all synced income records
  const syncedIncomes = await Income.find({ sourceType: 'invoice' });
  console.log(`Found ${syncedIncomes.length} synced income records in the database.`);

  let deletedCount = 0;

  for (const income of syncedIncomes) {
    if (!income.sourceInvoice) {
      console.log(`[REMOVING] Synced income ${income.incomeNumber} has no sourceInvoice ID.`);
      await income.deleteOne();
      deletedCount++;
      continue;
    }

    const invoice = await Invoice.findById(income.sourceInvoice);
    if (!invoice) {
      console.log(`[REMOVING] Synced income ${income.incomeNumber} refers to non-existent Invoice.`);
      await income.deleteOne();
      deletedCount++;
      continue;
    }

    const isFullyPaid = invoice.status === 'PAID' || Number(invoice.balanceDue) <= 0;
    if (!isFullyPaid) {
      console.log(`[REMOVING] Synced income ${income.incomeNumber} from Invoice ${invoice.invoiceNo} (status: ${invoice.status}, balanceDue: ${invoice.balanceDue}) because it is not fully paid.`);
      await income.deleteOne();
      deletedCount++;
    }
  }

  console.log(`\nCleanup complete. Removed ${deletedCount} unpaid/invalid synced incomes from the database.`);
  await mongoose.disconnect();
  console.log('Disconnected from MongoDB.');
}

cleanupUnpaidIncomes().catch(err => {
  console.error('Error during cleanup:', err);
  process.exit(1);
});
