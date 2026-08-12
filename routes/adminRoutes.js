const express = require('express');
const router = express.Router();
const { protect, admin } = require('../middleware/authMiddleware');
const { 
  getAllUsers,
  getCompanies,
  getCompanyTeam,
  getCompanyRoles,
  updateTeamMember,
  getAuditLogs,
  updateUserPlan, 
  getUserPayments,
  createUser,
  deleteUser,
} = require('../controllers/adminController');

// All routes here are protected and require admin role
router.use(protect);
router.use(admin);

router.get('/companies', getCompanies);
router.get('/companies/:ownerId/team', getCompanyTeam);
router.get('/companies/:ownerId/roles', getCompanyRoles);
router.patch('/team-members/:id', updateTeamMember);
router.get('/audit-log', getAuditLogs);

router.get('/users', getAllUsers);
router.post('/users', createUser);
router.get('/users/:id/payments', getUserPayments);
router.patch('/users/:id/plan', updateUserPlan);
router.delete('/users/:id', deleteUser);

module.exports = router;
