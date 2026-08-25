const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  inviteTeamMember,
  acceptInvite,
  getTeamMembers,
  updateTeamMember,
  deleteTeamMember,
  getAccessRoles,
  createAccessRole,
  updateAccessRole,
  deleteAccessRole,
} = require('../controllers/teamMemberController');

// Public route for accepting invite
router.post('/accept-invite', acceptInvite);

// AccessRole routes
router.get('/roles', protect, authorize('teamMembers', 'view'), getAccessRoles);
router.post('/roles', protect, authorize('teamMembers', 'create'), createAccessRole);
router.patch('/roles/:id', protect, authorize('teamMembers', 'edit'), updateAccessRole);
router.delete('/roles/:id', protect, authorize('teamMembers', 'delete'), deleteAccessRole);

// Team Member routes
router.get('/', protect, authorize('teamMembers', 'view'), getTeamMembers);
router.post('/invite', protect, authorize('teamMembers', 'create'), inviteTeamMember);
router.patch('/:id', protect, authorize('teamMembers', 'edit'), updateTeamMember);
router.delete('/:id', protect, authorize('teamMembers', 'delete'), deleteTeamMember);

module.exports = router;
