const mongoose = require('mongoose');
const Asset = require('../models/Asset');

const pageOptions = (query) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.max(1, Math.min(parseInt(query.limit, 10) || 20, 100));
  return { page, limit, skip: (page - 1) * limit };
};

exports.getAssets = async (req, res) => {
  try {
    const { page, limit, skip } = pageOptions(req.query);
    const query = { user: req.user._id };
    if (req.query.status) query.status = req.query.status;
    if (req.query.category) query.category = req.query.category;

    const total = await Asset.countDocuments(query);
    const data = await Asset.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({ data, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching assets' });
  }
};

exports.getAssetById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Asset not found' });
    const asset = await Asset.findOne({ _id: req.params.id, user: req.user._id });
    if (!asset) return res.status(404).json({ message: 'Asset not found' });
    res.json(asset);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching asset' });
  }
};

exports.createAsset = async (req, res) => {
  try {
    const asset = await Asset.create({ ...req.body, user: req.user._id });
    res.status(201).json(asset);
  } catch (error) {
    res.status(400).json({ message: error.message || 'Server error creating asset' });
  }
};

exports.updateAsset = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Asset not found' });
    const asset = await Asset.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: req.body },
      { returnDocument: 'after', runValidators: true }
    );
    if (!asset) return res.status(404).json({ message: 'Asset not found' });
    res.json(asset);
  } catch (error) {
    res.status(400).json({ message: error.message || 'Server error updating asset' });
  }
};

exports.deleteAsset = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Asset not found' });
    const asset = await Asset.findOneAndUpdate({ _id: req.params.id, user: req.user._id }, { $set: { isDeleted: true, deletedAt: new Date() } });
    if (!asset) return res.status(404).json({ message: 'Asset not found' });
    res.json({ message: 'Asset deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error deleting asset' });
  }
};
