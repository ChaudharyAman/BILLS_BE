const mongoose = require('mongoose');
const BusinessUnit = require('../models/BusinessUnit');
const Employee = require('../models/Employee');
const Invoice = require('../models/Invoice');
const Expense = require('../models/Expense');
const Income = require('../models/Income');
const Quote = require('../models/Quote');
const PurchaseOrder = require('../models/PurchaseOrder');
const { getTenantFilter, attachTenant, getTenantMatch } = require('../utils/tenantHelper');

const pickBusinessUnitFields = (body) => {
  const allowedFields = ['name', 'code', 'description', 'head', 'status', 'color', 'isDefault'];
  const payload = {};

  allowedFields.forEach((field) => {
    if (body[field] !== undefined) {
      payload[field] = body[field];
    }
  });

  return payload;
};

const validateHead = async (head, userId, req) => {
  if (!head) return null;

  if (!mongoose.Types.ObjectId.isValid(head)) {
    const error = new Error('Unit head employee not found');
    error.statusCode = 404;
    throw error;
  }

  const filter = req ? { _id: head, ...getTenantFilter(req) } : { _id: head, user: userId };
  const employee = await Employee.findOne(filter).select('_id').lean();
  if (!employee) {
    const error = new Error('Unit head employee not found');
    error.statusCode = 404;
    throw error;
  }

  return employee._id;
};

exports.getBusinessUnits = async (req, res) => {
  try {
    const filter = { ...getTenantFilter(req) };
    if (req.query.status) {
      filter.status = req.query.status;
    }

    const businessUnits = await BusinessUnit.find(filter)
      .populate('head', 'employeeId firstName lastName email')
      .sort({ name: 1 })
      .lean();

    res.json(businessUnits);
  } catch (error) {
    console.error('Error fetching business units:', error);
    res.status(500).json({ message: 'Server error fetching business units' });
  }
};

exports.createBusinessUnit = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const payload = pickBusinessUnitFields(req.body);
    if (!payload.name || !payload.code) {
      return res.status(400).json({ message: 'Name and Code are required' });
    }

    payload.head = await validateHead(payload.head, companyId, req);

    if (payload.isDefault) {
      await BusinessUnit.updateMany(getTenantFilter(req), { isDefault: false });
    }

    const businessUnit = await BusinessUnit.create(attachTenant(req, {
      ...payload,
      user: companyId,
    }));

    res.status(201).json(businessUnit);
  } catch (error) {
    console.error('Error creating business unit:', error);
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Business unit name or code already exists' });
    }
    res.status(500).json({ message: 'Server error creating business unit' });
  }
};

exports.updateBusinessUnit = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Business unit not found' });
    }

    const payload = pickBusinessUnitFields(req.body);
    if (Object.prototype.hasOwnProperty.call(payload, 'head')) {
      payload.head = await validateHead(payload.head, companyId, req);
    }

    const tenantFilter = getTenantFilter(req);

    if (payload.isDefault) {
      await BusinessUnit.updateMany({ ...tenantFilter, _id: { $ne: req.params.id } }, { isDefault: false });
    }

    const businessUnit = await BusinessUnit.findOneAndUpdate(
      { _id: req.params.id, ...tenantFilter },
      { $set: payload },
      { returnDocument: 'after', runValidators: true }
    ).populate('head', 'employeeId firstName lastName email');

    if (!businessUnit) {
      return res.status(404).json({ message: 'Business unit not found' });
    }

    res.json(businessUnit);
  } catch (error) {
    console.error('Error updating business unit:', error);
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Business unit name or code already exists' });
    }
    res.status(500).json({ message: 'Server error updating business unit' });
  }
};

