const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  getLeaveTypes,
  createLeaveType,
  getLeaveBalances,
  getLeaveRequests,
  createLeaveRequest,
  updateLeaveRequestStatus,
  deleteLeaveRequest,
  recalculateBalancesEndpoint,
} = require('../controllers/leaveController');

router.use(protect);

router.route('/types')
  .get(authorize('leaves', 'view'), getLeaveTypes)
  .post(authorize('leaves', 'create'), createLeaveType);

router.route('/balances')
  .get(authorize('leaves', 'view'), getLeaveBalances);

router.route('/requests')
  .get(authorize('leaves', 'view'), getLeaveRequests)
  .post(authorize('leaves', 'create'), createLeaveRequest);

router.route('/requests/:id')
  .delete(authorize('leaves', 'delete'), deleteLeaveRequest);

router.route('/requests/:id/status')
  .put(authorize('leaves', 'approve'), updateLeaveRequestStatus);

router.route('/recalculate-balances')
  .post(authorize('leaves', 'edit'), recalculateBalancesEndpoint);

module.exports = router;
