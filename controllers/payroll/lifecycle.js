/**
 * controllers/payroll/lifecycle.js
 *
 * Payroll lifecycle management: status transitions, updates, payment execution, reopening, F&F settlement, querying.
 */

const mongoose = require('mongoose');
const Payroll = require('../../models/Payroll');
const Employee = require('../../models/Employee');
const Expense = require('../../models/Expense');
const Loan = require('../../models/Loan');
const AuditLog = require('../../models/AuditLog');
const { recordCashMovement } = require('../../utils/cashLedgerHelper');
const { runTransaction } = require('../../utils/withTransaction');
const { roundAmount, getSalarySplits, buildPayrollSnapshot, calculateGratuityEntitlement } = require('../../utils/payrollMath');
const { monthName, buildEmployeeName, isValidMonth, isValidYear, getOrCreateConfig, getPayrollCategory } = require('./common');

const getPayrolls = async (req, res) => {
  try {
    const { month, year, status, employeeId } = req.query;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const skip = (page - 1) * limit;
    const query = { user: req.user._id };

    if (month !== undefined) {
      const parsedMonth = Number(month);
      if (!isValidMonth(parsedMonth)) return res.status(400).json({ message: 'Invalid month' });
      query.month = parsedMonth;
    }
    if (year !== undefined) {
      const parsedYear = Number(year);
      if (!isValidYear(parsedYear)) return res.status(400).json({ message: 'Invalid year' });
      query.year = parsedYear;
    }
    if (status) query.status = status;
    if (employeeId) {
      if (!mongoose.Types.ObjectId.isValid(String(employeeId))) {
        return res.status(400).json({ message: 'Invalid employee ID' });
      }
      query.employee = employeeId;
    }
    if (req.query.search) {
      const escapeRegex = require('../../utils/escapeRegex');
      const safeSearch = escapeRegex(req.query.search);
      const matchedEmployees = await Employee.find({
        user: req.user._id,
        $or: [
          { firstName: { $regex: safeSearch, $options: 'i' } },
          { lastName: { $regex: safeSearch, $options: 'i' } },
          { employeeId: { $regex: safeSearch, $options: 'i' } }
        ]
      }).select('_id').lean();
      
      const matchedIds = matchedEmployees.map(e => e._id);
      if (query.employee) {
        if (!matchedIds.map(id => String(id)).includes(String(query.employee))) {
          query.employee = null;
        }
      } else {
        query.employee = { $in: matchedIds };
      }
    }

    const total = await Payroll.countDocuments(query);
    const payrolls = await Payroll.find(query)
      .populate({
        path: 'employee',
        select: 'employeeId firstName lastName designation department monthlyCTC location dateOfLeaving pfEnabled esiEnabled ptEnabled lwfEnabled gratuityEnabled basicPercent hraPercent payType hourlyRate compensationType payFrequency attendanceMode useSalaryComponents employmentType salaryRevisions',
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

const getPayrollById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    const payroll = await Payroll.findOne({ _id: req.params.id, user: req.user._id })
      .populate({
        path: 'employee',
        populate: { path: 'department', select: 'name code' },
      })
      .populate('expenseRef', 'expenseNumber date grandTotal');

    if (!payroll) return res.status(404).json({ message: 'Payroll not found' });

    const config = await getOrCreateConfig(req.user._id);
    const adjustments = {
      pfEnabled: payroll.employeeSnapshot?.pfEnabled,
      esiEnabled: payroll.employeeSnapshot?.esiEnabled,
      ptEnabled: payroll.employeeSnapshot?.ptEnabled,
      lwfEnabled: payroll.employeeSnapshot?.lwfEnabled,
      gratuityEnabled: payroll.employeeSnapshot?.gratuityEnabled,
      includePfInCTC: payroll.employeeSnapshot?.includePfInCTC,
      includeGratuityInCTC: payroll.employeeSnapshot?.includeGratuityInCTC,
      lopStrategy: payroll.lopStrategy || 'proportional',
      segmentLops: payroll.segmentLops || [],
    };
    const employeeData = payroll.employee || {
      ...payroll.employeeSnapshot,
      payType: payroll.payType,
      hourlyRate: payroll.hourlyRate,
      _id: payroll.populated('employee') || payroll.employee
    };
    const splits = getSalarySplits(
      employeeData,
      config,
      payroll.month,
      payroll.year,
      payroll.paidDays,
      payroll.workingDays,
      adjustments
    );

    const payrollObj = payroll.toObject();
    payrollObj.salarySplits = (payrollObj.salarySplits && payrollObj.salarySplits.length > 0) ? payrollObj.salarySplits : splits;
    if (!payrollObj.employee) {
      payrollObj.employee = employeeData;
    }

    res.json(payrollObj);
  } catch (error) {
    console.error('Error fetching payroll:', error);
    res.status(500).json({ message: 'Server error fetching payroll' });
  }
};

const updatePayroll = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    const payroll = await Payroll.findOne({ _id: req.params.id, user: req.user._id });
    if (!payroll) return res.status(404).json({ message: 'Payroll not found' });

    if (payroll.status === 'paid') {
      return res.status(400).json({ message: 'Paid payroll is locked and cannot be updated' });
    }
    if (payroll.status === 'approved') {
      const allowedFieldsForApproved = ['paymentMethod', 'transactionId', 'notes', 'remarks', 'status', 'paymentDate'];
      const fieldsToUpdate = Object.keys(req.body);
      const isTryingToEditRestrictedFields = fieldsToUpdate.some(f => !allowedFieldsForApproved.includes(f));
      if (isTryingToEditRestrictedFields) {
        return res.status(400).json({ message: 'Approved payroll is locked. Please re-open to edit calculations' });
      }
    }

    const allowed = ['paymentDate', 'paymentMethod', 'transactionId', 'notes', 'remarks', 'status'];
    const updateData = {};
    const oldStatus = payroll.status;

    allowed.forEach((field) => {
      if (req.body[field] !== undefined) {
        payroll[field] = req.body[field];
        updateData[field] = req.body[field];
      }
    });

    if (req.body.status && req.body.status !== oldStatus) {
      payroll.approvalWorkflow.push({
        status: req.body.status,
        actor: req.user._id,
        remarks: req.body.remarks || `Status transitioned to ${req.body.status}`
      });
    }

    await payroll.save();

    if (req.body.status && req.body.status !== oldStatus) {
      await Payroll.updateOne(
        { _id: payroll._id },
        { $push: { auditLog: {
          status: req.body.status,
          changedBy: req.user.name,
          changedById: req.user._id,
          changedAt: new Date(),
          netSalary: payroll.netSalary,
          notes: req.body.remarks || `Status transitioned to ${req.body.status}`
        }}}
      );
    }
    await payroll.populate('employee', 'employeeId firstName lastName designation');

    await AuditLog.create({
      user: req.user._id,
      actor: req.user._id,
      action: 'PAYROLL_UPDATED',
      targetEmployee: payroll.employee?._id || payroll.employee,
      targetPayroll: payroll._id,
      changes: updateData
    });

    res.json(payroll);
  } catch (error) {
    console.error('Error updating payroll:', error);
    res.status(500).json({ message: 'Server error updating payroll' });
  }
};

