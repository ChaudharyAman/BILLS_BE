const mongoose = require('mongoose');
const AccrualEntry = require('../models/AccrualEntry');

const pageOptions = (query) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.max(1, Math.min(parseInt(query.limit, 10) || 50, 200));
  return { page, limit, skip: (page - 1) * limit };
};

exports.getAccruals = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const { page, limit, skip } = pageOptions(req.query);
    const query = { user: companyId };

    if (req.query.status) query.status = req.query.status;
    if (req.query.year) {
      const year = parseInt(req.query.year, 10);
      if (!Number.isNaN(year)) {
        query.date = {
          $gte: new Date(Date.UTC(year, 0, 1)),
          $lte: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999)),
        };
      }
    }

    const total = await AccrualEntry.countDocuments(query);
    const data = await AccrualEntry.find(query)
      .populate('category', 'name')
      .sort({ date: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({ data, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    console.error('Error fetching accruals:', error);
    res.status(500).json({ message: 'Server error fetching accruals' });
  }
};

exports.createAccrual = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const { amount, description, date, category, status, notes } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ message: 'Amount must be a positive number' });
    }
    if (!description || !description.trim()) {
      return res.status(400).json({ message: 'Description is required' });
    }

    const accrual = await AccrualEntry.create({
      user: companyId,
      amount: Number(amount),
      description: description.trim(),
      date: date ? new Date(date) : new Date(),
      category: category || null,
      status: status || 'accrued',
      notes: notes || '',
      createdBy: req.user._id,
    });

    res.status(201).json(accrual);
  } catch (error) {
    console.error('Error creating accrual entry:', error);
    res.status(400).json({ message: error.message || 'Failed to create accrual entry' });
  }
};

exports.updateAccrual = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Accrual entry not found' });
    }

    const accrual = await AccrualEntry.findOneAndUpdate(
      { _id: req.params.id, user: companyId },
      { $set: req.body },
      { returnDocument: 'after', runValidators: true }
    );

    if (!accrual) return res.status(404).json({ message: 'Accrual entry not found' });
    res.json(accrual);
  } catch (error) {
    console.error('Error updating accrual entry:', error);
    res.status(400).json({ message: error.message || 'Failed to update accrual entry' });
  }
};

exports.deleteAccrual = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Accrual entry not found' });
    }

    const accrual = await AccrualEntry.findOneAndUpdate(
      { _id: req.params.id, user: companyId },
      { $set: { isDeleted: true, deletedAt: new Date() } }
    );

    if (!accrual) return res.status(404).json({ message: 'Accrual entry not found' });
    res.json({ message: 'Accrual entry deleted successfully' });
  } catch (error) {
    console.error('Error deleting accrual entry:', error);
    res.status(500).json({ message: 'Server error deleting accrual entry' });
  }
};
