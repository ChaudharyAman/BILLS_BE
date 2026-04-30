const mongoose = require('mongoose');
const Income = require('../models/Income');
const User = require('../models/User');
const escapeRegex = require('../utils/escapeRegex');

// @desc    Get all incomes
// @route   GET /api/incomes
// @access  Private
exports.getIncomes = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    let query = { user: req.user._id };

    if (search) {
      const Client = require('../models/Client');
      const safeSearch = escapeRegex(search);
      const matchedClients = await Client.find({
        user: req.user._id,
        name: { $regex: safeSearch, $options: 'i' }
      }).select('_id').lean();

      query.$or = [
        { incomeNumber: { $regex: safeSearch, $options: 'i' } },
        { 'vendor.vendorRef': { $in: matchedClients.map(c => c._id) } },
        { 'client.clientRef': { $in: matchedClients.map(c => c._id) } }
      ];
    }

    const total = await Income.countDocuments(query);
    const incomes = await Income.find(query)
      .select('-items -terms -privateNotes')
      .lean()
      .sort({ date: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      data: incomes,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    res.status(500).json({ message: 'Server Error fetching incomes' });
  }
};

// @desc    Create new income
// @route   POST /api/incomes
// @access  Private
exports.createIncome = async (req, res) => {
  try {
    const {
      incomeNumber,
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

    // Check if incomeNumber exists for this user (if you want uniqueness per user)
    const existing = await Income.findOne({ incomeNumber, user: req.user._id });
    if (existing) {
      return res.status(400).json({ message: 'Income number already exists' });
    }

    const income = await Income.create({
      user: req.user._id,
      sourceType: 'manual',
      incomeNumber,
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

    res.status(201).json(income);
  } catch (error) {
    console.error('Error creating income', error);
    res.status(500).json({ message: 'Server Error creating income' });
  }
};

// @desc    Get single income
// @route   GET /api/incomes/:id
// @access  Private
exports.getIncomeById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Income not found' });
    
    const income = await Income.findOne({ _id: req.params.id, user: req.user._id });

    if (income) {
      res.json(income);
    } else {
      res.status(404).json({ message: 'Income not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server Error fetching individual income' });
  }
};

// @desc    Update an income
// @route   PUT /api/incomes/:id
// @access  Private
exports.updateIncome = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Income not found' });

    let income = await Income.findOne({ _id: req.params.id, user: req.user._id });
    if (!income) {
      return res.status(404).json({ message: 'Income not found' });
    }
    if (income.sourceType === 'invoice' && income.sourceInvoice) {
      return res.status(400).json({
        message: 'This income is synced from an invoice. Edit the original invoice instead.',
        sourceType: income.sourceType,
        sourceInvoice: income.sourceInvoice,
      });
    }

    // --- Subscription Plan Check for Edits ---
    const userObj = await User.findById(req.user._id);
    const plan = userObj?.subscription?.plan || 'free';
    if (plan === 'free') {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const editedIncomesCount = await Income.countDocuments({
        user: req.user._id,
        updatedAt: { $gte: startOfMonth },
        $expr: { $gt: ["$updatedAt", "$createdAt"] }
      });
      const isAlreadyEdited = income.updatedAt && income.updatedAt >= startOfMonth && income.updatedAt > income.createdAt;
      if (editedIncomesCount >= 5 && !isAlreadyEdited) {
        return res.status(403).json({ message: 'You have reached the free plan limit of 5 document edits per month. Please upgrade to Pro.' });
      }
    }
    // -----------------------------------------

    const {
      incomeNumber,
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
      status
    } = req.body;

    const updateData = {
      incomeNumber,
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
      status
    };

    // Remove undefined fields so we don't overwrite with nulls
    Object.keys(updateData).forEach(key => updateData[key] === undefined && delete updateData[key]);

    income = await Income.findByIdAndUpdate(
      req.params.id,
      { $set: updateData },
      { returnDocument: 'after', runValidators: true }
    );

    res.json(income);
  } catch (error) {
    console.error('Error updating income', error);
    res.status(500).json({ message: 'Server Error updating income' });
  }
};

// @desc    Delete an income
// @route   DELETE /api/incomes/:id
// @access  Private
exports.deleteIncome = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Income not found' });

    // --- Subscription Plan Check for Deletes ---
    const userObj = await User.findById(req.user._id);
    const plan = userObj?.subscription?.plan || 'free';
    if (plan === 'free') {
      return res.status(403).json({ message: 'Free users cannot delete documents. Please upgrade to Pro.' });
    }
    // -------------------------------------------

    const income = await Income.findOne({ _id: req.params.id, user: req.user._id });

    if (income) {
      if (income.sourceType === 'invoice' && income.sourceInvoice) {
        return res.status(400).json({
          message: 'This income is synced from an invoice. Delete the original invoice instead.',
          sourceType: income.sourceType,
          sourceInvoice: income.sourceInvoice,
        });
      }
      await income.deleteOne();
      res.json({ message: 'Income removed' });
    } else {
      res.status(404).json({ message: 'Income not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server Error deleting income' });
  }
};
