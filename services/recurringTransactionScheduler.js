const cron = require('node-cron');
const RecurringTransaction = require('../models/RecurringTransaction');
const Income = require('../models/Income');
const Expense = require('../models/Expense');

const startOfDay = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};

const addMonthsClamped = (date, months, dayOfMonth) => {
  const next = new Date(date);
  const day = dayOfMonth || next.getDate();
  next.setMonth(next.getMonth() + months, 1);
  const last = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, last));
  return startOfDay(next);
};

const computeNextProcessDate = (transaction, fromDate = transaction.startDate) => {
  const base = startOfDay(fromDate);
  let next;

  switch (transaction.frequency) {
    case 'daily':
      next = new Date(base);
      next.setDate(next.getDate() + 1);
      break;
    case 'weekly': {
      next = new Date(base);
      const target = Number.isInteger(transaction.dayOfWeek) ? transaction.dayOfWeek : next.getDay();
      const diff = (target - next.getDay() + 7) || 7;
      next.setDate(next.getDate() + diff);
      break;
    }
    case 'monthly':
      next = addMonthsClamped(base, 1, transaction.dayOfMonth);
      break;
    case 'quarterly':
      next = addMonthsClamped(base, 3, transaction.dayOfMonth);
      break;
    case 'yearly':
      next = addMonthsClamped(base, 12, transaction.dayOfMonth);
      break;
    default:
      next = base;
  }

  return startOfDay(next);
};

const initialNextProcessDate = (transaction) => {
  const start = startOfDay(transaction.startDate);
  const today = startOfDay();
  if (start >= today) return start;

  let next = start;
  let guard = 0;
  while (next < today && guard < 1000) {
    next = computeNextProcessDate(transaction, next);
    guard += 1;
  }
  return next;
};

const createTransactionDocument = async (rt, processDate = new Date()) => {
  const numberDate = processDate.toISOString().substring(0, 10).replace(/-/g, '');
  const baseNumber = `RT-${rt.type === 'income' ? 'INC' : 'EXP'}-${numberDate}-${String(rt._id).slice(-6)}`;
  const payload = {
    user: rt.user,
    category: rt.category,
    subCategory: rt.subCategory || null,
    date: processDate,
    vendor: rt.vendor,
    client: rt.client,
    paymentMethod: rt.paymentMethod,
    items: [{
      name: rt.name,
      description: rt.description,
      qty: 1,
      rate: rt.amount,
      taxRate: 0,
      taxAmount: 0,
      amount: rt.amount,
    }],
    subTotal: rt.amount,
    taxTotal: 0,
    grandTotal: rt.amount,
    privateNotes: `Recurring transaction ID: ${rt._id}`,
    status: 'PAID',
  };

  if (rt.type === 'income') {
    return Income.create({ ...payload, incomeNumber: baseNumber, sourceType: 'manual' });
  }
  return Expense.create({ ...payload, expenseNumber: baseNumber });
};

const processDueRecurringTransactions = async (asOf = new Date()) => {
  const today = startOfDay(asOf);
  const due = await RecurringTransaction.find({
    isActive: true,
    autoCreate: true,
    nextProcessDate: { $lte: today },
  });

  const results = [];
  for (const rt of due) {
    try {
      await createTransactionDocument(rt, today);
      rt.lastProcessedDate = today;
      const next = computeNextProcessDate(rt, today);
      if (rt.endDate && next > startOfDay(rt.endDate)) {
        rt.isActive = false;
        rt.nextProcessDate = null;
      } else {
        rt.nextProcessDate = next;
      }
      await rt.save();
      results.push({ id: rt._id, status: 'processed' });
    } catch (error) {
      results.push({ id: rt._id, status: 'error', error: error.message });
    }
  }
  return results;
};

function startScheduler() {
  cron.schedule('0 1 * * *', () => {
    processDueRecurringTransactions().catch((error) => {
      console.error('Recurring transaction scheduler failed:', error);
    });
  });
}

module.exports = {
  startScheduler,
  computeNextProcessDate,
  initialNextProcessDate,
  processDueRecurringTransactions,
};
