const mongoose = require('mongoose');
const Department = require('../models/Department');
const Employee = require('../models/Employee');
const { getTenantFilter, attachTenant } = require('../utils/tenantHelper');

const pickDepartmentFields = (body) => {
  const allowedFields = ['name', 'code', 'head', 'description', 'budget'];
  const payload = {};

  allowedFields.forEach((field) => {
    if (body[field] !== undefined) {
      payload[field] = body[field];
    }
  });

  return payload;
};

const validateHead = async (head, userId, req) => {
  if (!head) return null;

  if (!mongoose.Types.ObjectId.isValid(head)) {
    const error = new Error('Department head not found');
    error.statusCode = 404;
    throw error;
  }

  const filter = req ? { _id: head, ...getTenantFilter(req) } : { _id: head, user: userId };
  const employee = await Employee.findOne(filter).select('_id').lean();
  if (!employee) {
    const error = new Error('Department head not found');
    error.statusCode = 404;
    throw error;
  }

  return employee._id;
};

exports.getDepartments = async (req, res) => {
  try {
    const departments = await Department.find(getTenantFilter(req))
      .populate('head', 'employeeId firstName lastName')
      .sort({ name: 1 })
      .lean();

    res.json(departments);
  } catch (error) {
    console.error('Error fetching departments:', error);
    res.status(500).json({ message: 'Server error fetching departments' });
  }
};

exports.createDepartment = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const payload = pickDepartmentFields(req.body);
    payload.head = await validateHead(payload.head, companyId, req);

    const department = await Department.create(attachTenant(req, {
      ...payload,
      user: companyId,
    }));

    res.status(201).json(department);
  } catch (error) {
    console.error('Error creating department:', error);
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Department name or code already exists' });
    }
    res.status(500).json({ message: 'Server error creating department' });
  }
};

exports.updateDepartment = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Department not found' });
    }

    const payload = pickDepartmentFields(req.body);
    if (Object.prototype.hasOwnProperty.call(payload, 'head')) {
      payload.head = await validateHead(payload.head, companyId, req);
    }

    const department = await Department.findOneAndUpdate(
      { _id: req.params.id, ...getTenantFilter(req) },
      { $set: payload },
      { returnDocument: 'after', runValidators: true }
    ).populate('head', 'employeeId firstName lastName');

    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }

    res.json(department);
  } catch (error) {
    console.error('Error updating department:', error);
    if (error.statusCode) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Department name or code already exists' });
    }
    res.status(500).json({ message: 'Server error updating department' });
  }
};

exports.deleteDepartment = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Department not found' });
    }

    const tenantFilter = getTenantFilter(req);
    const hasEmployees = await Employee.exists({ ...tenantFilter, department: req.params.id });
    if (hasEmployees) {
      return res.status(400).json({ message: 'Cannot delete a department with employees. Reassign employees first.' });
    }

    const department = await Department.findOneAndUpdate({ _id: req.params.id, ...tenantFilter }, { $set: { isDeleted: true, deletedAt: new Date() } });
    if (!department) {
      return res.status(404).json({ message: 'Department not found' });
    }

    res.json({ message: 'Department deleted successfully' });
  } catch (error) {
    console.error('Error deleting department:', error);
    res.status(500).json({ message: 'Server error deleting department' });
  }
};
