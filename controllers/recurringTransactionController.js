const mongoose = require('mongoose');
const RecurringTransaction = require('../models/RecurringTransaction');
const Category = require('../models/Category');
const {
  initialNextProcessDate,
  processDueRecurringTransactions,
} = require('../services/recurringTransactionScheduler');

const validateCategory = async (userId, type, categoryId) => {
  if (!mongoose.Types.ObjectId.isValid(categoryId)) {
    const error = new Error('Invalid category');
    error.statusCode = 400;
    throw error;
  }
  const category = await Category.findOne({ _id: categoryId, user: userId, type });
  if (!category) {
    const error = new Error('Category not found for recurring transaction type');
    error.statusCode = 400;
    throw error;
  }
  return category._id;
};

const sanitizeObject = (source, allowedKeys = []) => {
  if (!source || typeof source !== 'object') return {};
  const target = Object.create(null);
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      target[key] = source[key];
    }
  }
  return target;
};

const buildPayload = async (body, userId) => {
  const category = await validateCategory(userId, body.type, body.category);
  const allowedVendorKeys = ['name', 'vendorRef', 'email', 'phone', 'address'];
  const allowedClientKeys = ['name', 'clientRef', 'email', 'phone', 'address'];

  return {
    type: body.type,
    category,
    subCategory: body.subCategory || null,
    name: body.name,
    amount: Number(body.amount) || 0,
    description: body.description || '',
    paymentMethod: body.paymentMethod || '',
    vendor: sanitizeObject(body.vendor, allowedVendorKeys),
    client: sanitizeObject(body.client, allowedClientKeys),
    frequency: body.frequency,
    startDate: body.startDate,
    endDate: body.endDate || null,
    dayOfMonth: body.dayOfMonth || undefined,
    dayOfWeek: body.dayOfWeek === '' || body.dayOfWeek === undefined ? undefined : Number(body.dayOfWeek),
    autoCreate: body.autoCreate === undefined ? true : Boolean(body.autoCreate),
    notifyBeforeCreation: Boolean(body.notifyBeforeCreation),
    notifyDaysBefore: body.notifyDaysBefore === undefined || body.notifyDaysBefore === null
      ? 3
      : Number(body.notifyDaysBefore),
  };
};

exports.createRecurringTransaction = async (req, res) => {
  try {
    const payload = await buildPayload(req.body, req.user._id);
    const rt = new RecurringTransaction({ ...payload, user: req.user._id });
    rt.nextProcessDate = initialNextProcessDate(rt);
    await rt.save();
    res.status(201).json(rt);
  } catch (error) {
    console.error('Error creating recurring transaction:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error creating recurring transaction' });
  }
};

exports.getRecurringTransactions = async (req, res) => {
  try {
    const parsedPage = Number.parseInt(req.query.page, 10);
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const page = Number.isInteger(parsedPage) ? Math.max(1, parsedPage) : 1;
    const limit = Number.isInteger(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 100)) : 20;
    const skip = (page - 1) * limit;
    const query = { user: req.user._id };
    if (req.query.type) query.type = req.query.type;
    if (req.query.isActive !== undefined) query.isActive = req.query.isActive === 'true';

    const total = await RecurringTransaction.countDocuments(query);
    const data = await RecurringTransaction.find(query)
      .populate('category', 'name type color icon')
      .populate('subCategory', 'name type color icon')
      .sort({ nextProcessDate: 1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({ data, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    console.error('Error fetching recurring transactions:', error);
    res.status(500).json({ message: 'Server error fetching recurring transactions' });
  }
};

exports.updateRecurringTransaction = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Recurring transaction not found' });
    const existing = await RecurringTransaction.findOne({ _id: req.params.id, user: req.user._id });
    if (!existing) return res.status(404).json({ message: 'Recurring transaction not found' });

    const payload = await buildPayload({ ...existing.toObject(), ...req.body }, req.user._id);
    Object.assign(existing, payload);
    existing.nextProcessDate = initialNextProcessDate(existing);
    await existing.save();
    res.json(existing);
  } catch (error) {
    console.error('Error updating recurring transaction:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error updating recurring transaction' });
  }
};

exports.deleteRecurringTransaction = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Recurring transaction not found' });
    const rt = await RecurringTransaction.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!rt) return res.status(404).json({ message: 'Recurring transaction not found' });
    res.json({ message: 'Recurring transaction deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error deleting recurring transaction' });
  }
};

exports.pauseRecurringTransaction = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Recurring transaction not found' });
    const rt = await RecurringTransaction.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: { isActive: false } },
      { new: true }
    );
    if (!rt) return res.status(404).json({ message: 'Recurring transaction not found' });
    res.json(rt);
  } catch (error) {
    res.status(500).json({ message: 'Server error pausing recurring transaction' });
  }
};

exports.resumeRecurringTransaction = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Recurring transaction not found' });
    const rt = await RecurringTransaction.findOne({ _id: req.params.id, user: req.user._id });
    if (!rt) return res.status(404).json({ message: 'Recurring transaction not found' });
    rt.isActive = true;
    rt.nextProcessDate = initialNextProcessDate(rt);
    await rt.save();
    res.json(rt);
  } catch (error) {
    res.status(500).json({ message: 'Server error resuming recurring transaction' });
  }
};

exports.processRecurringTransactions = async (req, res) => {
  try {
    const results = await processDueRecurringTransactions();
    res.json({ results });
  } catch (error) {
    console.error('Manual recurring processing failed:', error);
    res.status(500).json({ message: 'Server error processing recurring transactions' });
  }
};
