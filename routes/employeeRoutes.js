const express = require('express');
const router = express.Router();
const multer = require('multer');
const { protect, authorize } = require('../middleware/authMiddleware');
const {
  getEmployees,
  createEmployee,
  getEmployeeById,
  updateEmployee,
  deleteEmployee,
  getActiveEmployees,
  importEmployees,
  exportEmployeesExcel,
  downloadImportTemplateExcel,
  addSalaryRevision,
  bulkSalaryRevision,
  updateSalaryRevision,
  deleteSalaryRevision,
  updateEmployeeDeclarations,
  bulkDeleteEmployees,
} = require('../controllers/employeeController');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(protect);

router.route('/')
  .get(authorize('employees', 'view'), getEmployees)
  .post(authorize('employees', 'create'), createEmployee);

router.get('/active', authorize('employees', 'view'), getActiveEmployees);
router.get('/import-template', authorize('employees', 'view'), downloadImportTemplateExcel);
router.post('/import', authorize('employees', 'create'), upload.single('file'), importEmployees);
router.get('/export', authorize('employees', 'view'), exportEmployeesExcel);

router.post('/bulk-delete', authorize('employees', 'delete'), bulkDeleteEmployees);
router.post('/bulk-salary-revision', authorize('employees', 'edit'), bulkSalaryRevision);

router.route('/:id')
  .get(authorize('employees', 'view'), getEmployeeById)
  .put(authorize('employees', 'edit'), updateEmployee)
  .delete(authorize('employees', 'delete'), deleteEmployee);
router.put('/:id/declarations', authorize('employees', 'edit'), updateEmployeeDeclarations);
router.post('/:id/salary-revision', authorize('employees', 'edit'), addSalaryRevision);
router.route('/:id/salary-revision/:revisionId')
  .put(authorize('employees', 'edit'), updateSalaryRevision)
  .delete(authorize('employees', 'delete'), deleteSalaryRevision);

module.exports = router;
