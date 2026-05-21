const mongoose = require('mongoose');
const Payroll = require('../models/Payroll');
const Employee = require('../models/Employee');
const Expense = require('../models/Expense');
const Category = require('../models/Category');
const Settings = require('../models/Settings');

const sumNamedAmounts = (items = []) => items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

const buildPayrollSnapshot = (employee, adjustments = {}) => {
  const salary = employee.salaryStructure || {};
  const employeeDeductions = employee.deductions || {};

  const earnings = {
    basic: Number(salary.basic) || 0,
    hra: Number(salary.hra) || 0,
    conveyance: Number(salary.conveyance) || 0,
    medicalAllowance: Number(salary.medicalAllowance) || 0,
    specialAllowance: Number(salary.specialAllowance) || 0,
    overtime: Number(adjustments.overtime) || 0,
    bonus: Number(adjustments.bonus) || 0,
    incentives: Number(adjustments.incentives) || 0,
    otherEarnings: adjustments.otherEarnings || [],
  };

  earnings.totalEarnings =
    earnings.basic +
    earnings.hra +
    earnings.conveyance +
    earnings.medicalAllowance +
    earnings.specialAllowance +
    earnings.overtime +
    earnings.bonus +
    earnings.incentives +
    sumNamedAmounts(earnings.otherEarnings);

  const deductions = {
    pf: (employeeDeductions.pf !== undefined && employeeDeductions.pf !== null && employeeDeductions.pf !== '')
      ? Number(employeeDeductions.pf)
      : earnings.basic * 0.12,
    esi: Number(employeeDeductions.esi) || 0,
    professionalTax: Number(employeeDeductions.professionalTax) || 0,
    tds: Number(employeeDeductions.tds) || 0,
    loanDeduction: Number(adjustments.loanDeduction) || 0,
    advanceDeduction: Number(adjustments.advanceDeduction) || 0,
    otherDeductions: adjustments.otherDeductions || [],
  };

  deductions.totalDeductions =
    deductions.pf +
    deductions.esi +
    deductions.professionalTax +
    deductions.tds +
    deductions.loanDeduction +
    deductions.advanceDeduction +
    sumNamedAmounts(deductions.otherDeductions);

  return {
    earnings,
    deductions,
    netSalary: earnings.totalEarnings - deductions.totalDeductions,
  };
};

