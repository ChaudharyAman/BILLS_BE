const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Category = require('../models/Category');
const Expense = require('../models/Expense');
const Income = require('../models/Income');
const { initializeDefaultsForUser } = require('../controllers/categoryController');

dotenv.config();

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;

async function ensureUncategorized(userId, type) {
  return Category.findOneAndUpdate(
    { user: userId, name: 'Uncategorized', type },
    {
      $setOnInsert: {
        user: userId,
        name: 'Uncategorized',
        type,
        isSystem: true,
        color: '#64748b',
        icon: 'FaQuestionCircle',
      },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );
}

async function migrate() {
  if (!mongoUri) {
    throw new Error('MONGO_URI or MONGODB_URI is required');
  }

  await mongoose.connect(mongoUri);
  const users = await mongoose.connection.db.collection('users').find({}).toArray();

  for (const user of users) {
    await initializeDefaultsForUser(user._id);

    const expenseCategory = await ensureUncategorized(user._id, 'expense');
    const incomeCategory = await ensureUncategorized(user._id, 'income');

    await Expense.updateMany(
      { user: user._id, $or: [{ category: { $exists: false } }, { category: null }] },
      { $set: { category: expenseCategory._id } }
    );

    await Income.updateMany(
      { user: user._id, $or: [{ category: { $exists: false } }, { category: null }] },
      { $set: { category: incomeCategory._id } }
    );
  }

  console.log(`Category migration completed for ${users.length} users`);
  await mongoose.disconnect();
}

migrate().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
