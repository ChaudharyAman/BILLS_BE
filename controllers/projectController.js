const mongoose = require('mongoose');
const Project = require('../models/Project');
const Client = require('../models/Client');
const Employee = require('../models/Employee');
const Income = require('../models/Income');
const Expense = require('../models/Expense');

const validateProjectRefs = async (body, userId) => {
  if (body.client) {
    if (!mongoose.Types.ObjectId.isValid(body.client)) throw Object.assign(new Error('Invalid client'), { statusCode: 400 });
    const client = await Client.findOne({ _id: body.client, user: userId });
    if (!client) throw Object.assign(new Error('Client not found'), { statusCode: 400 });
  }
  if (Array.isArray(body.team) && body.team.length > 0) {
    const validTeam = body.team.filter(id => mongoose.Types.ObjectId.isValid(id));
    const count = await Employee.countDocuments({ _id: { $in: validTeam }, user: userId });
    if (count !== validTeam.length) throw Object.assign(new Error('One or more team members were not found'), { statusCode: 400 });
    body.team = validTeam;
  }
};

exports.getProjects = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const skip = (page - 1) * limit;
    const query = { user: req.user._id };
    if (req.query.status) query.status = req.query.status;

    const total = await Project.countDocuments(query);
    const data = await Project.find(query)
      .populate('client', 'name')
      .populate('team', 'employeeId firstName lastName')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();
    res.json({ data, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching projects' });
  }
};

exports.createProject = async (req, res) => {
  try {
    const payload = { ...req.body, user: req.user._id };
    await validateProjectRefs(payload, req.user._id);
    const project = await Project.create(payload);
    res.status(201).json(project);
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ message: 'Project code already exists' });
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error creating project' });
  }
};

exports.updateProject = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Project not found' });
    const payload = { ...req.body };
    await validateProjectRefs(payload, req.user._id);
    const project = await Project.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: payload },
      { returnDocument: 'after', runValidators: true }
    ).populate('client', 'name').populate('team', 'employeeId firstName lastName');
    if (!project) return res.status(404).json({ message: 'Project not found' });
    res.json(project);
  } catch (error) {
    if (error.code === 11000) return res.status(400).json({ message: 'Project code already exists' });
    res.status(error.statusCode || 500).json({ message: error.message || 'Server error updating project' });
  }
};

exports.deleteProject = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Project not found' });
    const inUse = await Promise.all([
      Income.exists({ user: req.user._id, project: req.params.id }),
      Expense.exists({ user: req.user._id, project: req.params.id }),
    ]);
    if (inUse.some(Boolean)) return res.status(400).json({ message: 'Cannot delete a project with transactions' });
    const project = await Project.findOneAndDelete({ _id: req.params.id, user: req.user._id });
    if (!project) return res.status(404).json({ message: 'Project not found' });
    res.json({ message: 'Project deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error deleting project' });
  }
};

exports.getProjectSummary = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: 'Project not found' });
    const project = await Project.findOne({ _id: req.params.id, user: req.user._id });
    if (!project) return res.status(404).json({ message: 'Project not found' });

    const [incomeAgg, expenseAgg] = await Promise.all([
      Income.aggregate([{ $match: { user: req.user._id, project: project._id } }, { $group: { _id: null, total: { $sum: '$grandTotal' } } }]),
      Expense.aggregate([{ $match: { user: req.user._id, project: project._id } }, { $group: { _id: null, total: { $sum: '$grandTotal' } } }]),
    ]);
    const totalIncome = incomeAgg[0]?.total || 0;
    const totalExpenses = expenseAgg[0]?.total || 0;
    const budgetUtilisationPct = project.budget > 0 ? Math.round((totalExpenses / project.budget) * 100) : 0;
    res.json({ project, totalIncome, totalExpenses, netProfit: totalIncome - totalExpenses, budgetUtilisationPct });
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching project summary' });
  }
};
