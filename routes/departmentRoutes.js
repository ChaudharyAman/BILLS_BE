const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  getDepartments,
  createDepartment,
  updateDepartment,
  deleteDepartment,
} = require('../controllers/departmentController');

router.use(protect);

router.route('/')
  .get(authorize('departments', 'view'), getDepartments)
  .post(authorize('departments', 'create'), createDepartment);

router.route('/:id')
  .put(authorize('departments', 'edit'), updateDepartment)
  .delete(authorize('departments', 'delete'), deleteDepartment);

module.exports = router;
