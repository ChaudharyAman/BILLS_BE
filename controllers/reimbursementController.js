const ReimbursementClaim = require('../models/ReimbursementClaim');
const Employee = require('../models/Employee');
const mongoose = require('mongoose');

exports.getClaims = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const { employee, status, category } = req.query;
    const query = { user: companyId };

    if (employee && mongoose.Types.ObjectId.isValid(String(employee))) {
      query.employee = employee;
    }
    if (status) {
      query.status = status;
    }
    if (category) {
      query.category = category;
    }

    const claims = await ReimbursementClaim.find(query)
      .populate('employee', 'firstName lastName employeeId designation')
      .sort({ createdAt: -1 })
      .lean();

    res.json(claims);
  } catch (error) {
    console.error('Error fetching claims:', error);
    res.status(500).json({ message: 'Server error fetching claims' });
  }
};

exports.getClaimById = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Claim not found' });
    }

    const claim = await ReimbursementClaim.findOne({ _id: req.params.id, user: companyId })
      .populate('employee', 'firstName lastName employeeId designation');

    if (!claim) {
      return res.status(404).json({ message: 'Claim not found' });
    }

    res.json(claim);
  } catch (error) {
    console.error('Error fetching claim:', error);
    res.status(500).json({ message: 'Server error fetching claim' });
  }
};

exports.createClaim = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const { employee, category, amount, billUrl } = req.body;

    if (!employee || !mongoose.Types.ObjectId.isValid(String(employee))) {
      return res.status(400).json({ message: 'Valid employee ID is required' });
    }

    const emp = await Employee.findOne({ _id: employee, user: companyId });
    if (!emp) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    if (!['petrol', 'broadband', 'lta', 'medical', 'other'].includes(category)) {
      return res.status(400).json({ message: 'Invalid category' });
    }

    const amt = Number(amount);
    if (Number.isNaN(amt) || amt <= 0) {
      return res.status(400).json({ message: 'Amount must be a positive number' });
    }

    const claim = await ReimbursementClaim.create({
      user: companyId,
      employee,
      category,
      amount: amt,
      billUrl: billUrl || '',
      status: 'pending'
    });

    res.status(201).json(claim);
  } catch (error) {
    console.error('Error creating claim:', error);
    res.status(500).json({ message: 'Server error creating claim' });
  }
};

exports.updateClaimStatus = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const { status, approverRemarks } = req.body;
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status update' });
    }

    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Claim not found' });
    }

    const claim = await ReimbursementClaim.findOne({ _id: req.params.id, user: companyId });
    if (!claim) {
      return res.status(404).json({ message: 'Claim not found' });
    }

    claim.status = status;
    if (approverRemarks !== undefined) {
      claim.approverRemarks = approverRemarks;
    }
    await claim.save();

    res.json(claim);
  } catch (error) {
    console.error('Error updating claim status:', error);
    res.status(500).json({ message: 'Server error updating claim status' });
  }
};

exports.updateClaim = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const { category, amount, billUrl, status, approverRemarks } = req.body;
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Claim not found' });
    }

    const claim = await ReimbursementClaim.findOne({ _id: req.params.id, user: companyId });
    if (!claim) {
      return res.status(404).json({ message: 'Claim not found' });
    }

    if (category) {
      if (!['petrol', 'broadband', 'lta', 'medical', 'other'].includes(category)) {
        return res.status(400).json({ message: 'Invalid category' });
      }
      claim.category = category;
    }
    if (amount !== undefined) {
      const amt = Number(amount);
      if (Number.isNaN(amt) || amt <= 0) {
        return res.status(400).json({ message: 'Amount must be a positive number' });
      }
      claim.amount = amt;
    }
    if (billUrl !== undefined) claim.billUrl = billUrl;
    if (status && ['approved', 'rejected', 'pending'].includes(status)) claim.status = status;
    if (approverRemarks !== undefined) claim.approverRemarks = approverRemarks;

    await claim.save();
    res.json(claim);
  } catch (error) {
    console.error('Error updating claim:', error);
    res.status(500).json({ message: 'Server error updating claim' });
  }
};

exports.deleteClaim = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Claim not found' });
    }

    const claim = await ReimbursementClaim.findOneAndUpdate({ _id: req.params.id, user: companyId }, { $set: { isDeleted: true, deletedAt: new Date() } });
    if (!claim) {
      return res.status(404).json({ message: 'Claim not found' });
    }

    res.json({ message: 'Claim deleted successfully' });
  } catch (error) {
    console.error('Error deleting claim:', error);
    res.status(500).json({ message: 'Server error deleting claim' });
  }
};
