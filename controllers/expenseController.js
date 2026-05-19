const mongoose = require('mongoose');
const Expense = require('../models/Expense');
const User = require('../models/User');
const Category = require('../models/Category');
const escapeRegex = require('../utils/escapeRegex');
const { updateBudgetSpent, checkBudgetWarning } = require('./budgetController');

const validateExpenseCategory = async (userId, categoryId, subCategoryId) => {
  const result = { category: categoryId || null, subCategory: subCategoryId || null };

  if (categoryId) {
    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      const error = new Error('Invalid expense category');
      error.statusCode = 400;
      throw error;
    }
    const category = await Category.findOne({ _id: categoryId, user: userId, type: 'expense' });
    if (!category) {
      const error = new Error('Expense category not found');
      error.statusCode = 400;
      throw error;
    }
  }

  if (subCategoryId) {
    if (!mongoose.Types.ObjectId.isValid(subCategoryId)) {
      const error = new Error('Invalid expense sub-category');
      error.statusCode = 400;
      throw error;
    }
    const subCategory = await Category.findOne({ _id: subCategoryId, user: userId, type: 'expense' });
    if (!subCategory) {
      const error = new Error('Expense sub-category not found');
      error.statusCode = 400;
      throw error;
    }
    if (!subCategory.parent) {
      const error = new Error('Expense sub-category requires a parent category');
      error.statusCode = 400;
      throw error;
    }

    if (categoryId) {
      if (String(subCategory.parent) !== String(categoryId)) {
        const error = new Error('Expense sub-category does not belong to selected category');
        error.statusCode = 400;
        throw error;
      }
    } else {
      result.category = subCategory.parent;
    }

    result.subCategory = subCategory._id;
  }

  return result;
};

const resolvePaymentState = (grandTotal, amountPaid, requestedStatus) => {
  const total = Number(grandTotal) || 0;

  if (requestedStatus === 'CANCELLED' || requestedStatus === 'DRAFT') {
    return {
      amountPaid: Number(amountPaid) || 0,
      balanceDue: Math.max(total - (Number(amountPaid) || 0), 0),
      status: requestedStatus,
    };
  }

  if (requestedStatus === 'PAID') {
    return { amountPaid: total, balanceDue: 0, status: 'PAID' };
  }

  const paid = Math.min(Math.max(Number(amountPaid) || 0, 0), total);
  const balanceDue = Math.max(total - paid, 0);
  let status = 'UNPAID';

  if (total <= 0 || balanceDue === 0) status = 'PAID';
  else if (paid > 0) status = 'PARTIAL';

  return { amountPaid: paid, balanceDue, status };
};

// @desc    Get all expenses
// @route   GET /api/expenses
// @access  Private
exports.getExpenses = async (req, res) => {
  try {
    const exportAll = req.query.all === 'true';
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    let query = { user: req.user._id };
    if (req.query.category) query.category = req.query.category;
    if (req.query.subCategory) query.subCategory = req.query.subCategory;
    if (req.query.project) query.project = req.query.project;

    if (search) {
      const Client = require('../models/Client');
      const safeSearch = escapeRegex(search);
      const matchedClients = await Client.find({
        user: req.user._id,
        name: { $regex: safeSearch, $options: 'i' }
      }).select('_id').lean();

      query.$or = [
        { expenseNumber: { $regex: safeSearch, $options: 'i' } },
        { 'vendor.vendorRef': { $in: matchedClients.map(c => c._id) } },
        { 'client.clientRef': { $in: matchedClients.map(c => c._id) } }
      ];
    }

    const total = await Expense.countDocuments(query);
    const expensesQuery = Expense.find(query)
      .select('-items -terms -privateNotes')
      .populate('category', 'name type color icon')
      .populate('subCategory', 'name type color icon parent')
      .lean()
      .sort({ date: -1, createdAt: -1 });

    if (!exportAll) {
      expensesQuery.skip(skip).limit(limit);
    }

    const expenses = await expensesQuery;

    res.json({
      data: expenses,
      total,
      page: exportAll ? 1 : page,
      limit: exportAll ? total : limit,
      totalPages: exportAll ? 1 : Math.ceil(total / limit)
    });
  } catch (error) {
    res.status(500).json({ message: 'Server Error fetching expenses' });
  }
};

