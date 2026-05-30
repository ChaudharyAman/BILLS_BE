const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const Expense = require('../models/Expense');
const User = require('../models/User');

async function run() {
  const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mybill';
  await mongoose.connect(mongoUri);

  const user = await User.findOne({ username: 'aman' });
  if (!user) {
    console.log('User aman not found!');
    await mongoose.disconnect();
    return;
  }
  const userId = user._id;

  const activeExpenses = await Expense.find({
    user: userId,
    status: { $nin: ['DRAFT', 'CANCELLED'] }
  }).lean();

  activeExpenses.forEach(exp => {
    console.log(`\nExpense: ${exp.expenseNumber}`);
    console.log(`  Date: ${exp.date}`);
    console.log(`  TaxTotal: ${exp.taxTotal}`);
    console.log(`  GrandTotal: ${exp.grandTotal}`);
    console.log(`  Items count: ${exp.items?.length}`);
    console.log('  Items Raw:', JSON.stringify(exp.items, null, 2));
  });

  await mongoose.disconnect();
}

run().catch(console.error);
