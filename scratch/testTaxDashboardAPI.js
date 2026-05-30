const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const User = require('../models/User');
const { getTaxDashboard } = require('../controllers/reports/taxDashboardController');

async function run() {
  const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mybill';
  await mongoose.connect(mongoUri);

  const user = await User.findOne({ username: 'aman' });
  const req = {
    user: user,
    query: {
      startDate: '2014-02-14',
      endDate: '2026-05-30'
    }
  };

  const res = {
    json: (data) => {
      console.log('\n--- TAX DASHBOARD RESPONSE FOR FEB 2014 - MAY 2026 ---');
      console.log('Period:', data.period);
      console.log('Summary Total Invoices:', data.summary.totalInvoices);
      console.log('Summary Output Liability (taxTotal sum):', data.summary.outputLiability);
      console.log('Summary Input Credit:', data.summary.inputCredit);
      console.log('Summary Net Payable:', data.summary.netPayable);
      console.log('Invoice Split:', data.invoiceSplit);
      console.log('Slab Comparison:', data.slabComparison);
      console.log('Slab Output Sum:', data.slabComparison.reduce((t, s) => t + s.output, 0));
    },
    status: (code) => {
      console.log('Status code:', code);
      return res;
    }
  };

  await getTaxDashboard(req, res);
  await mongoose.disconnect();
}

run().catch(console.error);
