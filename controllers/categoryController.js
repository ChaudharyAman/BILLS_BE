const mongoose = require('mongoose');
const Category = require('../models/Category');
const Expense = require('../models/Expense');
const Income = require('../models/Income');
const Budget = require('../models/Budget');
const RecurringTransaction = require('../models/RecurringTransaction');

const DEFAULT_CATEGORIES = {
  expense: [
    { name: 'Payroll', color: '#2563eb', icon: 'FaUsers', children: ['Salaries', 'Wages', 'Bonuses', 'Allowances', 'PF/ESI', 'TDS'] },
    { name: 'Rent & Utilities', color: '#0891b2', icon: 'FaBuilding', children: ['Office Rent', 'Electricity', 'Water', 'Internet', 'Phone'] },
    { name: 'Marketing & Advertising', color: '#dc2626', icon: 'FaBullhorn', children: ['Digital Marketing', 'Print Media', 'Events'] },
    { name: 'Office Supplies', color: '#7c3aed', icon: 'FaBoxOpen' },
    { name: 'Travel & Transportation', color: '#ea580c', icon: 'FaCar' },
    { name: 'Professional Services', color: '#0f766e', icon: 'FaBriefcase', children: ['Legal', 'Accounting', 'Consulting'] },
    { name: 'Technology & Software', color: '#4f46e5', icon: 'FaLaptopCode', children: ['Subscriptions', 'Hardware', 'Licenses'] },
    { name: 'Bank & Financial Charges', color: '#be123c', icon: 'FaUniversity', children: ['Bank Fees & SMS Charges', 'Payment Gateway Fees', 'Interest Paid'] },
    { name: 'Outsource & Contractor Costs', color: '#0369a1', icon: 'FaUserTie', children: ['Freelancers', 'Contract Agencies', 'Outsourced Developers'] },
    { name: 'Employee Welfare & Benefits', color: '#047857', icon: 'FaHeart', children: ['Staff Welfare & Pantry', 'Training & Seminars', 'Team Outings & Offsites'] },
    { name: 'Shipping & Logistics', color: '#d97706', icon: 'FaTruck', children: ['Courier & Postage', 'Freight Charges', 'Customs & Import Duties'] },
    { name: 'Insurance', color: '#16a34a', icon: 'FaShieldAlt' },
    { name: 'Taxes & Licenses', color: '#ca8a04', icon: 'FaFileInvoiceDollar' },
    { name: 'Maintenance & Repairs', color: '#475569', icon: 'FaTools' },
    { name: 'Miscellaneous', color: '#64748b', icon: 'FaEllipsisH' },
  ],
  income: [
    { name: 'Sales Revenue', color: '#16a34a', icon: 'FaChartLine', children: ['Product Sales', 'Service Revenue'] },
    { name: 'Consulting Income', color: '#0f766e', icon: 'FaHandshake' },
    { name: 'Investment Income', color: '#7c3aed', icon: 'FaCoins', children: ['Interest', 'Dividends', 'Capital Gains'] },
    { name: 'Reimbursements & Billable Income', color: '#0d9488', icon: 'FaFileInvoice', children: ['Travel Reimbursements', 'Client-Billed Out-of-Pocket Expenses'] },
    { name: 'Other Income', color: '#64748b', icon: 'FaPlusCircle' },
  ],
};

const normalizeName = (name) => String(name || '').trim();

const validateParent = async ({ userId, parent, type, categoryId }) => {
  if (!parent) return null;
  if (!mongoose.Types.ObjectId.isValid(parent)) {
    const error = new Error('Invalid parent category');
    error.statusCode = 400;
    throw error;
  }

  if (categoryId && String(parent) === String(categoryId)) {
    const error = new Error('A category cannot be its own parent');
    error.statusCode = 400;
    throw error;
  }

  const parentCategory = await Category.findOne({ _id: parent, user: userId, type });
  if (!parentCategory) {
    const error = new Error('Parent category not found');
    error.statusCode = 400;
    throw error;
  }

  return parentCategory._id;
};