const getPayrollCategory = async (userId) => {
  const payrollCategory = await Category.findOneAndUpdate(
    { user: userId, name: 'Payroll', type: 'expense' },
    {
      $setOnInsert: {
        user: userId,
        name: 'Payroll',
        type: 'expense',
        isSystem: true,
        color: '#2563eb',
        icon: 'FaUsers',
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return payrollCategory;
};

exports.processPayroll = async (req, res) => {
  try {
    const month = Number(req.body.month);
    const year = Number(req.body.year);
    const employeePayloads = Array.isArray(req.body.employees) ? req.body.employees : [];

    if (!month || !year || month < 1 || month > 12) {
      return res.status(400).json({ message: 'Valid month and year are required' });
    }
    if (employeePayloads.length === 0) {
      return res.status(400).json({ message: 'Select at least one employee to process payroll' });
    }

    const success = [];
    const errors = [];

    for (const payload of employeePayloads) {
      const employeeId = payload.employeeId || payload.employee;
      let employeeName = 'Unknown Employee';
      try {
        if (!mongoose.Types.ObjectId.isValid(employeeId)) {
          errors.push({ employeeId, error: 'Invalid employee ID format' });
          continue;
        }

        const employee = await Employee.findOne({ _id: employeeId, user: req.user._id });
        if (!employee) {
          errors.push({ employeeId, error: 'Employee not found' });
          continue;
        }
        
        employeeName = `${employee.firstName} ${employee.lastName}`;

        if (employee.status !== 'active') {
          errors.push({ employeeId, employeeName, error: 'Employee is inactive' });
          continue;
        }

        const existing = await Payroll.findOne({ user: req.user._id, employee: employeeId, month, year });
        if (existing) {
          errors.push({ employeeId, employeeName, error: 'Payroll already processed for this period' });
          continue;
        }

        const snapshot = buildPayrollSnapshot(employee, payload.adjustments || {});
        const payroll = await Payroll.create({
          user: req.user._id,
          employee: employee._id,
          month,
          year,
          earnings: snapshot.earnings,
          deductions: snapshot.deductions,
          workingDays: Number(payload.workingDays) || 26,
          presentDays: Number(payload.presentDays) || Number(payload.workingDays) || 26,
          paidLeaves: Number(payload.paidLeaves) || 0,
          unpaidLeaves: Number(payload.unpaidLeaves) || 0,
          netSalary: snapshot.netSalary,
          status: 'processed',
          notes: payload.notes || '',
        });

        success.push({
          payrollId: payroll._id,
          employeeId: employee._id,
          employeeName,
          netSalary: payroll.netSalary,
        });
      } catch (error) {
        console.error(`Error processing payroll for employee ${employeeId}:`, error);
        errors.push({ employeeId, employeeName, error: error.message });
      }
    }

    res.status(201).json({ success, errors });
  } catch (error) {
    console.error('Error processing payroll:', error);
    res.status(500).json({ message: 'Server error processing payroll' });
  }
};

exports.getPayrolls = async (req, res) => {
  try {
    const { month, year, status, employeeId } = req.query;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const skip = (page - 1) * limit;
    const query = { user: req.user._id };

    if (month) query.month = Number(month);
    if (year) query.year = Number(year);
    if (status) query.status = status;
    if (employeeId) query.employee = employeeId;

    const total = await Payroll.countDocuments(query);
    const payrolls = await Payroll.find(query)
      .populate({
        path: 'employee',
        select: 'employeeId firstName lastName designation department',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('expenseRef', 'expenseNumber date grandTotal')
      .sort({ year: -1, month: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({ data: payrolls, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (error) {
    console.error('Error fetching payrolls:', error);
    res.status(500).json({ message: 'Server error fetching payrolls' });
  }
};

exports.getPayrollById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    const payroll = await Payroll.findOne({ _id: req.params.id, user: req.user._id })
      .populate({
        path: 'employee',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('expenseRef', 'expenseNumber date grandTotal');

    if (!payroll) return res.status(404).json({ message: 'Payroll not found' });
    res.json(payroll);
  } catch (error) {
    console.error('Error fetching payroll:', error);
    res.status(500).json({ message: 'Server error fetching payroll' });
  }
};

exports.updatePayroll = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    const allowed = ['paymentDate', 'paymentMethod', 'transactionId', 'notes'];
    const updateData = {};
    allowed.forEach((field) => {
      if (req.body[field] !== undefined) updateData[field] = req.body[field];
    });

    const payroll = await Payroll.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: updateData },
      { returnDocument: 'after', runValidators: true }
    ).populate('employee', 'employeeId firstName lastName designation');

    if (!payroll) return res.status(404).json({ message: 'Payroll not found' });
    res.json(payroll);
  } catch (error) {
    console.error('Error updating payroll:', error);
    res.status(500).json({ message: 'Server error updating payroll' });
  }
};

exports.markPayrollAsPaid = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    const payroll = await Payroll.findOne({ _id: req.params.id, user: req.user._id }).populate('employee');
    if (!payroll) return res.status(404).json({ message: 'Payroll not found' });
    if (payroll.status === 'paid') return res.status(400).json({ message: 'Payroll is already paid' });

    const payrollCategory = await getPayrollCategory(req.user._id);
    const paymentDate = req.body.paymentDate || new Date();
    const employeeIdentifier = payroll.employee?.employeeId || payroll.employeeId || 'unknown';
    const expenseNumber = `PAY-${payroll.year}-${String(payroll.month).padStart(2, '0')}-${employeeIdentifier}`;
    let expense = null;
    if (payroll.expenseRef) {
      expense = await Expense.findOne({ _id: payroll.expenseRef, user: req.user._id });
    }

    if (!expense) {
      expense = await Expense.create({
        user: req.user._id,
        expenseNumber,
        category: payrollCategory._id,
        date: paymentDate,
        vendor: { name: `${payroll.employee?.firstName || ''} ${payroll.employee?.lastName || ''}`.trim() || 'Payroll Vendor' },
        paymentMethod: req.body.paymentMethod || 'Bank Transfer',
        items: [{
          name: `Salary - ${payroll.employee?.firstName || ''} ${payroll.employee?.lastName || ''}`.trim() || 'Payroll Salary',
          description: `${new Date(0, payroll.month - 1).toLocaleString('en-US', { month: 'long' })} ${payroll.year}`,
          qty: 1,
          rate: payroll.netSalary,
          taxRate: 0,
          taxAmount: 0,
          amount: payroll.netSalary,
        }],
        subTotal: payroll.netSalary,
        taxTotal: 0,
        grandTotal: payroll.netSalary,
        status: 'PAID',
        privateNotes: `Payroll ID: ${payroll._id}`,
      });
    }

    payroll.status = 'paid';
    payroll.paymentDate = paymentDate;
    payroll.paymentMethod = req.body.paymentMethod || payroll.paymentMethod || 'Bank Transfer';
    payroll.transactionId = req.body.transactionId || payroll.transactionId;
    payroll.expenseRef = expense._id;
    await payroll.save();

    res.json({ payroll, expense });
  } catch (error) {
    console.error('Error marking payroll as paid:', error);
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Payroll expense already exists' });
    }
    res.status(500).json({ message: 'Server error marking payroll as paid' });
  }
};

exports.generatePayslip = async (req, res) => {
  try {
    console.log(`Generating payslip for ID: ${req.params.id}, User: ${req.user._id}`);
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    const payroll = await Payroll.findOne({ _id: req.params.id, user: req.user._id })
      .populate({
        path: 'employee',
        populate: { path: 'department', select: 'name code' },
      });
    const settings = await Settings.findOne({ user: req.user._id }).lean();

    if (!payroll) {
      console.log(`Payroll ${req.params.id} not found for user ${req.user._id}`);
      return res.status(404).json({ message: 'Payroll not found' });
    }

    res.json({
      payslip: {
        employee: payroll.employee,
        period: {
          month: payroll.month,
          year: payroll.year,
          monthName: new Date(0, payroll.month - 1).toLocaleString('en-US', { month: 'long' }),
        },
        earnings: payroll.earnings,
        deductions: payroll.deductions,
        netSalary: payroll.netSalary,
        workingDays: payroll.workingDays,
        presentDays: payroll.presentDays,
        paidLeaves: payroll.paidLeaves,
        unpaidLeaves: payroll.unpaidLeaves,
        paymentMethod: payroll.paymentMethod,
        transactionId: payroll.transactionId,
        paymentDate: payroll.paymentDate,
        status: payroll.status,
        generatedAt: new Date(),
        company: settings ? {
          companyName: settings.companyName,
          contactName: settings.contactName,
          email: settings.email,
          phone: settings.phone,
          website: settings.website,
          gstin: settings.gstin,
          pan: settings.pan,
          logoUrl: settings.logoUrl,
          signatureUrl: settings.signatureUrl,
          address: settings.address,
        } : null,
      },
    });
  } catch (error) {
    console.error('Error generating payslip:', error);
    res.status(500).json({ message: 'Server error generating payslip' });
  }
};
