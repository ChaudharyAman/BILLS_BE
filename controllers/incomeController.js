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
    const exportAll = req.query.all === 'true';
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    const { status, sourceType, startDate, endDate, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

    let query = { user: req.user._id };
    if (req.query.category) query.category = req.query.category;
    if (req.query.subCategory) query.subCategory = req.query.subCategory;
    if (req.query.project) query.project = req.query.project;
    if (req.query.businessUnit && mongoose.Types.ObjectId.isValid(req.query.businessUnit)) {
      query.businessUnit = req.query.businessUnit;
    }
    if (status) query.status = status;
    if (sourceType) query.sourceType = sourceType;

    // Date range filter
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setUTCHours(23, 59, 59, 999);
        query.date.$lte = end;
      }
    }

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

    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;
    if (sortBy !== 'createdAt') {
      sort.createdAt = -1;
    }

    const total = await Income.countDocuments(query);
    const incomesQuery = Income.find(query)
      .select('-items -terms -privateNotes')
      .populate('category', 'name type color icon')
      .populate('subCategory', 'name type color icon parent')
      .populate('businessUnit', 'name code color')
      .lean()
      .sort(sort);

    if (!exportAll) {
      incomesQuery.skip(skip).limit(limit);
    }

    const incomes = await incomesQuery;

    res.json({
      data: incomes,
      total,
      page: exportAll ? 1 : page,
      limit: exportAll ? total : limit,
      totalPages: exportAll ? 1 : Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error fetching incomes:', error);
    res.status(500).json({ message: 'Server Error fetching incomes' });
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
  if (!name) return null;

  const escaped = escapeRegex(name).replace(/\s+/g, '\\s+');
  const regex = new RegExp(`^\\s*${escaped}\\s*$`, 'i');

  const existing = await ClientModel.findOne({
    user: userId,
    name: { $regex: regex }
  });

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
      businessUnit,
      incomeNumber,
      date,
      vendor,
      client,
      paymentMethod,
      reverseCharge,
      items,
      subTotal,
      taxTotal,
      totalCGST,
      totalSGST,
      totalIGST,
      grandTotal,
      terms,
      privateNotes,
      placeOfSupply,
      tds_applicable,
      tds_section,
      tds_rate,
      tds_amount,
      amountPaid,
      status
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
        partyGST: client.gstin || client.clientGST,
        partyAddressObject: client.clientAddressObject || client.address,
        partyPhone: client.clientPhone || client.phone,
        partyEmail: client.clientEmail || client.email,
        partyPAN: client.clientPAN || client.pan,
        placeOfSupply: req.body.placeOfSupply,
      });
    }

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
      businessUnit: businessUnit && mongoose.Types.ObjectId.isValid(businessUnit) ? businessUnit : null,
      sourceType: 'manual',
      incomeNumber,
      date,
      vendor: resolvedVendor ? { vendorRef: resolvedVendor._id, name: resolvedVendor.name } : { vendorRef: undefined, name: vendor?.name || '' },
      client: resolvedClient ? { clientRef: resolvedClient._id, name: resolvedClient.name } : { clientRef: undefined, name: client?.name || '' },
      paymentMethod,
      reverseCharge: !!reverseCharge,
      items,
      subTotal,
      taxTotal,
      totalCGST: Number(totalCGST) || 0,
      totalSGST: Number(totalSGST) || 0,
      totalIGST: Number(totalIGST) || 0,
      grandTotal,
      terms,
      privateNotes,
      status: status || 'PAID',
      placeOfSupply: placeOfSupply || '',
      tds_applicable: !!tds_applicable,
      tds_section: tds_section || '',
      tds_rate: Number(tds_rate) || 0,
      tds_amount: Number(tds_amount) || 0,
      amountPaid: Number(amountPaid) || 0
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
      .populate('subCategory', 'name type color icon parent')
      .populate('businessUnit', 'name code color');

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
      businessUnit,
      incomeNumber,
      date,
      vendor,
      client,
      paymentMethod,
      reverseCharge,
      items,
      subTotal,
      taxTotal,
      totalCGST,
      totalSGST,
      totalIGST,
      grandTotal,
      terms,
      privateNotes,
      status,
      placeOfSupply,
      tds_applicable,
      tds_section,
      tds_rate,
      tds_amount,
      amountPaid
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
          partyGST: client.gstin || client.clientGST,
          partyAddressObject: client.clientAddressObject || client.address,
          partyPhone: client.clientPhone || client.phone,
          partyEmail: client.clientEmail || client.email,
          partyPAN: client.clientPAN || client.pan,
          placeOfSupply: req.body.placeOfSupply,
        });
        resolvedClient = cParty ? { clientRef: cParty._id, name: cParty.name } : { clientRef: undefined, name: client.name || '' };
      } else {
        resolvedClient = { clientRef: undefined, name: '' };
      }
    }

    if (incomeNumber && incomeNumber !== income.incomeNumber) {
      const existingNumber = await Income.findOne({ incomeNumber, user: req.user._id });
      if (existingNumber) {
        return res.status(400).json({ message: 'Income number already exists' });
      }
    }

    const basePayable = grandTotal !== undefined ? (Number(grandTotal) || 0) : (income.grandTotal || 0);
    const tdsApplicable = tds_applicable !== undefined ? !!tds_applicable : (income.tds_applicable || false);
    const tdsAmt = tdsApplicable ? (tds_amount !== undefined ? (Number(tds_amount) || 0) : (income.tds_amount || 0)) : 0;
    const netReceived = Math.round(Math.max(basePayable - tdsAmt, 0) * 100) / 100;
    const paidAmt = amountPaid !== undefined ? (Number(amountPaid) || 0) : (income.amountPaid || 0);
    const balDue = Math.round(Math.max(netReceived - paidAmt, 0) * 100) / 100;

    let computedStatus = status;
    if (!status) {
      if (balDue === 0) {
        computedStatus = 'PAID';
      } else if (paidAmt > 0) {
        computedStatus = 'PARTIAL';
      } else {
        computedStatus = 'UNPAID';
      }
    }

    const updateData = {
      project: project !== undefined ? (project || null) : income.project,
      department: department !== undefined ? (department || null) : income.department,
      businessUnit: businessUnit !== undefined ? (businessUnit && mongoose.Types.ObjectId.isValid(businessUnit) ? businessUnit : null) : income.businessUnit,
      incomeNumber: incomeNumber !== undefined ? incomeNumber : income.incomeNumber,
      date: date !== undefined ? date : income.date,
      vendor: resolvedVendor !== undefined ? resolvedVendor : income.vendor,
      client: resolvedClient !== undefined ? resolvedClient : income.client,
      paymentMethod: paymentMethod !== undefined ? paymentMethod : income.paymentMethod,
      reverseCharge: reverseCharge !== undefined ? !!reverseCharge : income.reverseCharge,
      items: items !== undefined ? items : income.items,
      subTotal: subTotal !== undefined ? Number(subTotal) : income.subTotal,
      taxTotal: taxTotal !== undefined ? Number(taxTotal) : income.taxTotal,
      totalCGST: totalCGST !== undefined ? Number(totalCGST) : income.totalCGST,
      totalSGST: totalSGST !== undefined ? Number(totalSGST) : income.totalSGST,
      totalIGST: totalIGST !== undefined ? Number(totalIGST) : income.totalIGST,
      grandTotal: grandTotal !== undefined ? Number(grandTotal) : income.grandTotal,
      terms: terms !== undefined ? terms : income.terms,
      privateNotes: privateNotes !== undefined ? privateNotes : income.privateNotes,
      status: computedStatus,
      placeOfSupply: placeOfSupply !== undefined ? placeOfSupply : income.placeOfSupply,
      tds_applicable: tdsApplicable,
      tds_section: tds_section !== undefined ? tds_section : income.tds_section,
      tds_rate: tds_rate !== undefined ? Number(tds_rate) : income.tds_rate,
      tds_amount: tdsAmt,
      amountPaid: paidAmt,
      net_received_payment: netReceived,
      balanceDue: balDue
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
      await Income.updateOne({ _id: income._id }, { $set: { isDeleted: true, deletedAt: new Date() } });
      res.json({ message: 'Income removed' });
    } else {
      res.status(404).json({ message: 'Income not found' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Server Error deleting income' });
  }
};
