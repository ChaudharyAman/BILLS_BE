/**
 * controllers/payroll/config.js
 *
 * Payroll configuration management, salary calculation calculator preview, and compensation type listings.
 */

const PayrollConfig = require('../../models/PayrollConfig');
const { roundAmount, buildMasterSalaryStructure, buildPayrollSnapshot } = require('../../utils/payrollMath');
const { getOrCreateConfig } = require('./common');

const getPayrollConfig = async (req, res) => {
  try {
    const config = await getOrCreateConfig(req.user._id);
    res.json(config);
  } catch (error) {
    console.error('Error fetching payroll config:', error);
    res.status(500).json({ message: 'Server error fetching payroll config' });
  }
};

const updatePayrollConfig = async (req, res) => {
  try {
    if (req.body.salaryComponents !== undefined) {
      const components = Array.isArray(req.body.salaryComponents) ? req.body.salaryComponents : [];
      
      const remainderComps = components.filter(c => c.linkedTo === 'remainder');
      if (remainderComps.length > 1) {
        return res.status(400).json({
          message: `Only one salary component can be linked to 'Remainder'. Found: ${remainderComps.map(c => c.name || 'Unnamed').join(', ')}`
        });
      }

      const names = new Set();
      for (const c of components) {
        const trimmedName = (c.name || '').trim();
        if (!trimmedName) {
          return res.status(400).json({ message: 'Component name cannot be empty' });
        }
        const lowerName = trimmedName.toLowerCase();
        if (names.has(lowerName)) {
          return res.status(400).json({ message: `Component name "${trimmedName}" is duplicated. All component names must be unique.` });
        }
        names.add(lowerName);
      }

      const hasBasic = components.some(c => c.id === 'basic');
      const hasHra = components.some(c => c.id === 'hra');
      if (!hasBasic || !hasHra) {
        return res.status(400).json({ message: 'Basic Salary and HRA are core components and must be present.' });
      }
    }

    const allowed = [
      'basicPercent', 'hraPercent', 'pfRate', 'pfCap', 'pfEmployerRate',
      'esiEmployeeRate', 'esiEmployerRate', 'esiBasicThreshold', 'lwfEmployer', 'lwfEmployee',
      'gratuityRate', 'defaultWorkingDays', 'defaultInsurance', 'ltaMaxPercent', 'salaryComponents',
      'pfCalculationType', 'pfAmountEmployee', 'pfAmountEmployer', 'standardMonthlyHours', 'compensationTypeDefaults',
    ];
    const update = {};
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    });

    const effectiveFromDate = req.body.effectiveFrom ? new Date(req.body.effectiveFrom) : new Date();
    const existingConfig = await getOrCreateConfig(req.user._id, effectiveFromDate);

    const isSameDate = existingConfig && existingConfig.effectiveFrom && 
      new Date(existingConfig.effectiveFrom).toISOString().slice(0, 10) === effectiveFromDate.toISOString().slice(0, 10);

    let config;
    if (isSameDate) {
      config = await PayrollConfig.findOneAndUpdate(
        { _id: existingConfig._id },
        { $set: update },
        { new: true }
      );
    } else {
      const mergedData = {
        ...existingConfig.toObject(),
        ...update,
        _id: undefined,
        createdAt: undefined,
        updatedAt: undefined,
        user: req.user._id,
        effectiveFrom: effectiveFromDate,
      };
      config = await PayrollConfig.create(mergedData);
    }
    res.json(config);
  } catch (error) {
    console.error('Error updating payroll config:', error);
    res.status(500).json({ message: 'Server error updating payroll config' });
  }
};

