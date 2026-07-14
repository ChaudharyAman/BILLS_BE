const Invoice = require('../models/Invoice');
const Quote = require('../models/Quote');
const Proforma = require('../models/Proforma');
const PurchaseOrder = require('../models/PurchaseOrder');
const Expense = require('../models/Expense');
const Income = require('../models/Income');
const Client = require('../models/Client');
const Item = require('../models/Item');
const Employee = require('../models/Employee');
const Project = require('../models/Project');
const Asset = require('../models/Asset');
const Liability = require('../models/Liability');
const Budget = require('../models/Budget');
const Category = require('../models/Category');
const Department = require('../models/Department');
const Role = require('../models/Role');
const ReimbursementClaim = require('../models/ReimbursementClaim');
const RecurringTransaction = require('../models/RecurringTransaction');
const Payroll = require('../models/Payroll');
const PayrollComponent = require('../models/PayrollComponent');
const PayrollVariableTransaction = require('../models/PayrollVariableTransaction');
const LeaveRequest = require('../models/LeaveRequest');
const BankStatement = require('../models/BankStatement');

const MODELS_MAP = {
  Invoice, Quote, Proforma, PurchaseOrder, Expense, Income, Client, Item, Employee, Project, Asset, Liability, Budget, Category, Department, Role, ReimbursementClaim, RecurringTransaction, Payroll, PayrollComponent, PayrollVariableTransaction, LeaveRequest, BankStatement
};

function getDisplayName(doc, type) {
  switch (type) {
    case 'Invoice':
      return `Invoice #${doc.invoiceNo || doc.invoiceNumber || 'Unknown'}`;
    case 'Quote':
      return `Quote #${doc.quoteNumber || 'Unknown'}`;
    case 'Proforma':
      return `Proforma #${doc.proformaNumber || 'Unknown'}`;
    case 'PurchaseOrder':
      return `Purchase Order #${doc.poNumber || 'Unknown'}`;
    case 'Expense':
      return `Expense: ${doc.merchant || 'Unnamed'} (${doc.categoryName || 'No Category'})`;
    case 'Income':
      return `Income: ${doc.source || 'Unnamed'}`;
    case 'Client':
      const roleStr = doc.isVendor ? 'Vendor' : 'Client';
      return `${roleStr}: ${doc.name || doc.companyName || 'Unnamed'}`;
    case 'Item':
      return `Item: ${doc.name || 'Unnamed'}`;
    case 'Employee':
      return `Employee: ${doc.firstName} ${doc.lastName || ''}`.trim();
    case 'Project':
      return `Project: ${doc.name || 'Unnamed'}`;
    case 'Asset':
      return `Asset: ${doc.name || 'Unnamed'}`;
    case 'Liability':
      return `Liability: ${doc.name || 'Unnamed'}`;
    case 'Budget':
      return `Budget: ${doc.name || doc.category || 'Unnamed'}`;
    case 'Category':
      return `Category: ${doc.name || 'Unnamed'}`;
    case 'Department':
      return `Department: ${doc.name || 'Unnamed'}`;
    case 'Role':
      return `Role: ${doc.name || 'Unnamed'}`;
    case 'ReimbursementClaim':
      return `Reimbursement Claim: ${doc.expenseName || doc.title || 'Unnamed'}`;
    case 'RecurringTransaction':
      return `Recurring Transaction: ${doc.description || 'Unnamed'}`;
    case 'Payroll':
      return `Payroll: Month ${doc.month}/${doc.year}`;
    case 'PayrollComponent':
      return `Payroll Component: ${doc.name || 'Unnamed'}`;
    case 'PayrollVariableTransaction':
      return `Payroll Var Transaction: ${doc.description || 'Unnamed'}`;
    case 'LeaveRequest':
      return `Leave Request: ${doc.leaveType || 'Leave'}`;
    case 'BankStatement':
      return `Bank Statement: ${doc.fileName || doc.name || 'Statement'}`;
    default:
      return `${type} (ID: ${doc._id})`;
  }
}

function getDisplayAmount(doc, type) {
  switch (type) {
    case 'Invoice':
    case 'Quote':
    case 'Proforma':
    case 'PurchaseOrder':
      return doc.total || doc.totalAmount || doc.grandTotal || null;
    case 'Expense':
    case 'Income':
      return doc.amount || null;
    case 'Asset':
    case 'Liability':
      return doc.purchaseValue || doc.value || doc.amount || null;
    case 'ReimbursementClaim':
      return doc.amount || null;
    case 'Payroll':
      return doc.netSalary || doc.netPay || null;
    default:
      return null;
  }
}

const getRecycleBinItems = async (req, res) => {
  try {
    const userId = req.user._id;
    const promises = Object.entries(MODELS_MAP).map(async ([type, Model]) => {
      const items = await Model.find({ user: userId, isDeleted: true })
        .setOptions({ withDeleted: true })
        .lean();
      
      return items.map(item => ({
        _id: item._id,
        type,
        displayName: getDisplayName(item, type),
        amount: getDisplayAmount(item, type),
        deletedAt: item.deletedAt || item.updatedAt || new Date(),
      }));
    });

    const results = await Promise.all(promises);
    const flattened = results.flat().sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));

    res.json(flattened);
  } catch (error) {
    console.error('Failed to fetch recycle bin items:', error);
    res.status(500).json({ message: 'Failed to fetch recycle bin items', error: error.message });
  }
};

const restoreItem = async (req, res) => {
  try {
    const { id, type, forceRestore } = req.body;
    if (!id || !type) {
      return res.status(400).json({ message: 'ID and Type are required' });
    }

    const Model = MODELS_MAP[type];
    if (!Model) {
      return res.status(400).json({ message: `Invalid type: ${type}` });
    }

    const item = await Model.findOneAndUpdate(
      { _id: id, user: req.user._id },
      { $set: { isDeleted: false }, $unset: { deletedAt: 1 } },
      { new: true }
    ).setOptions({ withDeleted: true, forceRestore: !!forceRestore });

    if (!item) {
      return res.status(404).json({ message: 'Item not found in Recycle Bin' });
    }

    res.json({ message: 'Item restored successfully', item });
  } catch (error) {
    console.error('Failed to restore item:', error);
    if (error.message === 'COLLISION') {
      return res.status(409).json({ 
        message: 'COLLISION', 
        collidingId: error.collidingId 
      });
    }
    if (error.code === 11000 || error.message.includes('E11000')) {
      return res.status(400).json({ 
        message: 'Restore failed: An active item with the same unique identifier (such as name, code, or number) already exists. Please rename or permanently delete the active item first.' 
      });
    }
    res.status(500).json({ message: 'Failed to restore item', error: error.message });
  }
};

const permanentlyDeleteItem = async (req, res) => {
  try {
    const { id, type } = req.query;
    if (!id || !type) {
      return res.status(400).json({ message: 'ID and Type are required' });
    }

    const Model = MODELS_MAP[type];
    if (!Model) {
      return res.status(400).json({ message: `Invalid type: ${type}` });
    }

    const result = await Model.deleteOne({ _id: id, user: req.user._id }).setOptions({ hardDelete: true });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'Item not found' });
    }

    res.json({ message: 'Item permanently deleted' });
  } catch (error) {
    console.error('Failed to permanently delete item:', error);
    res.status(500).json({ message: 'Failed to permanently delete item', error: error.message });
  }
};

module.exports = {
  getRecycleBinItems,
  restoreItem,
  permanentlyDeleteItem
};