const markPayrollAsPaid = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    const payroll = await Payroll.findOne({ _id: req.params.id, user: req.user._id }).populate('employee');
    if (!payroll) return res.status(404).json({ message: 'Payroll not found' });
    if (payroll.status === 'paid') return res.status(400).json({ message: 'Payroll is already paid' });

    const config = await getOrCreateConfig(req.user._id, new Date(payroll.year, payroll.month - 1, 1));
    const reqApprovers = payroll.requiredApprovers && payroll.requiredApprovers.length > 0
      ? payroll.requiredApprovers
      : (config.requireDualApproval && Array.isArray(config.approverRoles) ? config.approverRoles.map(r => ({ role: r, approved: false })) : []);

    if (reqApprovers.length > 0) {
      const userRole = req.body.approverRole || (req.user.role?.name ? String(req.user.role.name) : 'finance');
      const targetApp = reqApprovers.find(a => !a.approved && (a.role.toLowerCase() === userRole.toLowerCase() || userRole.toLowerCase() === 'admin'));
      if (targetApp) {
        targetApp.approved = true;
        targetApp.approvedAt = new Date();
        targetApp.userId = req.user._id;
      }
      payroll.requiredApprovers = reqApprovers;
      const pending = reqApprovers.filter(a => !a.approved);
      if (pending.length > 0) {
        payroll.approvalWorkflow.push({
          status: 'pending_approval',
          actor: req.user._id,
          remarks: `Sign-off recorded for role '${targetApp ? targetApp.role : userRole}'. Pending remaining sign-off from: ${pending.map(p => p.role).join(', ')}`
        });
        await payroll.save();
        return res.json({
          message: `Approval recorded. Pending remaining sign-off from: ${pending.map(p => p.role).join(', ')}`,
          payroll,
          pendingApprovals: pending.map(p => p.role)
        });
      }
    }

    const payrollCategory = await getPayrollCategory(req.user._id);
    const paymentDate = req.body.paymentDate || new Date();
    const employeeIdentifier = payroll.employee?.employeeId || payroll.employeeSnapshot?.employeeId || (payroll.populated('employee') || payroll._id).toString();
    const expenseNumber = `PAY-${payroll.year}-${String(payroll.month).padStart(2, '0')}-${employeeIdentifier}`;
    let expense = null;
    await runTransaction(async (session) => {
      const sessionOpt = session ? { session } : {};

      if (payroll.expenseRef) {
        expense = await Expense.findOne({ _id: payroll.expenseRef, user: req.user._id }, null, sessionOpt);
      }

      if (!expense) {
        expense = await Expense.findOne({ user: req.user._id, expenseNumber }, null, sessionOpt);
      }

      if (!expense) {
        const createdExpenses = await Expense.create([{
          user: req.user._id,
          expenseNumber,
          category: payrollCategory._id,
          date: paymentDate,
          vendor: { name: buildEmployeeName(payroll.employee, payroll.employeeSnapshot) || 'Payroll Vendor' },
          paymentMethod: req.body.paymentMethod || 'Bank Transfer',
          items: [{
            name: `Salary - ${buildEmployeeName(payroll.employee, payroll.employeeSnapshot)}`.trim(),
            description: `${monthName(payroll.month)} ${payroll.year}`,
            qty: 1,
            rate: payroll.netSalary,
            taxRate: 0,
            taxAmount: 0,
            amount: payroll.netSalary,
          }],
          subTotal: payroll.netSalary,
          taxTotal: 0,
          grandTotal: payroll.netSalary,
          amountPaid: payroll.netSalary,
          balanceDue: 0,
          status: 'PAID',
          privateNotes: `Payroll ID: ${payroll._id}`,
        }], sessionOpt);
        expense = Array.isArray(createdExpenses) ? createdExpenses[0] : createdExpenses;
      }

      payroll.status = 'paid';
      payroll.paymentDate = paymentDate;
      payroll.paymentMethod = req.body.paymentMethod || payroll.paymentMethod || 'Bank Transfer';
      payroll.transactionId = req.body.transactionId || payroll.transactionId;
      payroll.expenseRef = expense._id;

      await recordCashMovement({
        user: req.user._id,
        amount: -payroll.netSalary,
        type: 'payroll_payment',
        sourceModel: 'Payroll',
        sourceId: payroll._id,
        date: paymentDate,
        notes: `Salary payout for ${buildEmployeeName(payroll.employee, payroll.employeeSnapshot)} (${monthName(payroll.month)} ${payroll.year})`,
        session,
      });

      payroll.approvalWorkflow.push({
        status: 'paid',
        actor: req.user._id,
        remarks: req.body.remarks || 'Payroll marked as paid and expense generated'
      });

      if (payroll.deductions?.loanDeduction > 0) {
        const activeLoans = await Loan.find({
          employee: payroll.employee?._id || payroll.populated('employee') || payroll.employee,
          user: req.user._id,
          status: 'active',
          remainingBalance: { $gt: 0 }
        }, null, sessionOpt).sort({ createdAt: 1 });

        let remainingDeduction = payroll.deductions.loanDeduction;
        for (const loan of activeLoans) {
          if (remainingDeduction <= 0) break;
          const repaymentAmount = Math.min(loan.remainingBalance, loan.emiAmount, remainingDeduction);
          if (repaymentAmount > 0) {
            loan.remainingBalance = Math.max(0, roundAmount(loan.remainingBalance - repaymentAmount));
            if (loan.remainingBalance === 0) {
              loan.status = 'closed';
            }
            loan.repaymentLedger.push({
              month: payroll.month,
              year: payroll.year,
              amountPaid: repaymentAmount,
              payrollRef: payroll._id
            });
            await loan.save(sessionOpt);
            remainingDeduction = roundAmount(remainingDeduction - repaymentAmount);
          }
        }
      }

      payroll.auditLog.push({
        status: 'paid',
        changedBy: req.user.name,
        changedById: req.user._id,
        changedAt: new Date(),
        netSalary: payroll.netSalary,
        notes: req.body.remarks || 'Payroll marked as paid and expense generated'
      });

      await payroll.save(sessionOpt);

      await AuditLog.create([{
        user: req.user._id,
        actor: req.user._id,
        action: 'PAYROLL_PAID',
        targetEmployee: payroll.employee?._id || payroll.populated('employee') || payroll.employee,
        targetPayroll: payroll._id,
        changes: { status: 'paid', paymentDate, expenseId: expense._id }
      }], sessionOpt);
    });

    // Background pre-generate and persist payslip PDF for fast re-downloads
    (async () => {
      try {
        const Settings = require('../../models/Settings');
        const { generateSinglePayslipPdf, getStoredPayslipPath } = require('../../services/pdfGeneratorService');
        const fs = require('fs');
        const settings = await Settings.findOne({ user: req.user._id }).lean();
        const pdfBuf = await generateSinglePayslipPdf({ payroll, settings });
        fs.writeFileSync(getStoredPayslipPath(payroll._id), pdfBuf);
      } catch (pdfErr) {
        console.error('Paid payroll PDF pre-generation error:', pdfErr.message);
      }
    })();

    // Reverse sync: notify HRMS of payroll result (fire-and-forget, non-blocking)
    (async () => {
      try {
        const Settings = require('../../models/Settings');
        const { dispatchPayrollResultToHrms } = require('../../services/hrmsSyncService');
        const settings = await Settings.findOne({ user: req.user._id }).lean();
        await dispatchPayrollResultToHrms(payroll, settings);
      } catch (dispatchErr) {
        console.error('Payroll result dispatch error:', dispatchErr.message);
      }
    })();

    res.json({ payroll, expense });
  } catch (error) {
    console.error('Error marking payroll as paid:', error);
    if (error.code === 11000) {
      try {
        const payroll = await Payroll.findOne({ _id: req.params.id, user: req.user._id });
        if (payroll && payroll.status !== 'paid') {
          const employeeIdentifier =
            payroll.employeeSnapshot?.employeeId ||
            payroll.employee?.toString() ||
            payroll._id.toString();
          const expenseNumber = `PAY-${payroll.year}-${String(payroll.month).padStart(2, '0')}-${employeeIdentifier}`;
          const expense = await Expense.findOne({ user: req.user._id, expenseNumber });
          if (expense) {
            payroll.status = 'paid';
            payroll.paymentDate = req.body.paymentDate || new Date();
            payroll.paymentMethod = req.body.paymentMethod || payroll.paymentMethod || 'Bank Transfer';
            payroll.transactionId = req.body.transactionId || payroll.transactionId;
            payroll.expenseRef = expense._id;

            payroll.approvalWorkflow.push({
              status: 'paid',
              actor: req.user._id,
              remarks: req.body.remarks || 'Payroll marked as paid and expense generated (recovered)'
            });

            if (payroll.deductions?.loanDeduction > 0) {
              const activeLoans = await Loan.find({
                employee: payroll.employee?._id || payroll.populated('employee') || payroll.employee,
                user: req.user._id,
                status: 'active',
                remainingBalance: { $gt: 0 }
              }).sort({ createdAt: 1 });

              let remainingDeduction = payroll.deductions.loanDeduction;
              for (const loan of activeLoans) {
                if (remainingDeduction <= 0) break;
                const repaymentAmount = Math.min(loan.remainingBalance, loan.emiAmount, remainingDeduction);
                if (repaymentAmount > 0) {
                  loan.remainingBalance = Math.max(0, roundAmount(loan.remainingBalance - repaymentAmount));
                  if (loan.remainingBalance === 0) {
                    loan.status = 'closed';
                  }
                  loan.repaymentLedger.push({
                    month: payroll.month,
                    year: payroll.year,
                    amountPaid: repaymentAmount,
                    payrollRef: payroll._id
                  });
                  await loan.save();
                  remainingDeduction = roundAmount(remainingDeduction - repaymentAmount);
                }
              }
            }

            await payroll.save();

            await Payroll.updateOne(
              { _id: payroll._id },
              { $push: { auditLog: {
                status: 'paid',
                changedBy: req.user.name,
                changedById: req.user._id,
                changedAt: new Date(),
                netSalary: payroll.netSalary,
                notes: req.body.remarks || 'Payroll marked as paid and expense generated (recovered)'
              }}}
            );

            await AuditLog.create({
              user: req.user._id,
              actor: req.user._id,
              action: 'PAYROLL_PAID',
              targetEmployee: payroll.employee?._id || payroll.populated('employee') || payroll.employee,
              targetPayroll: payroll._id,
              changes: { status: 'paid', paymentDate: payroll.paymentDate, expenseId: expense._id }
            });

            return res.json({ payroll, expense });
          }
        }
      } catch (retryError) {
        console.error('Error in 11000 recovery:', retryError);
      }
      return res.status(409).json({ message: 'Payroll payment is already being processed. Please refresh and check the status.' });
    }
    res.status(500).json({ message: 'Server error marking payroll as paid' });
  }
};