const upsertOrRestoreDefaultCategory = async ({ userId, type, name, icon, color, parent = null }) => {
  const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameRegex = new RegExp(`^${escapeRegex(name)}(_del_.*)?$`);

  let category = await Category.findOne({
    user: userId,
    type,
    name: nameRegex,
  }).setOptions({ withDeleted: true });

  if (category) {
    category = await Category.findOneAndUpdate(
      { _id: category._id },
      {
        $set: {
          name,
          isDeleted: false,
          deletedAt: null,
          isSystem: true,
          parent: parent || null,
          ...(icon ? { icon } : {}),
          ...(color ? { color } : {}),
        },
      },
      { returnDocument: 'after', setOptions: { withDeleted: true } }
    );
  } else {
    category = await Category.create({
      user: userId,
      name,
      type,
      icon: icon || '',
      color: color || '#64748b',
      isSystem: true,
      parent: parent || null,
      isDeleted: false,
    });
  }

  return category;
};

const createDefaultCategoryTree = async (userId, type, categoryDef) => {
  const parent = await upsertOrRestoreDefaultCategory({
    userId,
    type,
    name: categoryDef.name,
    icon: categoryDef.icon || '',
    color: categoryDef.color || '#64748b',
    parent: null,
  });

  for (const childName of categoryDef.children || []) {
    await upsertOrRestoreDefaultCategory({
      userId,
      type,
      name: childName,
      icon: '',
      color: parent.color || '#64748b',
      parent: parent._id,
    });
  }
};

const initializeDefaultsForUser = async (userId) => {
  for (const [type, categories] of Object.entries(DEFAULT_CATEGORIES)) {
    for (const categoryDef of categories) {
      await createDefaultCategoryTree(userId, type, categoryDef);
    }
  }
};

exports.initializeDefaultsForUser = initializeDefaultsForUser;

exports.getCategories = async (req, res) => {
  try {
    const { type, parent } = req.query;
    const query = { user: req.user._id };

    if (type) query.type = type;
    if (parent === 'root') query.parent = null;
    else if (parent) query.parent = parent;

    const categories = await Category.find(query)
      .populate('parent', 'name type color icon')
      .sort({ type: 1, parent: 1, name: 1 })
      .lean();

    res.json(categories);
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ message: 'Server error fetching categories' });
  }
};

exports.createCategory = async (req, res) => {
  try {
    const name = normalizeName(req.body.name);
    const { type, icon, color, budgetLimit, description } = req.body;

    if (!name || !type) {
      return res.status(400).json({ message: 'Name and type are required' });
    }

    const parent = await validateParent({
      userId: req.user._id,
      parent: req.body.parent || null,
      type,
    });

    const category = await Category.create({
      user: req.user._id,
      name,
      type,
      icon,
      color,
      budgetLimit,
      description,
      parent,
      isSystem: false,
    });

    res.status(201).json(category);
  } catch (error) {
    console.error('Error creating category:', error);
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Category name already exists for this type' });
    }
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error creating category' });
  }
};