const calculateSalary = async (req, res) => {
  try {
    const config = await getOrCreateConfig(req.user._id);
    let monthlyCTC = Number(req.body.monthlyCTC) || (Number(req.body.annualCTC) ? Number(req.body.annualCTC) / 12 : 0);
    const payType = req.body.payType || 'salaried';
    const hourlyRate = Number(req.body.hourlyRate) || 0;
    const hoursWorked = req.body.hoursWorked !== undefined ? Number(req.body.hoursWorked) : 160;
    const { resolveStrategy, resolveCompensationType } = require('../../utils/payrollStrategies');
    const effectiveCompType = resolveCompensationType(req.body);
    const strategyMeta = resolveStrategy(effectiveCompType);
    const usesComponents = strategyMeta.usesSalaryComponents !== false;

    if (effectiveCompType === 'hourly') {
      monthlyCTC = hourlyRate * hoursWorked;
    }

    const previewSource = {
      ...req.body,
      monthlyCTC,
      payType,
      compensationType: effectiveCompType,
      hourlyRate,
      hoursWorked,
      employmentType: req.body.employmentType,
      compensationModel: req.body.compensationModel || 'SALARIED',
      paymentBasis: req.body.paymentBasis || 'MONTHLY',
      useSalaryComponents: req.body.useSalaryComponents !== false && usesComponents,
      basicPercent: req.body.basicPercent !== undefined && req.body.basicPercent !== null ? Number(req.body.basicPercent) : null,
      hraPercent: req.body.hraPercent !== undefined && req.body.hraPercent !== null ? Number(req.body.hraPercent) : null,
      basic: req.body.basic !== undefined ? Number(req.body.basic) : undefined,
      hra: req.body.hra !== undefined ? Number(req.body.hra) : undefined,
      specialAllowance: req.body.specialAllowance !== undefined ? Number(req.body.specialAllowance) : undefined,
      flexiAmount: Number(req.body.flexiAmount) || 0,
      broadband: Number(req.body.broadband) || 0,
      petrol: Number(req.body.petrol) || 0,
      lta: Number(req.body.lta) || 0,
      employerNPS: Number(req.body.employerNPS) || 0,
      insuranceAmount: req.body.insuranceAmount !== undefined ? Number(req.body.insuranceAmount) : config.defaultInsurance,
      taxRegime: req.body.taxRegime || 'new',
      pfEnabled: !usesComponents ? false : req.body.pfEnabled !== false,
      esiEnabled: !usesComponents ? false : req.body.esiEnabled !== false,
      ptEnabled: !usesComponents ? false : req.body.ptEnabled !== false,
      lwfEnabled: !usesComponents ? false : req.body.lwfEnabled !== false,
      gratuityEnabled: !usesComponents ? false : req.body.gratuityEnabled !== false,
      includePfInCTC: !usesComponents ? false : req.body.includePfInCTC === true,
      includeGratuityInCTC: !usesComponents ? false : req.body.includeGratuityInCTC !== false,
      declarations: req.body.declarations || {},
      deductions: {
        professionalTax: !usesComponents ? 0 : (Number(req.body.professionalTax) || 0),
        tds: Number(req.body.tds) || 0,
        otherDeductions: Array.isArray(req.body.otherDeductions) ? req.body.otherDeductions : (Array.isArray(req.body.deductions?.otherDeductions) ? req.body.deductions.otherDeductions : []),
      },
      salaryStructure: {
        conveyance: Number(req.body.conveyance) || 0,
        medicalAllowance: Number(req.body.medicalAllowance) || 0,
        otherAllowances: Array.isArray(req.body.otherAllowances) ? req.body.otherAllowances : (Array.isArray(req.body.salaryStructure?.otherAllowances) ? req.body.salaryStructure.otherAllowances : []),
      },
    };

    Object.keys(req.body).forEach(key => {
      if (key.endsWith('Percent') && !['basicPercent', 'hraPercent'].includes(key)) {
        previewSource[key] = req.body[key] === null || req.body[key] === '' ? null : Number(req.body[key]);
      }
    });

    const master = buildMasterSalaryStructure(previewSource, config);
    const month = Number(req.body.month) || (new Date().getMonth() + 1);
    const year = Number(req.body.year) || new Date().getFullYear();
    const snapshot = buildPayrollSnapshot(
      previewSource,
      config,
      { workingDays: config.defaultWorkingDays, paidDays: config.defaultWorkingDays, paidLeaves: 0, unpaidLeaves: 0 },
      {
        joiningBonus: Number(req.body.joiningBonus) || 0,
        loyaltyBonus: Number(req.body.loyaltyBonus) || 0,
        incentive: Number(req.body.incentive) || 0,
        specialBonus: Number(req.body.specialBonus) || 0,
        otherAllowanceArrear: Number(req.body.otherAllowanceArrear) || 0,
        tds: Number(req.body.tds) || 0,
        performanceBonus: Number(req.body.performanceBonus) || 0,
        retentionBonus: Number(req.body.retentionBonus) || 0,
        arrear: Number(req.body.arrear) || 0,
        referralBonus: Number(req.body.referralBonus) || 0,
      },
      month,
      year
    );

    res.json({
      monthlyCTC: master.monthlyCTC,
      annualCTC: roundAmount(master.monthlyCTC * 12),
      master,
      payroll: snapshot,
      annualized: {
        earnings: Object.fromEntries(Object.entries(snapshot.earnings).map(([key, value]) => [key, typeof value === 'number' ? roundAmount(value * 12) : value])),
        employerContributions: Object.fromEntries(Object.entries(snapshot.employerContributions).map(([key, value]) => [key, roundAmount((Number(value) || 0) * 12)])),
        deductions: Object.fromEntries(Object.entries(snapshot.deductions).map(([key, value]) => [key, typeof value === 'number' ? roundAmount(value * 12) : value])),
        netSalary: roundAmount(snapshot.netSalary * 12),
      },
    });
  } catch (error) {
    console.error('Error calculating salary:', error);
    res.status(500).json({ message: 'Server error calculating salary' });
  }
};

const getCompensationTypes = async (req, res) => {
  try {
    const { listCompensationTypes } = require('../../utils/payrollStrategies/index');
    const types = listCompensationTypes();
    res.json(types);
  } catch (error) {
    console.error('Error fetching compensation types:', error);
    res.status(500).json({ message: 'Server error fetching compensation types' });
  }
};

module.exports = {
  getPayrollConfig,
  updatePayrollConfig,
  calculateSalary,
  getCompensationTypes,
};
