const mongoose = require('mongoose');
const Liability = require('../models/Liability');

const pageOptions = (query) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.max(1, Math.min(parseInt(query.limit, 10) || 20, 100));
  return { page, limit, skip: (page - 1) * limit };
};

exports.getLiabilities = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const { page, limit, skip } = pageOptions(req.query);
    const query = { user: companyId };
    if (req.query.status) query.status = req.query.status;
    if (req.query.type) query.type = req.query.type;
    if (req.query.category) query.category = req.query.category;

    const total = await Liability.countDocuments(query);
    const data = await Liability.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({ data, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching liabilities' });
  }
};

exports.getLiabilityById = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Liability not found' });
    const liability = await Liability.findOne({ _id: req.params.id, user: companyId });
    if (!liability) return res.status(404).json({ message: 'Liability not found' });
    res.json(liability);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching liability' });
  }
};

exports.createLiability = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const liability = await Liability.create({ ...req.body, user: companyId });
    res.status(201).json(liability);
  } catch (error) {
    res.status(400).json({ message: error.message || 'Server error creating liability' });
  }
};

exports.updateLiability = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Liability not found' });
    const liability = await Liability.findOneAndUpdate(
      { _id: req.params.id, user: companyId },
      { $set: req.body },
      { returnDocument: 'after', runValidators: true }
    );
    if (!liability) return res.status(404).json({ message: 'Liability not found' });
    res.json(liability);
  } catch (error) {
    res.status(400).json({ message: error.message || 'Server error updating liability' });
  }
};

exports.deleteLiability = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Liability not found' });
    const liability = await Liability.findOneAndUpdate({ _id: req.params.id, user: companyId }, { $set: { isDeleted: true, deletedAt: new Date() } });
    if (!liability) return res.status(404).json({ message: 'Liability not found' });
    res.json({ message: 'Liability deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error deleting liability' });
  }
};
