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

// Strip empty-string itemRef so Mongoose doesn't try to cast "" to ObjectId
const sanitizeItems = (items = []) =>
  items.map((item) => ({
    ...item,
    itemRef: item.itemRef && String(item.itemRef).trim() ? item.itemRef : undefined,
  }));

const resolvePaymentState = (grandTotal, amountPaid, requestedStatus, reverseCharge = false, taxTotal = 0, tdsAmount = 0) => {
  const total = Number(grandTotal) || 0;
  const tax = Number(taxTotal) || 0;
  const tds = Number(tdsAmount) || 0;
  const basePayable = reverseCharge ? Math.max(total - tax, 0) : total;
  const payableAmount = Math.max(basePayable - tds, 0);

  let paid = Number(amountPaid) || 0;

  if (requestedStatus === 'CANCELLED' || requestedStatus === 'DRAFT') {
    const safePaid = Math.min(Math.max(paid, 0), payableAmount);
    return {
      amountPaid: safePaid,
      balanceDue: Math.max(payableAmount - safePaid, 0),
      status: requestedStatus,
    };
  }

  if (requestedStatus === 'PAID') {
    return {
      amountPaid: payableAmount,
      balanceDue: 0,
      status: 'PAID',
    };
  }

  if (requestedStatus === 'UNPAID') {
    return {
      amountPaid: 0,
      balanceDue: payableAmount,
      status: 'UNPAID',
    };
  }

  if (requestedStatus === 'PARTIAL') {
    let partialPaid = paid;
    if (partialPaid <= 0 || partialPaid >= payableAmount) {
      partialPaid = Math.round((payableAmount / 2) * 100) / 100;
    }
    return {
      amountPaid: partialPaid,
      balanceDue: Math.max(payableAmount - partialPaid, 0),
      status: 'PARTIAL',
    };
  }

  paid = Math.min(Math.max(paid, 0), payableAmount);
  const balanceDue = Math.max(payableAmount - paid, 0);
  let status = 'UNPAID';

  if (payableAmount <= 0 || balanceDue === 0) status = 'PAID';
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
    if (req.query.excludeCategoryName) {
      const Category = require('../models/Category');
      const excludeCategory = await Category.findOne({
        user: req.user._id,
        name: req.query.excludeCategoryName,
        type: 'expense'
      });
      if (excludeCategory) {
        if (query.category) {
          if (String(query.category) === String(excludeCategory._id)) {
            query.category = null;
          }
        } else {
          query.category = { $ne: excludeCategory._id };
        }
      }
    }
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

// --- Resolve or auto-create vendor/client from name/ref ---
async function resolveParty({
  userId,
  partyRef,
  partyName,
  isVendor,
  isClient,
  partyGST,
  partyAddressObject,
  partyPhone,
  partyEmail,
  partyPAN,
  placeOfSupply,
}) {
  const ClientModel = require('../models/Client');

  if (partyRef && mongoose.Types.ObjectId.isValid(partyRef)) {
    const party = await ClientModel.findOne({ _id: partyRef, user: userId });
    if (!party) throw new Error(`${isVendor ? 'Vendor' : 'Client'} not found`);

    let needsUpdate = false;
    if (isVendor && !party.isVendor) {
      party.isVendor = true;
      needsUpdate = true;
    }
    if (isClient && !party.isClient) {
      party.isClient = true;
      needsUpdate = true;
    }
    if (!party.gstin && partyGST) {
      party.gstin = String(partyGST).trim().toUpperCase();
      party.gstTreatment = 'Registered Business';
      needsUpdate = true;
    }
    if (!party.phone && partyPhone) {
      party.phone = String(partyPhone).trim();
      needsUpdate = true;
    }
    if (!party.email && partyEmail) {
      party.email = String(partyEmail).trim().toLowerCase();
      needsUpdate = true;
    }
    if (!party.pan && partyPAN) {
      party.pan = String(partyPAN).trim().toUpperCase();
      needsUpdate = true;
    }
    if (partyAddressObject && (!party.billingAddress || !party.billingAddress.line1)) {
      party.billingAddress = {
        line1: partyAddressObject.line1 || party.billingAddress?.line1 || '',
        line2: partyAddressObject.line2 || party.billingAddress?.line2 || '',
        city: partyAddressObject.city || party.billingAddress?.city || '',
        state: partyAddressObject.state || placeOfSupply || party.billingAddress?.state || '',
        zip: partyAddressObject.zip || party.billingAddress?.zip || '',
        country: partyAddressObject.country || party.billingAddress?.country || 'India',
      };
      if (partyAddressObject.state || placeOfSupply) {
        party.placeOfSupply = partyAddressObject.state || placeOfSupply;
      }
      needsUpdate = true;
    }
    if (needsUpdate) {
      await party.save();
    }

    return party;
  }

  const name = String(partyName || '').trim();
  const gstinClean = partyGST ? String(partyGST).trim().toUpperCase() : null;
  const panClean = partyPAN ? String(partyPAN).trim().toUpperCase() : null;

  if (!name && !gstinClean && !panClean) return null;

  let existing = null;
  if (gstinClean) {
    existing = await ClientModel.findOne({ user: userId, gstin: gstinClean });
  }
  if (!existing && panClean) {
    existing = await ClientModel.findOne({ user: userId, pan: panClean });
  }
  if (!existing && name) {
    const escaped = escapeRegex(name).replace(/\s+/g, '\\s+');
    const exactRegex = new RegExp(`^\\s*${escaped}\\s*$`, 'i');
    existing = await ClientModel.findOne({ user: userId, name: { $regex: exactRegex } });

    if (!existing) {
      const cleanCore = name.replace(/\b(Pvt|Ltd|Private|Limited|Inc|LLP|Co|Corporation|Corp)\b\.?/gi, '').replace(/[^a-zA-Z0-9\s]/g, '').trim();
      if (cleanCore && cleanCore.length > 2) {
        const coreEscaped = escapeRegex(cleanCore).replace(/\s+/g, '\\s+');
        const flexRegex = new RegExp(`^\\s*${coreEscaped}`, 'i');
        existing = await ClientModel.findOne({ user: userId, name: { $regex: flexRegex } });
      }
    }
  }

  if (existing) {
    let needsUpdate = false;
    if (isVendor && !existing.isVendor) {
      existing.isVendor = true;
      needsUpdate = true;
    }
    if (isClient && !existing.isClient) {
      existing.isClient = true;
      needsUpdate = true;
    }
    if (!existing.gstin && partyGST) {
      existing.gstin = String(partyGST).trim().toUpperCase();
      existing.gstTreatment = 'Registered Business';
      needsUpdate = true;
    }
    if (!existing.phone && partyPhone) {
      existing.phone = String(partyPhone).trim();
      needsUpdate = true;
    }
    if (!existing.email && partyEmail) {
      existing.email = String(partyEmail).trim().toLowerCase();
      needsUpdate = true;
    }
    if (!existing.pan && partyPAN) {
      existing.pan = String(partyPAN).trim().toUpperCase();
      needsUpdate = true;
    }
    if (partyAddressObject && (!existing.billingAddress || !existing.billingAddress.line1)) {
      existing.billingAddress = {
        line1: partyAddressObject.line1 || existing.billingAddress?.line1 || '',
        line2: partyAddressObject.line2 || existing.billingAddress?.line2 || '',
        city: partyAddressObject.city || existing.billingAddress?.city || '',
        state: partyAddressObject.state || placeOfSupply || existing.billingAddress?.state || '',
        zip: partyAddressObject.zip || existing.billingAddress?.zip || '',
        country: partyAddressObject.country || existing.billingAddress?.country || 'India',
      };
      if (partyAddressObject.state || placeOfSupply) {
        existing.placeOfSupply = partyAddressObject.state || placeOfSupply;
      }
      needsUpdate = true;
    }
    if (needsUpdate) {
      await existing.save();
    }
    return existing;
  }

  const gstin = String(partyGST || '').trim().toUpperCase();
  const state = String(partyAddressObject?.state || placeOfSupply || '').trim();
  const party = new ClientModel({
    user: userId,
    name,
    isVendor: !!isVendor,
    isClient: !!isClient,
    gstin: gstin || undefined,
    gstTreatment: gstin ? 'Registered Business' : 'Unregistered Business',
    placeOfSupply: state || 'Delhi',
    billingAddress: {
      line1: partyAddressObject?.line1 || '',
      line2: partyAddressObject?.line2 || '',
      city: partyAddressObject?.city || '',
      state: state || '',
      zip: partyAddressObject?.zip || '',
      country: partyAddressObject?.country || 'India',
    },
    shippingAddress: {
      line1: partyAddressObject?.line1 || '',
      line2: partyAddressObject?.line2 || '',
      city: partyAddressObject?.city || '',
      state: state || '',
      zip: partyAddressObject?.zip || '',
      country: partyAddressObject?.country || 'India',
    },
    phone: partyPhone ? String(partyPhone).trim() : undefined,
    email: partyEmail ? String(partyEmail).trim().toLowerCase() : undefined,
    pan: partyPAN ? String(partyPAN).trim().toUpperCase() : undefined,
  });

  return party.save();
}

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

    let resolvedVendor = null;
    if (vendor) {
      resolvedVendor = await resolveParty({
        userId: req.user._id,
        partyRef: vendor.vendorRef,
        partyName: vendor.name,
        isVendor: true,
        isClient: false,
        partyGST: vendor.gstin || vendor.vendorGST,
        partyAddressObject: vendor.vendorAddressObject || vendor.address,
        partyPhone: vendor.vendorPhone || vendor.phone,
        partyEmail: vendor.vendorEmail || vendor.email,
        partyPAN: vendor.vendorPAN || vendor.pan,
        placeOfSupply: req.body.placeOfSupply,
      });
    }

    let resolvedClient = null;
    if (client) {
      resolvedClient = await resolveParty({
        userId: req.user._id,
        partyRef: client.clientRef,
        partyName: client.name,
        isVendor: false,
        isClient: true,
      });
    }

    const categoryData = await validateExpenseCategory(req.user._id, category, subCategory);

    // Check if expenseNumber exists for this user (if you want uniqueness per user)
    const existing = await Expense.findOne({ expenseNumber, user: req.user._id });
    if (existing) {
      return res.status(400).json({ message: 'Expense number already exists' });
    }

    const tds_applicable = !!req.body.tds_applicable;
    const tds_section = req.body.tds_section || '';
    const tds_rate = Number(req.body.tds_rate) || 0;
    const tds_amount = tds_applicable ? (Number(req.body.tds_amount) || 0) : 0;
    const tds_nature = req.body.tds_nature || 'deductor';

    const basePayable = reverseCharge ? Math.max(grandTotal - taxTotal, 0) : grandTotal;
    const payableAmount = Math.max(basePayable - tds_amount, 0);
    const budgetWarning = await checkBudgetWarning(categoryData.category, req.user._id, payableAmount);
    const paymentState = resolvePaymentState(grandTotal, amountPaid, status, !!reverseCharge, taxTotal, tds_amount);

    const expense = await Expense.create({
      user: req.user._id,
      ...categoryData,
      project: project || null,
      department: department || null,
      expenseNumber,
      date,
      vendor: resolvedVendor ? { vendorRef: resolvedVendor._id, name: resolvedVendor.name } : { vendorRef: undefined, name: vendor?.name || '' },
      client: resolvedClient ? { clientRef: resolvedClient._id, name: resolvedClient.name } : { clientRef: undefined, name: client?.name || '' },
      paymentMethod,
      reverseCharge: !!reverseCharge,
      items: sanitizeItems(items),
      subTotal,
      taxTotal,
      grandTotal,
      amountPaid: paymentState.amountPaid,
      balanceDue: paymentState.balanceDue,
      dueDate,
      terms,
      privateNotes,
      status: paymentState.status,
      tds_applicable,
      tds_section,
      tds_rate,
      tds_amount,
      tds_nature,
      net_vendor_payment: payableAmount
    });

    if (expense.category) await updateBudgetSpent(expense.category, req.user._id);

    res.status(201).json(budgetWarning ? { data: expense, budgetWarning } : expense);
  } catch (error) {
    console.error('Error creating expense', error);
    if (error.message === 'Amount paid cannot exceed payable amount') {
      return res.status(422).json({ message: error.message });
    }
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

    let resolvedVendor = undefined;
    if (vendor !== undefined) {
      if (vendor) {
        const vParty = await resolveParty({
          userId: req.user._id,
          partyRef: vendor.vendorRef,
          partyName: vendor.name,
          isVendor: true,
          isClient: false,
          partyGST: vendor.gstin || vendor.vendorGST,
          partyAddressObject: vendor.vendorAddressObject || vendor.address,
          partyPhone: vendor.vendorPhone || vendor.phone,
          partyEmail: vendor.vendorEmail || vendor.email,
          partyPAN: vendor.vendorPAN || vendor.pan,
          placeOfSupply: req.body.placeOfSupply,
        });
        resolvedVendor = vParty ? { vendorRef: vParty._id, name: vParty.name } : { vendorRef: undefined, name: vendor.name || '' };
      } else {
        resolvedVendor = { vendorRef: undefined, name: '' };
      }
    }

    let resolvedClient = undefined;
    if (client !== undefined) {
      if (client) {
        const cParty = await resolveParty({
          userId: req.user._id,
          partyRef: client.clientRef,
          partyName: client.name,
          isVendor: false,
          isClient: true,
        });
        resolvedClient = cParty ? { clientRef: cParty._id, name: cParty.name } : { clientRef: undefined, name: client.name || '' };
      } else {
        resolvedClient = { clientRef: undefined, name: '' };
      }
    }

    const finalGrandTotal = grandTotal !== undefined ? grandTotal : expense.grandTotal;
    const finalTaxTotal = taxTotal !== undefined ? taxTotal : expense.taxTotal;
    const finalReverseCharge = reverseCharge !== undefined ? !!reverseCharge : !!expense.reverseCharge;

    const finalTdsApplicable = req.body.tds_applicable !== undefined ? !!req.body.tds_applicable : expense.tds_applicable;
    const finalTdsSection = req.body.tds_section !== undefined ? req.body.tds_section : expense.tds_section;
    const finalTdsRate = req.body.tds_rate !== undefined ? Number(req.body.tds_rate) : expense.tds_rate;
    const finalTdsAmount = finalTdsApplicable 
      ? (req.body.tds_amount !== undefined ? Number(req.body.tds_amount) : expense.tds_amount) 
      : 0;
    const finalTdsNature = req.body.tds_nature !== undefined ? req.body.tds_nature : expense.tds_nature;
    const finalBasePayable = finalReverseCharge ? Math.max(finalGrandTotal - finalTaxTotal, 0) : finalGrandTotal;
    const finalNetVendorPayment = Math.max(finalBasePayable - finalTdsAmount, 0);

    const paymentState = grandTotal !== undefined || amountPaid !== undefined || status !== undefined || reverseCharge !== undefined || taxTotal !== undefined || req.body.tds_applicable !== undefined || req.body.tds_amount !== undefined
      ? resolvePaymentState(
          finalGrandTotal,
          amountPaid !== undefined ? amountPaid : expense.amountPaid,
          status !== undefined ? status : expense.status,
          finalReverseCharge,
          finalTaxTotal,
          finalTdsAmount
        )
      : {};

    const updateData = {
      project: project !== undefined ? (project || null) : expense.project,
      department: department !== undefined ? (department || null) : expense.department,
      expenseNumber: expenseNumber !== undefined ? expenseNumber : expense.expenseNumber,
      date: date !== undefined ? date : expense.date,
      vendor: resolvedVendor !== undefined ? resolvedVendor : expense.vendor,
      client: resolvedClient !== undefined ? resolvedClient : expense.client,
      paymentMethod: paymentMethod !== undefined ? paymentMethod : expense.paymentMethod,
      reverseCharge: reverseCharge !== undefined ? !!reverseCharge : expense.reverseCharge,
      items: items !== undefined ? sanitizeItems(items) : expense.items,
      subTotal: subTotal !== undefined ? Number(subTotal) : expense.subTotal,
      taxTotal: taxTotal !== undefined ? Number(taxTotal) : expense.taxTotal,
      grandTotal: grandTotal !== undefined ? Number(grandTotal) : expense.grandTotal,
      amountPaid: paymentState.amountPaid !== undefined ? paymentState.amountPaid : expense.amountPaid,
      balanceDue: paymentState.balanceDue !== undefined ? paymentState.balanceDue : expense.balanceDue,
      dueDate: dueDate !== undefined ? dueDate : expense.dueDate,
      terms: terms !== undefined ? terms : expense.terms,
      privateNotes: privateNotes !== undefined ? privateNotes : expense.privateNotes,
      status: paymentState.status !== undefined ? paymentState.status : expense.status,
      tds_applicable: finalTdsApplicable,
      tds_section: finalTdsSection,
      tds_rate: finalTdsRate,
      tds_amount: finalTdsAmount,
      tds_nature: finalTdsNature,
      net_vendor_payment: finalNetVendorPayment
    };

    if (expenseNumber && expenseNumber !== expense.expenseNumber) {
      const existing = await Expense.findOne({ expenseNumber, user: req.user._id });
      if (existing) {
        return res.status(400).json({ message: 'Expense number already exists' });
      }
    }

    if (category !== undefined || subCategory !== undefined) {
      const categoryData = await validateExpenseCategory(
        req.user._id,
        category !== undefined ? category : expense.category,
        subCategory !== undefined ? subCategory : expense.subCategory
      );
      updateData.category = categoryData.category;
      updateData.subCategory = categoryData.subCategory;
    }

    // Remove undefined fields
    Object.keys(updateData).forEach(key => updateData[key] === undefined && delete updateData[key]);

    // Apply fields to document
    Object.keys(updateData).forEach(key => {
      expense[key] = updateData[key];
    });

    // Also update camelCase TDS fields directly to keep in sync
    expense.tdsApplicable = finalTdsApplicable;
    expense.tdsSection = ['194C', '194J', '194I', '194A', 'Manual'].includes(finalTdsSection) ? finalTdsSection : 'Manual';
    expense.tdsRate = finalTdsRate;
    expense.tdsAmount = finalTdsAmount;
    expense.tdsReceivable = finalTdsAmount;

    await expense.save();

    expense = await Expense.findOne({ _id: expense._id, user: req.user._id })
      .populate('category', 'name type color icon')
      .populate('subCategory', 'name type color icon parent');

    if (oldCategory) await updateBudgetSpent(oldCategory, req.user._id);
    if (expense.category && String(expense.category._id || expense.category) !== String(oldCategory || '')) {
      await updateBudgetSpent(expense.category._id || expense.category, req.user._id);
    }

    res.json(expense);
  } catch (error) {
    console.error('Error updating expense', error);
    if (error.message === 'Amount paid cannot exceed payable amount') {
      return res.status(422).json({ message: error.message });
    }
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
      await Expense.updateOne({ _id: expense._id }, { $set: { isDeleted: true, deletedAt: new Date() } });
      if (oldCategory) await updateBudgetSpent(oldCategory, req.user._id);
      res.json({ message: 'Expense removed' });
    } else {
      res.status(404).json({ message: 'Expense not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server Error deleting expense' });
  }
};
