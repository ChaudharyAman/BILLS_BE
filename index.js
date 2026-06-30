const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const connectDB = require('./db');
const bootstrapAdmin = require('./utils/bootstrap');
const { startScheduler } = require('./services/recurringTransactionScheduler');

dotenv.config();

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = [
      'http://localhost:5173',
      'http://localhost:5174',
      'https://bills-nu.vercel.app',
      process.env.CLIENT_URL,
    ].filter(Boolean);

    const allowLocalDevOrigin = process.env.NODE_ENV !== 'production';
    const isLocalDevOrigin = allowLocalDevOrigin && typeof origin === 'string' && /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-zA-Z0-9-]+\.local)(:\d+)?$/.test(origin);

    if (!origin || allowedOrigins.includes(origin) || isLocalDevOrigin) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cookieParser());

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX || 1000),
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again after 15 minutes',
});

app.use('/api', apiLimiter);

app.use('/api/clients', require('./routes/clientRoutes'));
app.use('/api/vendors', require('./routes/vendorRoutes'));
app.use('/api/items', require('./routes/itemRoutes'));
app.use('/api/invoices', require('./routes/invoiceRoutes'));
app.use('/api/quotes', require('./routes/quoteRoutes'));
app.use('/api/proformas', require('./routes/proformaRoutes'));
app.use('/api/purchase-orders', require('./routes/purchaseOrderRoutes'));
app.use('/api/expenses', require('./routes/expenseRoutes'));
app.use('/api/incomes', require('./routes/incomeRoutes'));
app.use('/api/categories', require('./routes/categoryRoutes'));
app.use('/api/departments', require('./routes/departmentRoutes'));
app.use('/api/employees', require('./routes/employeeRoutes'));
app.use('/api/loans', require('./routes/loanRoutes'));
app.use('/api/reimbursements', require('./routes/reimbursementRoutes'));
app.use('/api/leaves', require('./routes/leaveRoutes'));
app.use('/api/payroll', require('./routes/payrollRoutes'));
app.use('/api/payroll-components', require('./routes/payrollComponentRoutes'));
app.use('/api/roles', require('./routes/roleRoutes'));
app.use('/api/budgets', require('./routes/budgetRoutes'));
app.use('/api/reports', require('./routes/reportRoutes'));
app.use('/api/assets', require('./routes/assetRoutes'));
app.use('/api/liabilities', require('./routes/liabilityRoutes'));
app.use('/api/recurring', require('./routes/recurringRoutes'));
app.use('/api/projects', require('./routes/projectRoutes'));
app.use('/api/settings', require('./routes/settingsRoutes'));
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/subscriptions', require('./routes/subscriptionRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/pdf', require('./routes/pdfRoutes'));
app.use('/api/bank-statements', require('./routes/bankStatementRoutes'));

// ── Public Submission Portal (no auth — token-scoped) ────────────────────────
app.use('/api/public', require('./routes/publicSubmissionRoutes'));

// ── Authenticated Submission Review (protect applied inside route file) ───────
app.use('/api/submissions', require('./routes/submissionReviewRoutes'));


app.get('/', (req, res) => {
  res.send('API is working fine.');
});

const { cleanupStaleIncomes } = require('./services/invoiceIncomeSync');

async function startServer(port = process.env.PORT || 5000) {
  await connectDB();

  await bootstrapAdmin();
  startScheduler();

  // Auto-cleanup stale UNPAID income records synced from invoices (non-blocking)
  cleanupStaleIncomes().catch((err) => console.error('Startup income cleanup failed:', err.message));

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`Server running on port ${port}`);
      resolve(server);
    });

    server.on('error', reject);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(`Server failed to start: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { app, startServer };
