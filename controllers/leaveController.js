const mongoose = require('mongoose');
const LeaveType = require('../models/LeaveType');
const LeaveBalance = require('../models/LeaveBalance');
const LeaveRequest = require('../models/LeaveRequest');
const Employee = require('../models/Employee');
const AuditLog = require('../models/AuditLog');
const { getTenantFilter, attachTenant } = require('../utils/tenantHelper');

const resolveScope = (reqOrUser) => {
  if (reqOrUser && reqOrUser.activeProfileId) {
    return {
      filter: getTenantFilter(reqOrUser),
      attach: (payload) => attachTenant(reqOrUser, payload),
    };
  }
  if (reqOrUser && typeof reqOrUser === 'object' && reqOrUser.user) {
    return {
      filter: reqOrUser,
      attach: (payload) => ({ ...payload, ...reqOrUser }),
    };
  }
  const id = reqOrUser?.companyId || reqOrUser?.user?._id || reqOrUser;
  return {
    filter: id ? { user: id } : {},
    attach: (payload) => ({ ...payload, ...(id ? { user: id } : {}) }),
  };
};

// Recalculates all balances for an employee for a specific year
const recalculateLeaveBalances = async (employeeId, year, reqOrUser) => {
  const { filter, attach } = resolveScope(reqOrUser);
  const leaveTypes = await LeaveType.find(filter);

  for (const leaveType of leaveTypes) {
    if (!leaveType.isPaid) continue;

    const yearStart = new Date(year, 0, 1);
    const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999);

    const approvedRequests = await LeaveRequest.find({
      ...filter,
      employee: employeeId,
      leaveType: leaveType._id,
      status: 'approved',
      startDate: { $lte: yearEnd },
      endDate: { $gte: yearStart }
    });

    let totalUsed = 0;
    for (const req of approvedRequests) {
      const start = new Date(req.startDate);
      const end = new Date(req.endDate);
      const startOfYear = new Date(year, 0, 1);
      const endOfYear = new Date(year, 11, 31, 23, 59, 59, 999);

      const overlapStart = new Date(Math.max(start.getTime(), startOfYear.getTime()));
      const overlapEnd = new Date(Math.min(end.getTime(), endOfYear.getTime()));

      if (overlapStart <= overlapEnd) {
        const totalCalendarMs = end.getTime() - start.getTime();
        const totalCalendarDays = Math.round(totalCalendarMs / (1000 * 60 * 60 * 24)) + 1;

        const overlapMs = overlapEnd.getTime() - overlapStart.getTime();
        const overlapCalendarDays = Math.round(overlapMs / (1000 * 60 * 60 * 24)) + 1;

        const ratio = overlapCalendarDays / totalCalendarDays;
        totalUsed += req.numberOfDays * ratio;
      }
    }

    let balance = await LeaveBalance.findOne({
      ...filter,
      employee: employeeId,
      leaveType: leaveType._id,
      year: year
    });

    if (balance) {
      balance.used = Math.round(totalUsed * 100) / 100;
      balance.closing = Math.round((balance.opening + balance.accrued + balance.carriedForward - balance.used) * 100) / 100;
      await balance.save();
    } else {
      await LeaveBalance.create(attach({
        employee: employeeId,
        leaveType: leaveType._id,
        year: year,
        opening: 0,
        accrued: leaveType.annualEntitlement,
        used: Math.round(totalUsed * 100) / 100,
        carriedForward: 0,
        closing: Math.round((leaveType.annualEntitlement - totalUsed) * 100) / 100
      }));
    }
  }
};

// Seed default leave types for a user/tenant if none exist
const seedDefaultLeaveTypes = async (reqOrUser) => {
  const { filter, attach } = resolveScope(reqOrUser);
  const count = await LeaveType.countDocuments(filter);
  if (count === 0) {
    const defaults = [
      { name: 'Casual Leave', code: 'CL', annualEntitlement: 12, carriesForward: false, isPaid: true, description: 'For casual personal requirements' },
      { name: 'Sick Leave', code: 'SL', annualEntitlement: 8, carriesForward: false, isPaid: true, description: 'For medical/health issues' },
      { name: 'Privilege Leave', code: 'PL', annualEntitlement: 15, carriesForward: true, isPaid: true, description: 'Earned/Privilege leave that accumulates' },
      { name: 'Loss of Pay Leave', code: 'LOP', annualEntitlement: 0, carriesForward: false, isPaid: false, description: 'Unpaid leaves / Loss of pay' }
    ];
    await LeaveType.create(defaults.map(d => attach(d)));
  }
};

