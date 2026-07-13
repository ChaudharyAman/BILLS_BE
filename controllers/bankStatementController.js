const mongoose = require('mongoose');
const BankStatement = require('../models/BankStatement');

// @desc    Get all bank statements (list view — without transactions array by default)
// @route   GET /api/bank-statements
// @access  Private
exports.getBankStatements = async (req, res) => {
  try {
    const includeTxns = req.query.includeTransactions === 'true';
    const query = BankStatement.find({ user: req.user._id });
    
    if (!includeTxns) {
      query.select('-transactions');
    }

    const statements = await query.sort({ createdAt: -1 }).lean();

    res.json({ data: statements });
  } catch (error) {
    console.error('Error fetching bank statements:', error);
    res.status(500).json({ message: 'Server Error fetching bank statements' });
  }
};

// @desc    Get single bank statement with all transactions
// @route   GET /api/bank-statements/:id
// @access  Private
exports.getBankStatementById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(404).json({ message: 'Bank statement not found' });

    const statement = await BankStatement.findOne({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!statement)
      return res.status(404).json({ message: 'Bank statement not found' });

    res.json(statement);
  } catch (error) {
    console.error('Error fetching bank statement:', error);
    res.status(500).json({ message: 'Server Error fetching bank statement' });
  }
};

// @desc    Save a parsed bank statement
// @route   POST /api/bank-statements
// @access  Private
exports.createBankStatement = async (req, res) => {
  try {
    const { fileName, label, transactions } = req.body;

    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ message: 'No transactions provided' });
    }

    if (!fileName) {
      return res.status(400).json({ message: 'File name is required' });
    }

    // Retrieve all existing transaction IDs for this user to check for duplicates
    const existingStatements = await BankStatement.find({ user: req.user._id }, 'transactions.txnId').lean();
    const existingTxnIds = new Set();
    existingStatements.forEach(s => {
      (s.transactions || []).forEach(t => {
        if (t.txnId) {
          existingTxnIds.add(t.txnId.trim());
        }
      });
    });

    const uniqueTransactions = [];
    const seenInUpload = new Set();
    let skippedDuplicateCount = 0;

    for (const t of transactions) {
      const txnIdClean = t.txnId ? String(t.txnId).trim() : '';
      if (txnIdClean) {
        if (existingTxnIds.has(txnIdClean) || seenInUpload.has(txnIdClean)) {
          skippedDuplicateCount++;
          continue;
        }
        seenInUpload.add(txnIdClean);
      }
      uniqueTransactions.push(t);
    }

    if (uniqueTransactions.length === 0) {
      return res.status(400).json({ 
        message: skippedDuplicateCount > 0 
          ? 'All transactions in this file have already been imported (duplicate transaction IDs).' 
          : 'No valid transactions found in the file.' 
      });
    }

    // Calculate summary stats on unique transactions
    let totalCredits = 0, totalDebits = 0;
    const dates = [];

    for (const t of uniqueTransactions) {
      totalCredits += Number(t.credit) || 0;
      totalDebits += Number(t.debit) || 0;
      if (t.date) dates.push(new Date(t.date));
    }

    dates.sort((a, b) => a - b);
    const openingBalance = uniqueTransactions[0]?.balance || 0;
    const closingBalance = uniqueTransactions[uniqueTransactions.length - 1]?.balance || 0;

    const statement = await BankStatement.create({
      user: req.user._id,
      fileName,
      label: label || fileName,
      totalCredits,
      totalDebits,
      netFlow: totalCredits - totalDebits,
      txnCount: uniqueTransactions.length,
      openingBalance,
      closingBalance,
      dateFrom: dates[0] || new Date(),
      dateTo: dates[dates.length - 1] || new Date(),
      transactions: uniqueTransactions.map(t => ({
        date: t.date,
        description: t.description || '',
        debit: Number(t.debit) || 0,
        credit: Number(t.credit) || 0,
        balance: Number(t.balance) || 0,
        category: (t.category === undefined || t.category === null) ? 'Other' : t.category,
        txnId: t.txnId || '',
      })),
    });


    // Return without the full transactions array (just the summary)
    const result = statement.toObject();
    delete result.transactions;

    res.status(201).json(result);
  } catch (error) {
    console.error('Error creating bank statement:', error);
    res.status(500).json({ message: 'Server Error saving bank statement' });
  }
};

// @desc    Delete a bank statement
// @route   DELETE /api/bank-statements/:id
// @access  Private
exports.deleteBankStatement = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id))
      return res.status(404).json({ message: 'Bank statement not found' });

    const statement = await BankStatement.findOne({
      _id: req.params.id,
      user: req.user._id,
    });

    if (!statement)
      return res.status(404).json({ message: 'Bank statement not found' });

    await BankStatement.updateOne({ _id: statement._id }, { $set: { isDeleted: true, deletedAt: new Date() } });

    res.json({ message: 'Bank statement deleted' });
  } catch (error) {
    console.error('Error deleting bank statement:', error);
    res.status(500).json({ message: 'Server Error deleting bank statement' });
  }
};
