const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const morgan = require('morgan');
const connectDB = require('./db');
const bootstrapAdmin = require('./utils/bootstrap');
const { startScheduler } = require('./services/recurringTransactionScheduler');

dotenv.config();

const app = express();

app.set('trust proxy', 1);

// HTTP request logging with local timestamp and user email
morgan.token('time', () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
morgan.token('user-email', (req) => (req.user && req.user.email ? req.user.email : 'guest'));

if (process.env.NODE_ENV === 'production') {
  app.use(morgan('[:time] (:user-email) :remote-addr - :remote-user ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"'));
} else {
  app.use(morgan('[:time] (:user-email) :method :url :status :response-time ms - :res[content-length]'));
}

app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = [
      'http://localhost:5173',
      'http://localhost:5174',
      'https://flance.in',
      'https://www.flance.in',
      'https://bills-nu.vercel.app',
      process.env.CLIENT_URL,
    ].filter(Boolean);

    const allowLocalDevOrigin = process.env.NODE_ENV !== 'production';
    const isLocalDevOrigin = allowLocalDevOrigin && typeof origin === 'string' && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|::1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*)(:\d+)?$/.test(origin);

    if (!origin || allowedOrigins.includes(origin) || isLocalDevOrigin) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cookieParser());

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX || 1000),
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again after 15 minutes',
});

const { protect } = require('./middleware/authMiddleware');
const { resolveActiveProfile } = require('./middleware/profileMiddleware');
const { shareRuleFilter } = require('./middleware/shareRuleFilter');
const { profileShareRouter, publicShareRouter } = require('./routes/profileShareRoutes');

app.use('/api', apiLimiter);

// ── Public Routes (Unauthenticated) ──────────────────────────────────────────
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/public', require('./routes/publicSubmissionRoutes'));
app.use('/api/shared', publicShareRouter);

// ── Profile Management Routes (protect only) ─────────────────────────────────
app.use('/api/profiles', require('./routes/clientProfileRoutes'));
app.use('/api/profiles/:profileId/shares', profileShareRouter);

// ── Feature Routes (protect + resolveActiveProfile + shareRuleFilter) ────────
const tenantStack = [protect, resolveActiveProfile, shareRuleFilter];

app.use('/api/clients', tenantStack, require('./routes/clientRoutes'));
app.use('/api/vendors', tenantStack, require('./routes/vendorRoutes'));
app.use('/api/items', tenantStack, require('./routes/itemRoutes'));
app.use('/api/invoices', tenantStack, require('./routes/invoiceRoutes'));
app.use('/api/quotes', tenantStack, require('./routes/quoteRoutes'));
app.use('/api/proformas', tenantStack, require('./routes/proformaRoutes'));
app.use('/api/purchase-orders', tenantStack, require('./routes/purchaseOrderRoutes'));
app.use('/api/expenses', tenantStack, require('./routes/expenseRoutes'));
app.use('/api/incomes', tenantStack, require('./routes/incomeRoutes'));
app.use('/api/categories', tenantStack, require('./routes/categoryRoutes'));
app.use('/api/departments', tenantStack, require('./routes/departmentRoutes'));
app.use('/api/business-units', tenantStack, require('./routes/businessUnitRoutes'));
app.use('/api/employees', tenantStack, require('./routes/employeeRoutes'));
app.use('/api/loans', tenantStack, require('./routes/loanRoutes'));
app.use('/api/reimbursements', tenantStack, require('./routes/reimbursementRoutes'));
app.use('/api/leaves', tenantStack, require('./routes/leaveRoutes'));
app.use('/api/payroll', tenantStack, require('./routes/payrollRoutes'));
app.use('/api/payroll-variable-transactions', tenantStack, require('./routes/payrollVariableTransactionRoutes'));
app.use('/api/roles', tenantStack, require('./routes/roleRoutes'));
app.use('/api/budgets', tenantStack, require('./routes/budgetRoutes'));
app.use('/api/reports', tenantStack, require('./routes/reportRoutes'));
app.use('/api/assets', tenantStack, require('./routes/assetRoutes'));
app.use('/api/liabilities', tenantStack, require('./routes/liabilityRoutes'));
app.use('/api/equity', tenantStack, require('./routes/equityRoutes'));
app.use('/api/accruals', tenantStack, require('./routes/accrualRoutes'));
app.use('/api/recurring', tenantStack, require('./routes/recurringRoutes'));
app.use('/api/projects', tenantStack, require('./routes/projectRoutes'));
app.use('/api/settings', tenantStack, require('./routes/settingsRoutes'));
app.use('/api/company-documents', tenantStack, require('./routes/companyDocumentRoutes'));
app.use('/api/subscriptions', tenantStack, require('./routes/subscriptionRoutes'));
app.use('/api/admin', tenantStack, require('./routes/adminRoutes'));
app.use('/api/pdf', tenantStack, require('./routes/pdfRoutes'));
app.use('/api/bank-statements', tenantStack, require('./routes/bankStatementRoutes'));
app.use('/api/recycle-bin', tenantStack, require('./routes/recycleBinRoutes'));
app.use('/api/team-members', tenantStack, require('./routes/teamMemberRoutes'));

// ── Authenticated Submission Review ──────────────────────────────────────────
app.use('/api/submissions', tenantStack, require('./routes/submissionReviewRoutes'));


app.get('/', (req, res) => {
  res.send('API is working fine.');
});

const { cleanupStaleIncomes } = require('./services/invoiceIncomeSync');
const { checkWebhookSecretStartup, verifyProductionSecretAudit } = require('./utils/cryptoHelper');

async function startServer(port = process.env.PORT || 5000) {
  // Execute mandatory production security audit
  verifyProductionSecretAudit();

  await connectDB();

  await bootstrapAdmin();
  startScheduler();

  // Startup security checks
  checkWebhookSecretStartup().catch(() => {});

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