// Seed/recalculate leave balances for all active employees for a year
const seedLeaveBalancesForYear = async (reqOrUser, year) => {
  await seedDefaultLeaveTypes(reqOrUser);
  const { filter, attach } = resolveScope(reqOrUser);
  const employees = await Employee.find({ ...filter, status: 'active', dateOfLeaving: null });
  const leaveTypes = await LeaveType.find({ ...filter, isPaid: true });

  for (const emp of employees) {
    for (const lt of leaveTypes) {
      const existing = await LeaveBalance.findOne({
        ...filter,
        employee: emp._id,
        leaveType: lt._id,
        year: year
      });
      if (!existing) {
        await LeaveBalance.create(attach({
          employee: emp._id,
          leaveType: lt._id,
          year: year,
          opening: 0,
          accrued: lt.annualEntitlement,
          used: 0,
          carriedForward: 0,
          closing: lt.annualEntitlement
        }));
      }
    }
  }
};

// Controllers
exports.getLeaveTypes = async (req, res) => {
  try {
    await seedDefaultLeaveTypes(req);
    const types = await LeaveType.find(getTenantFilter(req)).sort({ isPaid: -1, name: 1 });
    res.json(types);
  } catch (error) {
    console.error('Error fetching leave types:', error);
    res.status(500).json({ message: 'Server error fetching leave types' });
  }
};

exports.createLeaveType = async (req, res) => {
  try {
    const { name, code, annualEntitlement, carriesForward, isPaid, description } = req.body;
    if (!name || !code) {
      return res.status(400).json({ message: 'Name and Code are required' });
    }

    const typeCode = code.toUpperCase().trim();
    const existing = await LeaveType.findOne({ ...getTenantFilter(req), code: typeCode });
    if (existing) {
      return res.status(400).json({ message: `Leave type with code ${typeCode} already exists` });
    }

    const leaveType = await LeaveType.create(attachTenant(req, {
      name: name.trim(),
      code: typeCode,
      annualEntitlement: Number(annualEntitlement) || 0,
      carriesForward: Boolean(carriesForward),
      isPaid: isPaid !== false,
      description: description || ''
    }));

    res.status(201).json(leaveType);
  } catch (error) {
    console.error('Error creating leave type:', error);
    res.status(500).json({ message: 'Server error creating leave type' });
  }
};

exports.getLeaveBalances = async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const employeeId = req.query.employee;

    await seedLeaveBalancesForYear(req, year);

    const query = { ...getTenantFilter(req), year };
    if (employeeId && mongoose.Types.ObjectId.isValid(String(employeeId))) {
      query.employee = employeeId;
    }

    const balances = await LeaveBalance.find(query)
      .populate('employee', 'firstName lastName employeeId designation')
      .populate('leaveType', 'name code isPaid annualEntitlement')
      .sort({ employee: 1 });

    res.json(balances);
  } catch (error) {
    console.error('Error fetching leave balances:', error);
    res.status(500).json({ message: 'Server error fetching leave balances' });
  }
};

exports.getLeaveRequests = async (req, res) => {
  try {
    const { employee, status } = req.query;
    const query = { ...getTenantFilter(req) };

    if (employee && mongoose.Types.ObjectId.isValid(String(employee))) {
      query.employee = employee;
    }
    if (status) {
      query.status = status;
    }

    const requests = await LeaveRequest.find(query)
      .populate('employee', 'firstName lastName employeeId designation')
      .populate('leaveType', 'name code isPaid')
      .sort({ createdAt: -1 })
      .lean();

    res.json(requests);
  } catch (error) {
    console.error('Error fetching leave requests:', error);
    res.status(500).json({ message: 'Server error fetching leave requests' });
  }
};

