const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Invoice = require('./models/Invoice');
const User = require('./models/User');

dotenv.config();

const verifyData = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`MongoDB Connected: ${conn.connection.host}`);

    const totalInvoices = await Invoice.countDocuments();
    const invoicesWithUser = await Invoice.countDocuments({ user: { $exists: true } });
    const invoicesWithoutUser = await Invoice.countDocuments({ user: { $exists: false } });

    console.log('--- DB SUMMARY ---');
    console.log(`Total Invoices: ${totalInvoices}`);
    console.log(`Invoices WITH User: ${invoicesWithUser}`);
    console.log(`Invoices WITHOUT User: ${invoicesWithoutUser}`);

    if (invoicesWithUser > 0) {
        const sample = await Invoice.findOne({ user: { $exists: true } }).populate('user');
        console.log('Sample Invoice User:', sample.user ? sample.user.username : 'Unknown');
        console.log('Sample Invoice User ID:', sample.user ? sample.user._id.toString() : 'Unknown');
    }

    process.exit();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
};

verifyData();
