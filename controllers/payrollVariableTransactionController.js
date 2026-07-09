const mongoose = require('mongoose');
const PayrollVariableTransaction = require('../models/PayrollVariableTransaction');
const Employee = require('../models/Employee');

// Fetch all transactions scoped to current user/company
exports.getTransactions = async (req, res) => {
  try {
    const { employee, status, month, year, payroll } = req.query;
    const filter = { user: req.user._id };

    if (employee && mongoose.Types.ObjectId.isValid(employee)) {
      filter.employee = employee;
    }
    if (status) {
      filter.status = status;
    }
    if (payroll) {
      filter.payroll = payroll === 'null' ? null : payroll;
    }

    if (month && year) {
      const m = Number(month);
      const y = Number(year);
      if (m >= 1 && m <= 12 && y > 2000) {
        filter.date = {
          $gte: new Date(y, m - 1, 1),
          $lt: new Date(y, m, 1),
        };
      }
    }

    const transactions = await PayrollVariableTransaction.find(filter)
      .populate('employee', 'firstName lastName employeeId')
      .sort({ date: -1 });

    res.json(transactions);
  } catch (error) {
    console.error('Error fetching variable transactions:', error);
    res.status(500).json({ message: 'Server error fetching variable transactions' });
  }
};

// Get single transaction
exports.getTransactionById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Transaction not found' });
    }
    const transaction = await PayrollVariableTransaction.findOne({
      _id: req.params.id,
      user: req.user._id,
    }).populate('employee', 'firstName lastName employeeId');

    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found' });
    }
    res.json(transaction);
  } catch (error) {
    console.error('Error fetching variable transaction:', error);
    res.status(500).json({ message: 'Server error fetching variable transaction' });
  }
};

// Create a transaction
exports.createTransaction = async (req, res) => {
  try {
    const { employee, paymentType, reference, client, quantity, rate, amount, remarks, status, date } = req.body;

    if (!employee || !mongoose.Types.ObjectId.isValid(employee)) {
      return res.status(400).json({ message: 'Valid employee ID is required' });
    }
    if (!paymentType || !amount) {
      return res.status(400).json({ message: 'paymentType and amount are required' });
    }

    // Verify employee belongs to user
    const empDoc = await Employee.findOne({ _id: employee, user: req.user._id });
    if (!empDoc) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const transaction = await PayrollVariableTransaction.create({
      user: req.user._id,
      employee,
      paymentType,
      reference,
      client,
      quantity: Number(quantity) || 1,
      rate: Number(rate) || 0,
      amount: Number(amount),
      remarks,
      status: status || 'approved',
      date: date ? new Date(date) : undefined,
    });

    res.status(201).json(transaction);
  } catch (error) {
    console.error('Error creating variable transaction:', error);
    res.status(500).json({ message: 'Server error creating variable transaction' });
  }
};

// Update a transaction
exports.updateTransaction = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    const tx = await PayrollVariableTransaction.findOne({ _id: id, user: req.user._id });
    if (!tx) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    if (tx.status === 'paid') {
      return res.status(400).json({ message: 'Paid transaction is locked and cannot be updated' });
    }

    const allowedUpdates = ['paymentType', 'reference', 'client', 'quantity', 'rate', 'amount', 'remarks', 'status', 'date'];
    allowedUpdates.forEach(field => {
      if (req.body[field] !== undefined) {
        if (field === 'quantity' || field === 'rate' || field === 'amount') {
          tx[field] = Number(req.body[field]);
        } else if (field === 'date') {
          tx[field] = new Date(req.body[field]);
        } else {
          tx[field] = req.body[field];
        }
      }
    });

    await tx.save();
    res.json(tx);
  } catch (error) {
    console.error('Error updating variable transaction:', error);
    res.status(500).json({ message: 'Server error updating variable transaction' });
  }
};

// Delete a transaction
exports.deleteTransaction = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    const tx = await PayrollVariableTransaction.findOne({ _id: id, user: req.user._id });
    if (!tx) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    if (tx.status === 'paid') {
      return res.status(400).json({ message: 'Paid transaction is locked and cannot be deleted' });
    }

    await PayrollVariableTransaction.deleteOne({ _id: id });
    res.json({ message: 'Transaction deleted successfully' });
  } catch (error) {
    console.error('Error deleting variable transaction:', error);
    res.status(500).json({ message: 'Server error deleting variable transaction' });
  }
};
