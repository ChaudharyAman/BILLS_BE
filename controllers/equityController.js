const mongoose = require('mongoose');
const EquityTransaction = require('../models/EquityTransaction');
const { recordCashMovement, roundTwo } = require('../utils/cashLedgerHelper');

const pageOptions = (query) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.max(1, Math.min(parseInt(query.limit, 10) || 20, 100));
  return { page, limit, skip: (page - 1) * limit };
};

const VALID_EQUITY_TYPES = [
  'share_issuance',
  'owner_contribution',
  'owner_distribution',
  'opening_equity_balance',
  'accountant_adjustment',
  'common_stock_issued',
  'additional_paid_in_capital',
  'capital_withdrawal',
  'retained_earnings_adjustment',
];

exports.getEquityTransactions = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const { page, limit, skip } = pageOptions(req.query);
    const query = { user: companyId, isDeleted: { $ne: true } };

    if (req.query.type) {
      query.type = req.query.type;
    }

    const total = await EquityTransaction.countDocuments(query);
    const data = await EquityTransaction.find(query)
      .sort({ date: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({ data, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    console.error('Error fetching equity transactions:', error);
    res.status(500).json({ message: 'Server error fetching equity transactions' });
  }
};

exports.createEquityTransaction = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const {
      type,
      amount,
      shares,
      pricePerShare,
      parValue,
      date,
      notes,
      postToCash = true,
    } = req.body;

    if (!type || !VALID_EQUITY_TYPES.includes(type)) {
      return res.status(400).json({ message: 'Invalid equity transaction type' });
    }

    let numAmount = Number(amount);
    const numShares = Number(shares) > 0 ? Number(shares) : 0;
    const numPrice = Number(pricePerShare) > 0 ? Number(pricePerShare) : 0;
    const numPar = Number(parValue) > 0 ? Number(parValue) : 0;

    let commonStockAmount = 0;
    let apicAmount = 0;

    if (type === 'share_issuance') {
      if (numShares > 0 && numPrice > 0) {
        numAmount = roundTwo(numShares * numPrice);
      }
      if (!Number.isFinite(numAmount) || numAmount <= 0) {
        return res.status(400).json({ message: 'Valid proceeds amount or shares & price per share required' });
      }

      if (numPar > 0 && numShares > 0) {
        commonStockAmount = roundTwo(Math.min(numAmount, numShares * numPar));
        apicAmount = roundTwo(Math.max(0, numAmount - commonStockAmount));
      } else {
        commonStockAmount = roundTwo(numAmount);
        apicAmount = 0;
      }
    } else if (type === 'owner_contribution' || type === 'common_stock_issued' || type === 'opening_equity_balance') {
      if (!Number.isFinite(numAmount) || numAmount <= 0) {
        return res.status(400).json({ message: 'Amount must be a positive number' });
      }
      commonStockAmount = roundTwo(numAmount);
      apicAmount = 0;
    } else if (type === 'additional_paid_in_capital') {
      if (!Number.isFinite(numAmount) || numAmount <= 0) {
        return res.status(400).json({ message: 'Amount must be a positive number' });
      }
      commonStockAmount = 0;
      apicAmount = roundTwo(numAmount);
    } else {
      // Distributions / Adjustments
      if (!Number.isFinite(numAmount) || numAmount <= 0) {
        return res.status(400).json({ message: 'Amount must be a positive number' });
      }
    }

    const transactionDate = date ? new Date(date) : new Date();
    if (Number.isNaN(transactionDate.getTime())) {
      return res.status(400).json({ message: 'Invalid date provided' });
    }

    // Withdrawal warning check
    let warning = null;
    if (type === 'owner_distribution' || type === 'capital_withdrawal') {
      const priorContributions = await EquityTransaction.aggregate([
        {
          $match: {
            user: new mongoose.Types.ObjectId(companyId),
            isDeleted: { $ne: true },
            type: { $in: ['share_issuance', 'owner_contribution', 'opening_equity_balance', 'common_stock_issued', 'additional_paid_in_capital'] },
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]);
      const totalContributed = priorContributions[0]?.total || 0;
      if (numAmount > totalContributed) {
        warning = `Distribution amount (₹${numAmount}) exceeds cumulative equity contributions to date (₹${totalContributed}).`;
      }
    }

    const equityTx = await EquityTransaction.create({
      user: companyId,
      type,
      amount: roundTwo(numAmount),
      shares: numShares,
      pricePerShare: numPrice,
      parValue: numPar,
      commonStockAmount,
      apicAmount,
      date: transactionDate,
      notes: notes ? String(notes).trim() : '',
      createdBy: req.user._id,
    });

    // Optionally record linked cash movement for capital contributions/withdrawals
    if (postToCash) {
      if (['share_issuance', 'owner_contribution', 'opening_equity_balance', 'common_stock_issued', 'additional_paid_in_capital'].includes(type)) {
        await recordCashMovement({
          user: companyId,
          amount: roundTwo(numAmount),
          date: transactionDate,
          type: 'capital_contribution',
          sourceModel: 'EquityTransaction',
          sourceId: equityTx._id,
          notes: notes || `Equity capital contribution (${type.replace(/_/g, ' ')})`,
          createdBy: req.user._id,
        });
      } else if (['owner_distribution', 'capital_withdrawal'].includes(type)) {
        await recordCashMovement({
          user: companyId,
          amount: -roundTwo(numAmount),
          date: transactionDate,
          type: 'capital_withdrawal',
          sourceModel: 'EquityTransaction',
          sourceId: equityTx._id,
          notes: notes || 'Equity shareholder distribution',
          createdBy: req.user._id,
        });
      }
    }

    res.status(201).json({ ...equityTx.toObject(), warning });
  } catch (error) {
    console.error('Error creating equity transaction:', error);
    res.status(400).json({ message: error.message || 'Server error creating equity transaction' });
  }
};

exports.updateEquityTransaction = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Equity transaction not found' });
    }

    const equityTx = await EquityTransaction.findOne({
      _id: req.params.id,
      user: companyId,
      isDeleted: { $ne: true },
    });

    if (!equityTx) {
      return res.status(404).json({ message: 'Equity transaction not found' });
    }

    const updateFields = {};
    if (req.body.type) {
      if (!VALID_EQUITY_TYPES.includes(req.body.type)) {
        return res.status(400).json({ message: 'Invalid equity transaction type' });
      }
      updateFields.type = req.body.type;
    }

    if (req.body.amount !== undefined) {
      const numAmount = Number(req.body.amount);
      if (!Number.isFinite(numAmount) || numAmount <= 0) {
        return res.status(400).json({ message: 'Amount must be a positive number' });
      }
      updateFields.amount = roundTwo(numAmount);
    }

    if (req.body.shares !== undefined) {
      updateFields.shares = Number(req.body.shares) >= 0 ? Number(req.body.shares) : 0;
    }
    if (req.body.pricePerShare !== undefined) {
      updateFields.pricePerShare = Number(req.body.pricePerShare) >= 0 ? Number(req.body.pricePerShare) : 0;
    }
    if (req.body.parValue !== undefined) {
      updateFields.parValue = Number(req.body.parValue) >= 0 ? Number(req.body.parValue) : 0;
    }

    if (req.body.date !== undefined) {
      const parsedDate = new Date(req.body.date);
      if (Number.isNaN(parsedDate.getTime())) {
        return res.status(400).json({ message: 'Invalid date provided' });
      }
      updateFields.date = parsedDate;
    }

    if (req.body.notes !== undefined) {
      updateFields.notes = String(req.body.notes).trim();
    }

    const updated = await EquityTransaction.findOneAndUpdate(
      { _id: req.params.id, user: companyId },
      { $set: updateFields },
      { returnDocument: 'after' }
    );

    res.json(updated);
  } catch (error) {
    console.error('Error updating equity transaction:', error);
    res.status(400).json({ message: error.message || 'Server error updating equity transaction' });
  }
};

exports.deleteEquityTransaction = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Equity transaction not found' });
    }

    const equityTx = await EquityTransaction.findOneAndUpdate(
      { _id: req.params.id, user: companyId },
      { $set: { isDeleted: true, deletedAt: new Date() } },
      { returnDocument: 'after' }
    );

    if (!equityTx) {
      return res.status(404).json({ message: 'Equity transaction not found' });
    }

    res.json({ message: 'Equity transaction deleted successfully' });
  } catch (error) {
    console.error('Error deleting equity transaction:', error);
    res.status(500).json({ message: 'Server error deleting equity transaction' });
  }
};
