const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  getEmployees,
  createEmployee,
  getEmployeeById,
  updateEmployee,
  deleteEmployee,
  getActiveEmployees,
} = require('../controllers/employeeController');

router.use(protect);

router.route('/')
  .get(getEmployees)
  .post(createEmployee);

router.get('/active', getActiveEmployees);

router.route('/:id')
  .get(getEmployeeById)
  .put(updateEmployee)
  .delete(deleteEmployee);

module.exports = router;
