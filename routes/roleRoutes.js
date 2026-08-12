const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  getRoles,
  getRoleById,
  createRole,
  updateRole,
  deleteRole,
} = require('../controllers/roleController');

router.use(protect);

router.route('/')
  .get(authorize('jobRoles', 'view'), getRoles)
  .post(authorize('jobRoles', 'create'), createRole);

router.route('/:id')
  .get(authorize('jobRoles', 'view'), getRoleById)
  .put(authorize('jobRoles', 'edit'), updateRole)
  .delete(authorize('jobRoles', 'delete'), deleteRole);

module.exports = router;
