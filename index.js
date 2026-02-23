const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const connectDB = require('./db');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Database Connection
connectDB();

// Routes
app.use('/api/clients', require('./routes/clientRoutes'));
app.use('/api/items', require('./routes/itemRoutes'));
app.use('/api/invoices', require('./routes/invoiceRoutes'));
app.use('/api/quotes', require('./routes/quoteRoutes'));
app.use('/api/proformas', require('./routes/proformaRoutes'));
app.use('/api/settings', require('./routes/settingsRoutes'));
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/subscriptions', require('./routes/subscriptionRoutes'));

app.get('/', (req, res) => {
  res.send('API is working fine 👍...');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
