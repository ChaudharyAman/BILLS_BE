const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  getProjects,
  createProject,
  updateProject,
  deleteProject,
  getProjectSummary,
} = require('../controllers/projectController');

router.use(protect);

router.route('/')
  .get(getProjects)
  .post(createProject);

router.get('/:id/summary', getProjectSummary);

router.route('/:id')
  .put(updateProject)
  .delete(deleteProject);

module.exports = router;
