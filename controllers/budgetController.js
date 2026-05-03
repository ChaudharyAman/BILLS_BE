const mongoose = require('mongoose');
const Budget = require('../models/Budget');
const Category = require('../models/Category');
const Department = require('../models/Department');
const Expense = require('../models/Expense');

const validateOptionalRef = async (Model, id, userId, label) => {
  if (!id) return null;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const error = new Error(`Invalid ${label}`);
    error.statusCode = 400;
    throw error;
  }
  const doc = await Model.findOne({ _id: id, user: userId });
  if (!doc) {
    const error = new Error(`${label} not found`);
    error.statusCode = 400;
    throw error;
  }
  return doc._id;
};

const normalizeBudgetPayload = async (body, userId) => ({
  name: body.name,
  category: await validateOptionalRef(Category, body.category, userId, 'Category'),
  department: await validateOptionalRef(Department, body.department, userId, 'Department'),
  project: body.project || null,
  period: body.period,
  startDate: body.startDate,
  endDate: body.endDate,
  budgetAmount: Number(body.budgetAmount) || 0,
  alertThreshold: body.alertThreshold === undefined ? 80 : Number(body.alertThreshold),
  alertEnabled: body.alertEnabled === undefined ? true : Boolean(body.alertEnabled),
  notes: body.notes || '',
});

const refreshOneBudget = async (budget) => {
  if (!budget?.category) return budget;

  const result = await Expense.aggregate([
    {
      $match: {
        user: budget.user,
        category: budget.category,
        date: { $gte: budget.startDate, $lte: budget.endDate },
        status: { $ne: 'CANCELLED' },
      },
    },
    { $group: { _id: null, total: { $sum: '$grandTotal' } } },
  ]);

  const spentAmount = result[0]?.total || 0;
  budget.spentAmount = spentAmount;
  budget.remainingAmount = budget.budgetAmount - spentAmount;
  budget.status = spentAmount > budget.budgetAmount ? 'exceeded' : 'active';
  await budget.save();
  return budget;
};

exports.updateBudgetSpent = async (categoryId, userId) => {
  if (!categoryId || !mongoose.Types.ObjectId.isValid(String(categoryId))) return [];
  const budgets = await Budget.find({
    user: userId,
    category: categoryId,
    status: { $in: ['active', 'exceeded'] },
  });

  const refreshed = [];
  for (const budget of budgets) {
    refreshed.push(await refreshOneBudget(budget));
  }
  return refreshed;
};

exports.checkBudgetWarning = async (categoryId, userId, amount, excludeExpenseId = null) => {
  if (!categoryId || !mongoose.Types.ObjectId.isValid(String(categoryId))) return null;
  const now = new Date();
  const budgets = await Budget.find({
    user: userId,
    category: categoryId,
    startDate: { $lte: now },
    endDate: { $gte: now },
    status: { $in: ['active', 'exceeded'] },
  });

  for (const budget of budgets) {
    let spent = budget.spentAmount || 0;
    if (excludeExpenseId) {
      const existing = await Expense.findOne({ _id: excludeExpenseId, user: userId }).select('grandTotal category');
      if (existing && String(existing.category) === String(categoryId)) {
        spent -= Number(existing.grandTotal) || 0;
      }
    }
    const remainingAmount = budget.budgetAmount - spent;
    if (Number(amount) > remainingAmount) {
      return {
        budgetWarning: true,
        budgetId: budget._id,
        budgetName: budget.name,
        remainingAmount,
        exceededBy: Number(amount) - remainingAmount,
      };
    }
  }
  return null;
};

exports.getBudgets = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const skip = (page - 1) * limit;
    const query = { user: req.user._id };

    if (req.query.category) query.category = req.query.category;
    if (req.query.status) query.status = req.query.status;
    if (req.query.period) query.period = req.query.period;

    const total = await Budget.countDocuments(query);
    const budgets = await Budget.find(query)
      .populate('category', 'name type color icon')
      .populate('department', 'name code')
      .sort({ startDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({ data: budgets, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    console.error('Error fetching budgets:', error);
    res.status(500).json({ message: 'Server error fetching budgets' });
  }
};

exports.createBudget = async (req, res) => {
  try {
    const payload = await normalizeBudgetPayload(req.body, req.user._id);
    const budget = await Budget.create({ ...payload, user: req.user._id });
    await refreshOneBudget(budget);
    res.status(201).json(budget);
  } catch (error) {
    console.error('Error creating budget:', error);
    if (error.code === 11000) return res.status(400).json({ message: 'Budget already exists' });
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error creating budget' });
  }
};

exports.updateBudget = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Budget not found' });
    }

    const existing = await Budget.findOne({ _id: req.params.id, user: req.user._id });
    if (!existing) return res.status(404).json({ message: 'Budget not found' });

    const payload = await normalizeBudgetPayload({ ...existing.toObject(), ...req.body }, req.user._id);
    Object.assign(existing, payload);
    await refreshOneBudget(existing);
    const budget = await Budget.findById(existing._id)
      .populate('category', 'name type color icon')
      .populate('department', 'name code');
    res.json(budget);
  } catch (error) {
    console.error('Error updating budget:', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error updating budget' });
  }
};

exports.deleteBudget = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Budget not found' });
    }
    const budget = await Budget.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!budget) return res.status(404).json({ message: 'Budget not found' });
    res.json({ message: 'Budget deleted successfully' });
  } catch (error) {
    console.error('Error deleting budget:', error);
    res.status(500).json({ message: 'Server error deleting budget' });
  }
};

exports.getBudgetVsActual = async (req, res) => {
  try {
    const budgets = await Budget.find({ user: req.user._id, status: { $in: ['active', 'exceeded'] } })
      .populate('category', 'name type color icon')
      .populate('department', 'name code')
      .sort({ endDate: 1 });

    const data = [];
    for (const budget of budgets) {
      const refreshed = await refreshOneBudget(budget);
      const utilizationPct = refreshed.budgetAmount > 0
        ? Math.round((refreshed.spentAmount / refreshed.budgetAmount) * 100)
        : 0;
      data.push({
        _id: refreshed._id,
        name: refreshed.name,
        category: refreshed.category,
        department: refreshed.department,
        period: refreshed.period,
        startDate: refreshed.startDate,
        endDate: refreshed.endDate,
        budgetAmount: refreshed.budgetAmount,
        spentAmount: refreshed.spentAmount,
        remainingAmount: refreshed.remainingAmount,
        utilizationPct,
        status: refreshed.status,
      });
    }

    res.json({ data });
  } catch (error) {
    console.error('Error fetching budget vs actual:', error);
    res.status(500).json({ message: 'Server error fetching budget report' });
  }
};
