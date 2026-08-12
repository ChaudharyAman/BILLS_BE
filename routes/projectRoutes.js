const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  getProjects,
  createProject,
  updateProject,
  deleteProject,
  getProjectSummary,
} = require('../controllers/projectController');

router.use(protect);

router.route('/')
  .get(authorize('projects', 'view'), getProjects)
  .post(authorize('projects', 'create'), createProject);

router.get('/:id/summary', authorize('projects', 'view'), getProjectSummary);

router.route('/:id')
  .put(authorize('projects', 'edit'), updateProject)
  .delete(authorize('projects', 'delete'), deleteProject);

module.exports = router;
