const mongoose = require('mongoose');
const Asset = require('../../models/Asset');
const Liability = require('../../models/Liability');

exports.getBalanceSheet = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(String(req.user._id));
    const [assets, liabilities] = await Promise.all([
      Asset.aggregate([
        { $match: { user: userId, status: 'active' } },
        { $group: { _id: '$category', total: { $sum: '$currentValue' } } },
        { $project: { _id: 0, category: '$_id', total: 1 } },
      ]),
      Liability.aggregate([
        { $match: { user: userId, status: 'active' } },
        { $group: { _id: '$type', total: { $sum: '$outstandingAmount' } } },
        { $project: { _id: 0, type: '$_id', total: 1 } },
      ]),
    ]);
    const totalAssets = assets.reduce((sum, item) => sum + item.total, 0);
    const totalLiabilities = liabilities.reduce((sum, item) => sum + item.total, 0);
    res.json({
      assets,
      totalAssets,
      liabilities,
      totalLiabilities,
      equity: totalAssets - totalLiabilities,
    });
  } catch (error) {
    console.error('Error building balance sheet:', error);
    res.status(500).json({ message: 'Server error building balance sheet' });
  }
};