const reopenPayroll = async (req, res) => {
  try {
    const { id } = req.params;
    const { remarks } = req.body;
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    const payroll = await Payroll.findOne({ _id: id, user: req.user._id });
    if (!payroll) return res.status(404).json({ message: 'Payroll not found' });

    if (payroll.status === 'paid') {
      return res.status(400).json({ message: 'Paid payroll cannot be re-opened' });
    }
    if (payroll.status !== 'approved') {
      return res.status(400).json({ message: 'Only approved payroll can be re-opened' });
    }

    const oldStatus = payroll.status;
    payroll.status = 'processed';
    payroll.approvalWorkflow.push({
      status: 'processed',
      actor: req.user._id,
      remarks: remarks || 'Payroll re-opened',
    });

    await payroll.save();

    await Payroll.updateOne(
      { _id: payroll._id },
      { $push: { auditLog: {
        status: 'processed',
        changedBy: req.user.name,
        changedById: req.user._id,
        changedAt: new Date(),
        netSalary: payroll.netSalary,
        notes: remarks || 'Payroll re-opened',
      }}}
    );

    await AuditLog.create({
      user: req.user._id,
      actor: req.user._id,
      action: 'PAYROLL_REOPENED',
      targetEmployee: payroll.employee,
      targetPayroll: payroll._id,
      changes: { from: oldStatus, to: 'processed', remarks },
    });

    res.json({ message: 'Payroll re-opened successfully', payroll });
  } catch (error) {
    console.error('Error re-opening payroll:', error);
    res.status(500).json({ message: 'Server error re-opening payroll' });
  }
};

