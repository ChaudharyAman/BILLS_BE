const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const connectDB = require('./db');
const bootstrapAdmin = require('./utils/bootstrap');

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

    const isLocalDevOrigin = typeof origin === 'string' && /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);

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
  max: Number(process.env.API_RATE_LIMIT_MAX || 100),
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
app.use('/api/settings', require('./routes/settingsRoutes'));
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/subscriptions', require('./routes/subscriptionRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/pdf', require('./routes/pdfRoutes'));

app.get('/', (req, res) => {
  res.send('API is working fine ðŸ‘...');
});

async function startServer(port = process.env.PORT || 5000) {
  await connectDB();
  await bootstrapAdmin();

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
