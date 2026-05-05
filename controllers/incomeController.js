const mongoose = require('mongoose');
const Income = require('../models/Income');
const User = require('../models/User');
const Category = require('../models/Category');
const escapeRegex = require('../utils/escapeRegex');

const validateIncomeCategory = async (userId, categoryId, subCategoryId) => {
  const result = { category: categoryId || null, subCategory: subCategoryId || null };

  if (categoryId) {
    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      const error = new Error('Invalid income category');
      error.statusCode = 400;
      throw error;
    }
    const category = await Category.findOne({ _id: categoryId, user: userId, type: 'income' });
    if (!category) {
      const error = new Error('Income category not found');
      error.statusCode = 400;
      throw error;
    }
  }

  if (subCategoryId) {
    if (!mongoose.Types.ObjectId.isValid(subCategoryId)) {
      const error = new Error('Invalid income sub-category');
      error.statusCode = 400;
      throw error;
    }
    const subCategory = await Category.findOne({ _id: subCategoryId, user: userId, type: 'income' });
    if (!subCategory) {
      const error = new Error('Income sub-category not found');
      error.statusCode = 400;
      throw error;
    }
    if (!subCategory.parent) {
      const error = new Error('Income sub-category requires a parent category');
      error.statusCode = 400;
      throw error;
    }

    if (categoryId) {
      if (String(subCategory.parent) !== String(categoryId)) {
        const error = new Error('Income sub-category does not belong to selected category');
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
        { incomeNumber: { $regex: safeSearch, $options: 'i' } },
        { 'vendor.vendorRef': { $in: matchedClients.map(c => c._id) } },
        { 'client.clientRef': { $in: matchedClients.map(c => c._id) } }
      ];
    }

    const total = await Income.countDocuments(query);
    const incomes = await Income.find(query)
      .select('-items -terms -privateNotes')
      .populate('category', 'name type color icon')
      .populate('subCategory', 'name type color icon parent')
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
      category,
      subCategory,
      project,
      department,
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

    const categoryData = await validateIncomeCategory(req.user._id, category, subCategory);

    // Check if incomeNumber exists for this user (if you want uniqueness per user)
    const existing = await Income.findOne({ incomeNumber, user: req.user._id });
    if (existing) {
      return res.status(400).json({ message: 'Income number already exists' });
    }

    const income = await Income.create({
      user: req.user._id,
      ...categoryData,
      project: project || null,
      department: department || null,
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
    res.status(error.statusCode || 500).json({ message: error.message || 'Server Error creating income' });
  }
};

// @desc    Get single income
// @route   GET /api/incomes/:id
// @access  Private
exports.getIncomeById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Income not found' });
    
    const income = await Income.findOne({ _id: req.params.id, user: req.user._id })
      .populate('category', 'name type color icon')
      .populate('subCategory', 'name type color icon parent');

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
      category,
      subCategory,
      project,
      department,
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
      category,
      subCategory,
      project,
      department,
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

    if (category !== undefined || subCategory !== undefined) {
      const categoryData = await validateIncomeCategory(
        req.user._id,
        category !== undefined ? category : income.category,
        subCategory !== undefined ? subCategory : income.subCategory
      );
      updateData.category = categoryData.category;
      updateData.subCategory = categoryData.subCategory;
    }

    // Remove undefined fields so we don't overwrite with nulls
    Object.keys(updateData).forEach(key => updateData[key] === undefined && delete updateData[key]);

    income = await Income.findByIdAndUpdate(
      req.params.id,
      { $set: updateData },
      { returnDocument: 'after', runValidators: true }
    )
      .populate('category', 'name type color icon')
      .populate('subCategory', 'name type color icon parent');

    res.json(income);
  } catch (error) {
    console.error('Error updating income', error);
    res.status(error.statusCode || 500).json({ message: error.message || 'Server Error updating income' });
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

    const income = await Income.findOne({ _id: req.params.id, user: req.user._id })
      .populate('category', 'name type color icon')
      .populate('subCategory', 'name type color icon parent');

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