const deletePayroll = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(id))) {
      return res.status(404).json({ message: 'Payroll not found' });
    }

    const payroll = await Payroll.findOne({ _id: id, user: req.user._id });
    if (!payroll) return res.status(404).json({ message: 'Payroll not found' });

    if (payroll.status === 'paid') {
      return res.status(400).json({ message: 'Paid payroll is locked and cannot be deleted' });
    }

    if (payroll.expenseRef) {
      await Expense.updateOne({ _id: payroll.expenseRef, user: req.user._id }, { $set: { isDeleted: true, deletedAt: new Date() } });
    }

    const PayrollVariableTransaction = require('../../models/PayrollVariableTransaction');
    await PayrollVariableTransaction.updateMany(
      { payroll: id, user: req.user._id },
      { $set: { status: 'approved', payroll: null } }
    );

    await Payroll.updateOne({ _id: id, user: req.user._id }, { $set: { isDeleted: true, deletedAt: new Date() } });

    await AuditLog.create({
      user: req.user._id,
      actor: req.user._id,
      action: 'PAYROLL_DELETED',
      targetEmployee: payroll.employee,
      changes: { month: payroll.month, year: payroll.year, netSalary: payroll.netSalary }
    });

    res.json({ message: 'Payroll deleted successfully' });
  } catch (error) {
    console.error('Error deleting payroll:', error);
    res.status(500).json({ message: 'Server error deleting payroll' });
  }
};

