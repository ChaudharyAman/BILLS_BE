const mongoose = require('mongoose');
const PayrollComponent = require('../models/PayrollComponent');

exports.getPayrollComponents = async (req, res) => {
  try {
    const query = { user: req.user._id };
    if (req.query.type) query.type = req.query.type;
    const data = await PayrollComponent.find(query).sort({ type: 1, name: 1 }).lean();
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching payroll components' });
  }
};

exports.getPayrollComponentById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Payroll component not found' });
    const component = await PayrollComponent.findOne({ _id: req.params.id, user: req.user._id });
    if (!component) return res.status(404).json({ message: 'Payroll component not found' });
    res.json(component);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching payroll component' });
  }
};

exports.createPayrollComponent = async (req, res) => {
  try {
    const component = await PayrollComponent.create({ ...req.body, user: req.user._id });
    res.status(201).json(component);
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ message: 'Payroll component already exists' });
    res.status(400).json({ message: error.message || 'Server error creating payroll component' });
  }
};

exports.updatePayrollComponent = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Payroll component not found' });
    const component = await PayrollComponent.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: req.body },
      { returnDocument: 'after', runValidators: true }
    );
    if (!component) return res.status(404).json({ message: 'Payroll component not found' });
    res.json(component);
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ message: 'Payroll component already exists' });
    res.status(400).json({ message: error.message || 'Server error updating payroll component' });
  }
};

exports.deletePayrollComponent = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Payroll component not found' });
    const component = await PayrollComponent.findOneAndUpdate({ _id: req.params.id, user: req.user._id }, { $set: { isDeleted: true, deletedAt: new Date() } });
    if (!component) return res.status(404).json({ message: 'Payroll component not found' });
    res.json({ message: 'Payroll component deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error deleting payroll component' });
  }
};
