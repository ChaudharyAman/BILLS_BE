const mongoose = require('mongoose');
const Category = require('../models/Category');
const Expense = require('../models/Expense');
const Income = require('../models/Income');

const DEFAULT_CATEGORIES = {
  expense: [
    { name: 'Payroll', color: '#2563eb', icon: 'FaUsers', children: ['Salaries', 'Wages', 'Bonuses', 'Allowances', 'PF/ESI', 'TDS'] },
    { name: 'Rent & Utilities', color: '#0891b2', icon: 'FaBuilding', children: ['Office Rent', 'Electricity', 'Water', 'Internet', 'Phone'] },
    { name: 'Marketing & Advertising', color: '#dc2626', icon: 'FaBullhorn', children: ['Digital Marketing', 'Print Media', 'Events'] },
    { name: 'Office Supplies', color: '#7c3aed', icon: 'FaBoxOpen' },
    { name: 'Travel & Transportation', color: '#ea580c', icon: 'FaCar' },
    { name: 'Professional Services', color: '#0f766e', icon: 'FaBriefcase', children: ['Legal', 'Accounting', 'Consulting'] },
    { name: 'Technology & Software', color: '#4f46e5', icon: 'FaLaptopCode', children: ['Subscriptions', 'Hardware', 'Licenses'] },
    { name: 'Insurance', color: '#16a34a', icon: 'FaShieldAlt' },
    { name: 'Taxes & Licenses', color: '#ca8a04', icon: 'FaFileInvoiceDollar' },
    { name: 'Maintenance & Repairs', color: '#475569', icon: 'FaTools' },
    { name: 'Miscellaneous', color: '#64748b', icon: 'FaEllipsisH' },
  ],
  income: [
    { name: 'Sales Revenue', color: '#16a34a', icon: 'FaChartLine', children: ['Product Sales', 'Service Revenue'] },
    { name: 'Consulting Income', color: '#0f766e', icon: 'FaHandshake' },
    { name: 'Investment Income', color: '#7c3aed', icon: 'FaCoins', children: ['Interest', 'Dividends', 'Capital Gains'] },
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

const createDefaultCategoryTree = async (userId, type, categoryDef) => {
  const parent = await Category.findOneAndUpdate(
    { user: userId, name: categoryDef.name, type },
    {
      $setOnInsert: {
        user: userId,
        name: categoryDef.name,
        type,
        icon: categoryDef.icon || '',
        color: categoryDef.color || '#64748b',
        isSystem: true,
        parent: null,
      },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );

  for (const childName of categoryDef.children || []) {
    await Category.findOneAndUpdate(
      { user: userId, name: childName, type },
      {
        $setOnInsert: {
          user: userId,
          name: childName,
          type,
          isSystem: true,
          parent: parent._id,
          color: parent.color,
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
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

    if (category.isSystem && (req.body.name || req.body.type || Object.prototype.hasOwnProperty.call(req.body, 'parent'))) {
      return res.status(400).json({ message: 'System categories cannot be renamed, moved, or retyped' });
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

    if (category.isSystem) {
      return res.status(400).json({ message: 'System categories cannot be deleted' });
    }

    const hasChildren = await Category.exists({ user: req.user._id, parent: category._id });
    if (hasChildren) {
      return res.status(400).json({ message: 'Cannot delete a category with sub-categories' });
    }

    const Model = category.type === 'income' ? Income : Expense;
    const inUse = await Model.exists({
      user: req.user._id,
      $or: [{ category: category._id }, { subCategory: category._id }],
    });

    if (inUse) {
      return res.status(400).json({ message: 'Cannot delete a category that is used by transactions' });
    }

    await category.deleteOne();
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