const processFullAndFinalSettlement = async (req, res) => {
  try {
    const {
      employeeId,
      lastWorkingDay,
      noticePeriodServedDays = 0,
      noticePeriodRequiredDays = 0,
      leaveEncashmentDays = 0,
      comments = '',
      // Period-specific inputs for variable-compensation employees in their final period.
      // Hourly / timesheet_based: actual hours worked (not the stale employee.hoursWorked field).
      // Piece-rate: units produced and optional rate override for the final period.
      hoursWorked,
      unitsProduced,
      ratePerUnit,
    } = req.body;

    if (!employeeId || !lastWorkingDay) {
      return res.status(400).json({ message: 'employeeId and lastWorkingDay are required' });
    }

    const employee = await Employee.findOne({ _id: employeeId, user: req.user._id });
    if (!employee) return res.status(404).json({ message: 'Employee not found' });

    const exitDate = new Date(lastWorkingDay);
    const month = exitDate.getUTCMonth() + 1;
    const year = exitDate.getUTCFullYear();

    const config = await getOrCreateConfig(req.user._id);

    const joiningDate = employee.joiningDate ? new Date(employee.joiningDate) : exitDate;
    const basicSalary = Number(employee.salaryStructure?.basic) || (Number(employee.monthlyCTC) * 0.5) || 0;
    const gratuityResult = calculateGratuityEntitlement(joiningDate, exitDate, basicSalary);
    const tenureYears = gratuityResult.completedYears + ((gratuityResult.completedMonths % 12) / 12);
    const gratuityPayout = (employee.gratuityEnabled !== false && gratuityResult.eligible) ? gratuityResult.cappedEntitlement : 0;

    let noticeShortfallDeduction = 0;
    const reqNotice = Number(noticePeriodRequiredDays) || 0;
    const srvNotice = Number(noticePeriodServedDays) || 0;
    if (reqNotice > srvNotice) {
      const dailyRate = (Number(employee.monthlyCTC) || 0) / 30;
      noticeShortfallDeduction = roundAmount((reqNotice - srvNotice) * dailyRate);
    }

    let leaveEncashmentAmount = 0;
    const encashDays = Number(leaveEncashmentDays) || 0;
    if (encashDays > 0) {
      const basicDailyRate = (Number(employee.salaryStructure?.basic) || (Number(employee.monthlyCTC) * 0.5) || 0) / 30;
      leaveEncashmentAmount = roundAmount(encashDays * basicDailyRate);
    }

    const activeLoans = await Loan.find({ employee: employee._id, user: req.user._id, status: 'active', remainingBalance: { $gt: 0 } });
    let loanRecoveryDeduction = 0;
    activeLoans.forEach(loan => {
      loanRecoveryDeduction += Number(loan.remainingBalance) || 0;
    });
    loanRecoveryDeduction = roundAmount(Math.max(0, loanRecoveryDeduction));

    employee.dateOfLeaving = exitDate;
    // Build periodInput only when the caller actually supplied values — undefined means
    // "not provided", which lets each strategy apply its own default (e.g. piece-rate
    // defaults to 1 unit when unitsProduced is undefined, not 0).
    const fnfPeriodInput = {};
    if (unitsProduced !== undefined && unitsProduced !== null && unitsProduced !== '') {
      fnfPeriodInput.unitsProduced = Number(unitsProduced);
    }
    if (ratePerUnit !== undefined && ratePerUnit !== null && ratePerUnit !== '') {
      fnfPeriodInput.ratePerUnit = Number(ratePerUnit);
    }

    const adjustments = {
      otherEarnings: leaveEncashmentAmount > 0 ? [{ name: 'Leave Encashment', amount: leaveEncashmentAmount }] : [],
      otherDeductions: [
        ...(noticeShortfallDeduction > 0 ? [{ name: 'Notice Period Shortfall Recovery', amount: noticeShortfallDeduction }] : []),
        ...(loanRecoveryDeduction > 0 ? [{ name: 'Loan Balance Recovery', amount: loanRecoveryDeduction }] : []),
      ],
      variablePay: gratuityPayout > 0 ? { specialBonus: gratuityPayout } : {},
      ...(Object.keys(fnfPeriodInput).length > 0 ? { periodInput: fnfPeriodInput } : {}),
    };

    // Pass hoursWorked through attendance so snapshot.js:104's priority chain
    // (attendance?.hoursWorked first) picks it up ahead of the stale employee field.
    // workingDays = paidDays so snapshot.js prorate = 1.0: the salary strategy
    // (piece-rate, hourly, etc.) already owns the total-gross calculation for the
    // period; the F&F gross should not be scaled further by the calendar fraction.
    const exitDayCount = exitDate.getUTCDate();
    const fnfAttendance = {
      paidDays: exitDayCount,
      workingDays: exitDayCount,
      ...(hoursWorked !== undefined && hoursWorked !== null && hoursWorked !== '' ? { hoursWorked: Number(hoursWorked) } : {}),
    };

    const snapshot = buildPayrollSnapshot(employee, config, fnfAttendance, adjustments, month, year);

    const payroll = await Payroll.create({
      user: req.user._id,
      employee: employee._id,
      month,
      year,
      paymentDate: exitDate,
      workingDays: exitDate.getUTCDate(),
      paidDays: exitDate.getUTCDate(),
      earnings: snapshot.earnings,
      employerContributions: snapshot.employerContributions,
      variablePay: snapshot.variablePay,
      totalPayable: snapshot.totalPayable,
      deductions: snapshot.deductions,
      netSalary: snapshot.netSalary,
      status: 'processed',
      isFullAndFinal: true,
      settlementType: 'full_and_final',
      fnfDetails: {
        lastWorkingDay: exitDate,
        tenureYears: roundAmount(tenureYears),
        leaveEncashmentDays: encashDays,
        leaveEncashmentAmount,
        gratuityPayout,
        noticeShortfallDeduction,
        loanRecoveryDeduction,
        comments,
      },
      employeeSnapshot: {
        employeeId: employee.employeeId,
        firstName: employee.firstName,
        lastName: employee.lastName,
        email: employee.email,
        designation: employee.designation,
        joiningDate: employee.joiningDate,
        dateOfLeaving: exitDate,
        compensationType: employee.compensationType || (employee.payType === 'hourly' ? 'hourly' : 'monthly_salary'),
        monthlyCTC: snapshot.master.monthlyCTC,
      },
      notes: `Full & Final Settlement for ${employee.firstName} ${employee.lastName}. LWD: ${exitDate.toLocaleDateString('en-IN')}`
    });

    employee.status = 'terminated';
    await employee.save();

    res.json({
      message: 'Full and Final Settlement processed successfully',
      payroll,
      settlementSummary: {
        employeeId: employee.employeeId,
        employeeName: `${employee.firstName} ${employee.lastName}`,
        lastWorkingDay: exitDate,
        tenureYears: roundAmount(tenureYears),
        proratedGrossSalary: snapshot.earnings?.totalEarnings || 0,
        leaveEncashmentAmount,
        gratuityPayout,
        noticeShortfallDeduction,
        loanRecoveryDeduction,
        totalDeductions: snapshot.totalDeductions,
        netFnFSettlementAmount: snapshot.netSalary,
      },
      snapshot,
    });
  } catch (error) {
    console.error('Error processing Full & Final settlement:', error);
    res.status(500).json({ message: 'Server error processing Full & Final settlement' });
  }
};

module.exports = {
  getPayrolls,
  getPayrollById,
  updatePayroll,
  markPayrollAsPaid,
  reopenPayroll,
  deletePayroll,
  processFullAndFinalSettlement,
};