exports.deleteBusinessUnit = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Business unit not found' });
    }

    const unitId = req.params.id;
    const tenantFilter = getTenantFilter(req);

    // Integrity check: Block deletion if unit is referenced by any transactions
    const [hasInvoice, hasExpense, hasIncome, hasQuote, hasPO] = await Promise.all([
      Invoice.exists({ ...tenantFilter, businessUnit: unitId }),
      Expense.exists({ ...tenantFilter, businessUnit: unitId }),
      Income.exists({ ...tenantFilter, businessUnit: unitId }),
      Quote ? Quote.exists({ ...tenantFilter, businessUnit: unitId }) : false,
      PurchaseOrder ? PurchaseOrder.exists({ ...tenantFilter, businessUnit: unitId }) : false,
    ]);

    if (hasInvoice || hasExpense || hasIncome || hasQuote || hasPO) {
      return res.status(400).json({
        message: 'Cannot delete business unit linked to existing transactions. Reassign or remove transactions first.'
      });
    }

    const businessUnit = await BusinessUnit.findOneAndUpdate(
      { _id: unitId, ...tenantFilter },
      { $set: { isDeleted: true, deletedAt: new Date() } }
    );

    if (!businessUnit) {
      return res.status(404).json({ message: 'Business unit not found' });
    }

    res.json({ message: 'Business unit deleted successfully' });
  } catch (error) {
    console.error('Error deleting business unit:', error);
    res.status(500).json({ message: 'Server error deleting business unit' });
  }
};

exports.getBusinessUnitSummary = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Business unit not found' });
    }

    const tenantFilter = getTenantFilter(req);
    const tenantMatch = getTenantMatch(req);

    const unit = await BusinessUnit.findOne({ _id: req.params.id, ...tenantFilter })
      .populate('head', 'employeeId firstName lastName email')
      .lean();

    if (!unit) {
      return res.status(404).json({ message: 'Business unit not found' });
    }

    const [invoices, expenses] = await Promise.all([
      Invoice.aggregate([
        { $match: { ...tenantMatch, businessUnit: new mongoose.Types.ObjectId(req.params.id), status: { $in: ['SENT', 'PAID', 'RECEIVED', 'PARTIAL'] } } },
        { $group: { _id: null, totalRevenue: { $sum: '$grandTotal' }, count: { $sum: 1 } } }
      ]),
      Expense.aggregate([
        { $match: { ...tenantMatch, businessUnit: new mongoose.Types.ObjectId(req.params.id), status: { $ne: 'CANCELLED' } } },
        { $group: { _id: null, totalExpense: { $sum: '$grandTotal' }, count: { $sum: 1 } } }
      ])
    ]);

    const totalRevenue = invoices.length > 0 ? invoices[0].totalRevenue : 0;
    const totalExpense = expenses.length > 0 ? expenses[0].totalExpense : 0;

    res.json({
      unit,
      summary: {
        totalRevenue,
        totalExpense,
        netProfit: totalRevenue - totalExpense,
        invoiceCount: invoices.length > 0 ? invoices[0].count : 0,
        expenseCount: expenses.length > 0 ? expenses[0].count : 0,
      }
    });
  } catch (error) {
    console.error('Error fetching business unit summary:', error);
    res.status(500).json({ message: 'Server error fetching business unit summary' });
  }
};

exports.getBusinessUnitRollup = async (req, res) => {
  try {
    const tenantFilter = getTenantFilter(req);
    const tenantMatch = getTenantMatch(req);
    const units = await BusinessUnit.find(tenantFilter).lean();
    
    const [invoiceRollup, expenseRollup] = await Promise.all([
      Invoice.aggregate([
        { $match: { ...tenantMatch, status: { $in: ['SENT', 'PAID', 'RECEIVED', 'PARTIAL'] } } },
        { $group: { _id: '$businessUnit', totalRevenue: { $sum: '$grandTotal' }, count: { $sum: 1 } } }
      ]),
      Expense.aggregate([
        { $match: { ...tenantMatch, status: { $ne: 'CANCELLED' } } },
        { $group: { _id: '$businessUnit', totalExpense: { $sum: '$grandTotal' }, count: { $sum: 1 } } }
      ])
    ]);

    const revenueMap = new Map(invoiceRollup.map(r => [String(r._id || 'unassigned'), r]));
    const expenseMap = new Map(expenseRollup.map(r => [String(r._id || 'unassigned'), r]));

    const result = units.map(u => {
      const rev = revenueMap.get(String(u._id)) || { totalRevenue: 0, count: 0 };
      const exp = expenseMap.get(String(u._id)) || { totalExpense: 0, count: 0 };
      return {
        ...u,
        totalRevenue: rev.totalRevenue,
        totalExpense: exp.totalExpense,
        netProfit: rev.totalRevenue - exp.totalExpense,
        invoiceCount: rev.count,
        expenseCount: exp.count,
      };
    });

    res.json(result);
  } catch (error) {
    console.error('Error fetching business unit rollups:', error);
    res.status(500).json({ message: 'Server error fetching business unit rollups' });
  }
};