exports.createLeaveRequest = async (req, res) => {
  try {
    const { employee, leaveType, startDate, endDate, numberOfDays, reason } = req.body;

    if (!employee || !leaveType || !startDate || !endDate || !numberOfDays) {
      return res.status(400).json({ message: 'Missing required leave fields' });
    }

    const emp = await Employee.findOne({ _id: employee, ...getTenantFilter(req) });
    if (!emp) return res.status(404).json({ message: 'Employee not found' });

    const lt = await LeaveType.findOne({ _id: leaveType, ...getTenantFilter(req) });
    if (!lt) return res.status(404).json({ message: 'Leave type not found' });

    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
      return res.status(400).json({ message: 'Invalid start or end date' });
    }

    // Check for overlap with existing approved or pending requests
    const startOfDay = new Date(start); startOfDay.setHours(0,0,0,0);
    const endOfDay = new Date(end); endOfDay.setHours(23,59,59,999);

    const overlap = await LeaveRequest.findOne({
      employee,
      ...getTenantFilter(req),
      status: { $in: ['pending', 'approved'] },
      startDate: { $lte: endOfDay },
      endDate: { $gte: startOfDay }
    });

    if (overlap) {
      return res.status(400).json({
        message: `Leave request overlaps with an existing ${overlap.status} request from ${overlap.startDate.toLocaleDateString('en-IN')} to ${overlap.endDate.toLocaleDateString('en-IN')}`
      });
    }

    const request = await LeaveRequest.create(attachTenant(req, {
      employee,
      leaveType,
      startDate: start,
      endDate: end,
      numberOfDays: Number(numberOfDays),
      reason: reason || '',
      status: 'pending'
    }));

    const populated = await LeaveRequest.findById(request._id)
      .populate('employee', 'firstName lastName employeeId designation')
      .populate('leaveType', 'name code isPaid')
      .lean();

    res.status(201).json(populated);
  } catch (error) {
    console.error('Error creating leave request:', error);
    res.status(500).json({ message: 'Server error creating leave request' });
  }
};

exports.updateLeaveRequestStatus = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const { status, approverRemarks } = req.body;
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status update' });
    }

    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Leave request not found' });
    }

    const request = await LeaveRequest.findOne({ _id: req.params.id, ...getTenantFilter(req) })
      .populate('employee')
      .populate('leaveType');

    if (!request) return res.status(404).json({ message: 'Leave request not found' });

    const oldStatus = request.status;
    request.status = status;
    if (approverRemarks !== undefined) {
      request.approverRemarks = approverRemarks;
    }
    await request.save();

    // Trigger balance recalculation on approval/cancellation change
    const year = new Date(request.startDate).getFullYear();
    await recalculateLeaveBalances(request.employee._id, year, req);

    // Write to AuditLog
    await AuditLog.create(attachTenant(req, {
      actor: req.user._id,
      action: 'LEAVE_STATUS_UPDATE',
      targetEmployee: request.employee._id,
      changes: {
        leaveRequestId: request._id,
        leaveType: request.leaveType.name,
        startDate: request.startDate,
        endDate: request.endDate,
        oldStatus,
        newStatus: status,
        approverRemarks
      }
    }));

    res.json(request);
  } catch (error) {
    console.error('Error updating leave request status:', error);
    res.status(500).json({ message: 'Server error updating leave status' });
  }
};

exports.deleteLeaveRequest = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
      return res.status(404).json({ message: 'Leave request not found' });
    }

    const request = await LeaveRequest.findOne({ _id: req.params.id, ...getTenantFilter(req) });
    if (!request) return res.status(404).json({ message: 'Leave request not found' });

    const employeeId = request.employee;
    const year = new Date(request.startDate).getFullYear();

    await LeaveRequest.updateOne({ _id: req.params.id, ...getTenantFilter(req) }, { $set: { isDeleted: true, deletedAt: new Date() } });

    // Recalculate balances
    await recalculateLeaveBalances(employeeId, year, req);

    res.json({ message: 'Leave request deleted successfully' });
  } catch (error) {
    console.error('Error deleting leave request:', error);
    res.status(500).json({ message: 'Server error deleting leave request' });
  }
};

exports.recalculateBalancesEndpoint = async (req, res) => {
  try {
    const { employeeId, year } = req.body;
    if (!employeeId || !year) {
      return res.status(400).json({ message: 'Employee ID and Year are required' });
    }
    await recalculateLeaveBalances(employeeId, Number(year), req);
    res.json({ message: 'Balances recalculated successfully' });
  } catch (error) {
    console.error('Error recalculating balances:', error);
    res.status(500).json({ message: 'Server error recalculating balances' });
  }
};

