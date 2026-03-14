const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const connectDB = require('./db');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// trust proxy for Render/Vercel
app.set('trust proxy', 1);

// Middleware
app.use(helmet());
app.use(cors({
    origin: [
      'http://localhost:5173',
      'https://bills-nu.vercel.app',
      process.env.CLIENT_URL
    ].filter(Boolean),
    credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cookieParser());

// Rate Limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: 'Too many requests from this IP, please try again after 15 minutes'
});

// Apply the rate limiting middleware to all API calls
app.use('/api', apiLimiter);

// Database Connection
connectDB();

// Routes
app.use('/api/clients', require('./routes/clientRoutes'));
app.use('/api/vendors', require('./routes/vendorRoutes'));
app.use('/api/items', require('./routes/itemRoutes'));
app.use('/api/invoices', require('./routes/invoiceRoutes'));
app.use('/api/quotes', require('./routes/quoteRoutes'));
app.use('/api/proformas', require('./routes/proformaRoutes'));
app.use('/api/purchase-orders', require('./routes/purchaseOrderRoutes'));
app.use('/api/expenses', require('./routes/expenseRoutes'));
app.use('/api/settings', require('./routes/settingsRoutes'));
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/subscriptions', require('./routes/subscriptionRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));

app.get('/', (req, res) => {
  res.send('API is working fine 👍...');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
