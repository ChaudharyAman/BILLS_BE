const mongoose = require('mongoose');
const Expense = require('../models/Expense');

// @desc    Get all expenses
// @route   GET /api/expenses
// @access  Private
exports.getExpenses = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    let query = { user: req.user._id };

    if (search) {
      const Client = require('../models/Client');
      const matchedClients = await Client.find({
        user: req.user._id,
        name: { $regex: search, $options: 'i' }
      }).select('_id').lean();

      query.$or = [
        { expenseNumber: { $regex: search, $options: 'i' } },
        { vendor: { $in: matchedClients.map(c => c._id) } },
        { client: { $in: matchedClients.map(c => c._id) } }
      ];
    }

    const total = await Expense.countDocuments(query);
    const expenses = await Expense.find(query)
      .populate('vendor', 'name email phone')
      .populate('client', 'name email phone')
      .select('-items -terms -privateNotes')
      .lean()
      .sort({ date: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      data: expenses,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
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
