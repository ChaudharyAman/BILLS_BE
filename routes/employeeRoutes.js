const express = require('express');
const router = express.Router();
const multer = require('multer');
const { protect } = require('../middleware/authMiddleware');
const {
  getEmployees,
  createEmployee,
  getEmployeeById,
  updateEmployee,
  deleteEmployee,
  getActiveEmployees,
  importEmployees,
  exportEmployeesExcel,
  addSalaryRevision,
  updateEmployeeDeclarations,
} = require('../controllers/employeeController');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(protect);

router.route('/')
  .get(getEmployees)
  .post(createEmployee);

router.get('/active', getActiveEmployees);
router.post('/import', upload.single('file'), importEmployees);
router.get('/export', exportEmployeesExcel);

router.route('/:id')
  .get(getEmployeeById)
  .put(updateEmployee)
  .delete(deleteEmployee);
router.put('/:id/declarations', updateEmployeeDeclarations);
router.post('/:id/salary-revision', addSalaryRevision);

module.exports = router;