// @desc    Create new expense
// @route   POST /api/expenses
// @access  Private
exports.createExpense = async (req, res) => {
  try {
    const {
      category,
      subCategory,
      project,
      department,
      expenseNumber,
      date,
      vendor,
      client,
      paymentMethod,
      reverseCharge,
      items,
      subTotal,
      taxTotal,
      grandTotal,
      amountPaid,
      dueDate,
      status,
      terms,
      privateNotes
    } = req.body;

    const categoryData = await validateExpenseCategory(req.user._id, category, subCategory);

    // Check if expenseNumber exists for this user (if you want uniqueness per user)
    const existing = await Expense.findOne({ expenseNumber, user: req.user._id });
    if (existing) {
      return res.status(400).json({ message: 'Expense number already exists' });
    }

    const budgetWarning = await checkBudgetWarning(categoryData.category, req.user._id, grandTotal);
    const paymentState = resolvePaymentState(grandTotal, amountPaid, status);

    const expense = await Expense.create({
      user: req.user._id,
      ...categoryData,
      project: project || null,
      department: department || null,
      expenseNumber,
      date,
      vendor,
      client,
      paymentMethod,
      reverseCharge,
      items,
      subTotal,
      taxTotal,
      grandTotal,
      amountPaid: paymentState.amountPaid,
      balanceDue: paymentState.balanceDue,
      dueDate,
      terms,
      privateNotes,
      status: paymentState.status
    });

    if (expense.category) await updateBudgetSpent(expense.category, req.user._id);

    res.status(201).json(budgetWarning ? { data: expense, budgetWarning } : expense);
  } catch (error) {
    console.error('Error creating expense', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Server Error creating expense' });
  }
};

// @desc    Get single expense
// @route   GET /api/expenses/:id
// @access  Private
exports.getExpenseById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Expense not found' });
    
    const expense = await Expense.findOne({ _id: req.params.id, user: req.user._id })
      .populate('category', 'name type color icon')
      .populate('subCategory', 'name type color icon parent');

    if (expense) {
      res.json(expense);
    } else {
      res.status(404).json({ message: 'Expense not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server Error fetching individual expense' });
  }
};

// @desc    Update an expense
// @route   PUT /api/expenses/:id
// @access  Private
exports.updateExpense = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Expense not found' });

    let expense = await Expense.findOne({ _id: req.params.id, user: req.user._id });
    if (!expense) {
      return res.status(404).json({ message: 'Expense not found' });
    }
    const oldCategory = expense.category;

    // --- Subscription Plan Check for Edits ---
    const userObj = await User.findById(req.user._id);
    const plan = userObj?.subscription?.plan || 'free';
    if (plan === 'free') {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const editedExpensesCount = await Expense.countDocuments({
        user: req.user._id,
        updatedAt: { $gte: startOfMonth },
        $expr: { $gt: ["$updatedAt", "$createdAt"] }
      });
      const isAlreadyEdited = expense.updatedAt && expense.updatedAt >= startOfMonth && expense.updatedAt > expense.createdAt;
      if (editedExpensesCount >= 5 && !isAlreadyEdited) {
        return res.status(403).json({ message: 'You have reached the free plan limit of 5 document edits per month. Please upgrade to Pro.' });
      }
    }
    // -----------------------------------------

    const {
      category,
      subCategory,
      project,
      department,
      expenseNumber,
      date,
      vendor,
      client,
      paymentMethod,
      reverseCharge,
      items,
      subTotal,
      taxTotal,
      grandTotal,
      amountPaid,
      dueDate,
      terms,
      privateNotes,
      status
    } = req.body;

    const paymentState = grandTotal !== undefined || amountPaid !== undefined || status !== undefined
      ? resolvePaymentState(
          grandTotal !== undefined ? grandTotal : expense.grandTotal,
          amountPaid !== undefined ? amountPaid : expense.amountPaid,
          status !== undefined ? status : expense.status
        )
      : {};

    const updateData = {
      category,
      subCategory,
      project,
      department,
      expenseNumber,
      date,
      vendor,
      client,
      paymentMethod,
      reverseCharge,
      items,
      subTotal,
      taxTotal,
      grandTotal,
      amountPaid: paymentState.amountPaid,
      balanceDue: paymentState.balanceDue,
      dueDate,
      terms,
      privateNotes,
      status: paymentState.status
    };

    if (category !== undefined || subCategory !== undefined) {
      const categoryData = await validateExpenseCategory(
        req.user._id,
        category !== undefined ? category : expense.category,
        subCategory !== undefined ? subCategory : expense.subCategory
      );
      updateData.category = categoryData.category;
      updateData.subCategory = categoryData.subCategory;
    }

    // Remove undefined fields so we don't overwrite with nulls
    Object.keys(updateData).forEach(key => updateData[key] === undefined && delete updateData[key]);

    expense = await Expense.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: updateData },
      { returnDocument: 'after', runValidators: true }
    )
      .populate('category', 'name type color icon')
      .populate('subCategory', 'name type color icon parent');

    if (oldCategory) await updateBudgetSpent(oldCategory, req.user._id);
    if (expense.category && String(expense.category._id || expense.category) !== String(oldCategory || '')) {
      await updateBudgetSpent(expense.category._id || expense.category, req.user._id);
    }

    res.json(expense);
  } catch (error) {
    console.error('Error updating expense', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Server Error updating expense' });
  }
};

// @desc    Delete an expense
// @route   DELETE /api/expenses/:id
// @access  Private
exports.deleteExpense = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Expense not found' });

    // --- Subscription Plan Check for Deletes ---
    const userObj = await User.findById(req.user._id);
    const plan = userObj?.subscription?.plan || 'free';
    if (plan === 'free') {
      return res.status(403).json({ message: 'Free users cannot delete documents. Please upgrade to Pro.' });
    }
    // -------------------------------------------

    const expense = await Expense.findOne({ _id: req.params.id, user: req.user._id });

    if (expense) {
      const oldCategory = expense.category;
      await expense.deleteOne();
      if (oldCategory) await updateBudgetSpent(oldCategory, req.user._id);
      res.json({ message: 'Expense removed' });
    } else {
      res.status(404).json({ message: 'Expense not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server Error deleting expense' });
  }
};
