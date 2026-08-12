const Loan = require('../models/Loan');
const Employee = require('../models/Employee');
const mongoose = require('mongoose');

exports.getLoans = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const { employee, status } = req.query;
    const query = { user: companyId };

    if (employee && mongoose.Types.ObjectId.isValid(String(employee))) {
      query.employee = employee;
    }
    if (status) {
      query.status = status;
    }

    const loans = await Loan.find(query)
      .populate('employee', 'firstName lastName employeeId designation')
      .sort({ createdAt: -1 })
      .lean();

    res.json(loans);
  } catch (error) {
    console.error('Error fetching loans:', error);
    res.status(500).json({ message: 'Server error fetching loans' });
  }
};

exports.getLoanById = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    const loan = await Loan.findOne({ _id: req.params.id, user: companyId })
      .populate('employee', 'firstName lastName employeeId designation');

    if (!loan) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    res.json(loan);
  } catch (error) {
    console.error('Error fetching loan:', error);
    res.status(500).json({ message: 'Server error fetching loan' });
  }
};

exports.createLoan = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const { employee, principalAmount, emiAmount, interestRate, status } = req.body;

    if (!employee || !mongoose.Types.ObjectId.isValid(String(employee))) {
      return res.status(400).json({ message: 'Valid employee ID is required' });
    }

    const emp = await Employee.findOne({ _id: employee, user: companyId });
    if (!emp) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const pAmt = Number(principalAmount);
    const eAmt = Number(emiAmount);
    if (Number.isNaN(pAmt) || pAmt <= 0 || Number.isNaN(eAmt) || eAmt <= 0) {
      return res.status(400).json({ message: 'Principal amount and EMI amount must be positive numbers' });
    }

    const loan = await Loan.create({
      user: companyId,
      employee,
      principalAmount: pAmt,
      emiAmount: eAmt,
      interestRate: Number(interestRate) || 0,
      remainingBalance: pAmt,
      status: status || 'pending_approval'
    });

    res.status(201).json(loan);
  } catch (error) {
    console.error('Error creating loan:', error);
    res.status(500).json({ message: 'Server error creating loan' });
  }
};

exports.updateLoanStatus = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const { status, approverRemarks } = req.body;
    if (!['active', 'rejected', 'closed'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status update' });
    }

    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    const loan = await Loan.findOne({ _id: req.params.id, user: companyId });
    if (!loan) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    loan.status = status;
    await loan.save();

    res.json(loan);
  } catch (error) {
    console.error('Error updating loan status:', error);
    res.status(500).json({ message: 'Server error updating loan status' });
  }
};

exports.deleteLoan = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    const loan = await Loan.findOneAndUpdate({ _id: req.params.id, user: companyId }, { $set: { isDeleted: true, deletedAt: new Date() } });
    if (!loan) {
      return res.status(404).json({ message: 'Loan not found' });
    }

    res.json({ message: 'Loan deleted successfully' });
  } catch (error) {
    console.error('Error deleting loan:', error);
    res.status(500).json({ message: 'Server error deleting loan' });
  }
};
