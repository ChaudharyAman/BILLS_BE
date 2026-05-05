const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  processPayroll,
  getPayrolls,
  getPayrollById,
  updatePayroll,
  markPayrollAsPaid,
  generatePayslip,
} = require('../controllers/payrollController');

const authorizePayrollRoles = (req, res, next) => {
  const allowedRoles = ['admin', 'finance', 'hr', 'superadmin'];
  if (allowedRoles.includes(req.user?.role)) {
    return next();
  }
  return res.status(403).json({ message: 'Forbidden: insufficient permissions' });
};

router.use(protect);

router.post('/process', authorizePayrollRoles, processPayroll);
router.get('/', getPayrolls);

router.route('/:id')
  .get(getPayrollById)
  .put(authorizePayrollRoles, updatePayroll);

router.post('/:id/mark-paid', authorizePayrollRoles, markPayrollAsPaid);
router.get('/:id/generate-payslip', generatePayslip);

module.exports = router;