exports.updateCategory = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Category not found' });
    }

    const category = await Category.findOne({ _id: req.params.id, user: req.user._id });
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }

    if (category.isSystem) {
      const nameChanged = req.body.name !== undefined && normalizeName(req.body.name) !== category.name;
      const typeChanged = req.body.type !== undefined && req.body.type !== category.type;
      
      let parentChanged = false;
      if (Object.prototype.hasOwnProperty.call(req.body, 'parent')) {
        const newParent = req.body.parent ? String(req.body.parent) : null;
        const oldParent = category.parent ? String(category.parent) : null;
        if (newParent !== oldParent) {
          parentChanged = true;
        }
      }

      if (nameChanged || typeChanged || parentChanged) {
        return res.status(400).json({ message: 'System categories cannot be renamed, moved, or retyped' });
      }
    }

    const updateData = {};
    for (const field of ['name', 'type', 'icon', 'color', 'budgetLimit', 'description']) {
      if (req.body[field] !== undefined) updateData[field] = field === 'name' ? normalizeName(req.body[field]) : req.body[field];
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'parent')) {
      updateData.parent = await validateParent({
        userId: req.user._id,
        parent: req.body.parent || null,
        type: updateData.type || category.type,
        categoryId: category._id,
      });
    } else if (req.body.type !== undefined && req.body.type !== category.type && category.parent) {
      updateData.parent = await validateParent({
        userId: req.user._id,
        parent: req.body.parent || null,
        type: updateData.type || category.type,
        categoryId: category._id,
      });
    }

    const updated = await Category.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: updateData },
      { returnDocument: 'after', runValidators: true }
    ).populate('parent', 'name type color icon');

    res.json(updated);
  } catch (error) {
    console.error('Error updating category:', error);
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Category name already exists for this type' });
    }
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error updating category' });
  }
};

exports.deleteCategory = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Category not found' });
    }

    const category = await Category.findOne({ _id: req.params.id, user: req.user._id });
    if (!category) {
      return res.status(404).json({ message: 'Category not found' });
    }

    // Find all child sub-categories (if any)
    const children = await Category.find({ user: req.user._id, parent: category._id });
    const categoryIdsToCheck = [category._id, ...children.map(c => c._id)];

    const isSubCategory = !!category.parent;
    const itemLabel = isSubCategory ? 'sub-category' : 'category';

    // Check if any Expenses, Incomes, Budgets, or Recurring Transactions are assigned
    const [expenseCount, incomeCount, budgetCount, recurringCount] = await Promise.all([
      Expense.countDocuments({
        user: req.user._id,
        $or: [
          { category: { $in: categoryIdsToCheck } },
          { subCategory: { $in: categoryIdsToCheck } }
        ]
      }),
      Income.countDocuments({
        user: req.user._id,
        $or: [
          { category: { $in: categoryIdsToCheck } },
          { subCategory: { $in: categoryIdsToCheck } }
        ]
      }),
      Budget.countDocuments({
        user: req.user._id,
        category: { $in: categoryIdsToCheck }
      }).catch(() => 0),
      RecurringTransaction.countDocuments({
        user: req.user._id,
        $or: [
          { category: { $in: categoryIdsToCheck } },
          { subCategory: { $in: categoryIdsToCheck } }
        ]
      }).catch(() => 0)
    ]);

    const totalAssigned = expenseCount + incomeCount + budgetCount + recurringCount;
    if (totalAssigned > 0) {
      return res.status(400).json({
        message: `Cannot delete ${itemLabel} "${category.name}" because ${totalAssigned} transaction(s)/budget(s) are currently assigned to it.`
      });
    }

    // Soft-delete any child sub-categories
    for (const child of children) {
      await Category.findOneAndUpdate(
        { _id: child._id, user: req.user._id },
        { $set: { isDeleted: true, deletedAt: new Date() } }
      );
    }

    // Soft-delete the target category
    await Category.findOneAndUpdate(
      { _id: category._id, user: req.user._id },
      { $set: { isDeleted: true, deletedAt: new Date() } }
    );

    res.json({ message: 'Category deleted successfully' });
  } catch (error) {
    console.error('Error deleting category:', error);
    res.status(500).json({ message: 'Server error deleting category' });
  }
};

exports.initializeDefaultCategories = async (req, res) => {
  try {
    await initializeDefaultsForUser(req.user._id);
    const categories = await Category.find({ user: req.user._id })
      .sort({ type: 1, parent: 1, name: 1 })
      .lean();
    res.status(201).json({ message: 'Default categories initialized', categories });
  } catch (error) {
    console.error('Error initializing default categories:', error);
    res.status(500).json({ message: 'Server error initializing categories' });
  }
};
