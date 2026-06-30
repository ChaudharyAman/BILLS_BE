const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
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
  .get(getLeaveTypes)
  .post(createLeaveType);

router.route('/balances')
  .get(getLeaveBalances);

router.route('/requests')
  .get(getLeaveRequests)
  .post(createLeaveRequest);

router.route('/requests/:id')
  .delete(deleteLeaveRequest);

router.route('/requests/:id/status')
  .put(updateLeaveRequestStatus);

router.route('/recalculate-balances')
  .post(recalculateBalancesEndpoint);

module.exports = router;
