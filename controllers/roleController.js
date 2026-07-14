const mongoose = require('mongoose');
const Role = require('../models/Role');

exports.getRoles = async (req, res) => {
  try {
    let data = await Role.find({ user: req.user._id }).sort({ name: 1 }).lean();
    
    const defaultRoleTemplates = [
      {
        user: req.user._id,
        name: 'CONSULTANT',
        description: 'Part-time hourly consultant',
        employmentType: 'part-time',
        payType: 'hourly',
        useSalaryComponents: false,
        monthlyCTC: 0,
        hourlyRate: 20,
        pfEnabled: true,
        esiEnabled: true,
        ptEnabled: true,
        lwfEnabled: true,
        gratuityEnabled: true,
        includePfInCTC: false,
        includeGratuityInCTC: false,
        compensationModel: 'CONSULTANT',
        paymentBasis: 'HOUR',
      },
      {
        user: req.user._id,
        name: 'INTERN',
        description: 'Full-time intern with flat stipend',
        employmentType: 'full-time',
        payType: 'salaried',
        useSalaryComponents: false,
        monthlyCTC: 0,
        hourlyRate: 0,
        pfEnabled: false,
        esiEnabled: false,
        ptEnabled: false,
        lwfEnabled: false,
        gratuityEnabled: false,
        includePfInCTC: false,
        includeGratuityInCTC: false,
        compensationModel: 'SALARIED',
        paymentBasis: 'MONTHLY',
      },
      {
        user: req.user._id,
        name: 'EMPLOYEE',
        description: 'Full-time salaried employee with statutory benefits',
        employmentType: 'full-time',
        payType: 'salaried',
        useSalaryComponents: true,
        monthlyCTC: 0,
        hourlyRate: 0,
        pfEnabled: true,
        esiEnabled: true,
        ptEnabled: true,
        lwfEnabled: true,
        gratuityEnabled: true,
        includePfInCTC: false,
        includeGratuityInCTC: true,
        compensationModel: 'SALARIED',
        paymentBasis: 'MONTHLY',
      }
    ];

    const existingNames = new Set(data.map(r => r.name));
    const missingRoles = defaultRoleTemplates.filter(r => !existingNames.has(r.name));

    if (missingRoles.length > 0) {
      try {
        await Role.insertMany(missingRoles, { ordered: false });
      } catch (insertError) {
        // Ignore duplicate key errors from concurrent requests
        if (insertError.code !== 11000 && !(insertError.writeErrors && insertError.writeErrors.some(e => e.code === 11000))) {
          throw insertError;
        }
      }
      data = await Role.find({ user: req.user._id }).sort({ name: 1 }).lean();
    }
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching roles' });
  }
};

exports.getRoleById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Role not found' });
    }
    const role = await Role.findOne({ _id: req.params.id, user: req.user._id });
    if (!role) return res.status(404).json({ message: 'Role not found' });
    res.json(role);
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching role' });
  }
};

exports.createRole = async (req, res) => {
  try {
    const role = await Role.create({ ...req.body, user: req.user._id });
    res.status(201).json(role);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Role already exists' });
    }
    res.status(400).json({ message: error.message || 'Server error creating role' });
  }
};

exports.updateRole = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Role not found' });
    }
    const role = await Role.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: req.body },
      { returnDocument: 'after', runValidators: true }
    );
    if (!role) return res.status(404).json({ message: 'Role not found' });
    res.json(role);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Role already exists' });
    }
    res.status(400).json({ message: error.message || 'Server error updating role' });
  }
};

exports.deleteRole = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Role not found' });
    }
    
    // Check if any active employee is using this role
    const Employee = mongoose.model('Employee');
    const employeeWithRole = await Employee.findOne({ role: req.params.id, user: req.user._id }).lean();
    if (employeeWithRole) {
      return res.status(400).json({ message: 'Cannot delete role as it is assigned to one or more employees.' });
    }

    const role = await Role.findOneAndUpdate({ _id: req.params.id, user: req.user._id }, { $set: { isDeleted: true, deletedAt: new Date() } });
    if (!role) return res.status(404).json({ message: 'Role not found' });
    res.json({ message: 'Role deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error deleting role' });
  }
};
