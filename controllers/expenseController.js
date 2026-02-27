const mongoose = require('mongoose');
const Expense = require('../models/Expense');

// @desc    Get all expenses
// @route   GET /api/expenses
// @access  Private
exports.getExpenses = async (req, res) => {
  try {
    const expenses = await Expense.find({ user: req.user._id }).sort({ date: -1, createdAt: -1 });
    res.json(expenses);
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
      terms,
      privateNotes
    } = req.body;

    // Check if expenseNumber exists for this user (if you want uniqueness per user)
    const existing = await Expense.findOne({ expenseNumber, user: req.user._id });
    if (existing) {
      return res.status(400).json({ message: 'Expense number already exists' });
    }

    const expense = await Expense.create({
      user: req.user._id,
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
      terms,
      privateNotes,
      status: 'PAID' // Auto default to paid for now
    });

    res.status(201).json(expense);
  } catch (error) {
    console.error('Error creating expense', error);
    res.status(500).json({ message: 'Server Error creating expense' });
  }
};

// @desc    Get single expense
// @route   GET /api/expenses/:id
// @access  Private
exports.getExpenseById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Expense not found' });
    
    const expense = await Expense.findOne({ _id: req.params.id, user: req.user._id });

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

    expense = await Expense.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true }
    );

    res.json(expense);
  } catch (error) {
    console.error('Error updating expense', error);
    res.status(500).json({ message: 'Server Error updating expense' });
  }
};

// @desc    Delete an expense
// @route   DELETE /api/expenses/:id
// @access  Private
exports.deleteExpense = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Expense not found' });

    const expense = await Expense.findOne({ _id: req.params.id, user: req.user._id });

    if (expense) {
      await expense.deleteOne();
      res.json({ message: 'Expense removed' });
    } else {
      res.status(404).json({ message: 'Expense not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server Error deleting expense' });
  }
};
