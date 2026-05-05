const mongoose = require('mongoose');

const reconcileInvoiceIndexes = async () => {
  const Invoice = require('./models/Invoice');

  try {
    const indexes = await Invoice.collection.indexes();
    const staleInvoiceNoIndex = indexes.find((index) => {
      const keys = Object.keys(index.key || {});
      return index.name === 'invoiceNo_1'
        && keys.length === 1
        && index.key.invoiceNo === 1;
    });

    if (staleInvoiceNoIndex) {
      await Invoice.collection.dropIndex(staleInvoiceNoIndex.name);
      console.log('Dropped stale invoices.invoiceNo_1 index');
    }

    await Invoice.createIndexes();
  } catch (error) {
    if (error.codeName === 'NamespaceNotFound' || error.code === 26) {
      await Invoice.createIndexes();
      return;
    }

    throw error;
  }
};

const connectDB = async () => {
  try {
    if (mongoose.connection.readyState === 1) {
      await reconcileInvoiceIndexes();
      return mongoose.connection;
    }

    if (mongoose.connection.readyState === 2) {
      const connection = await mongoose.connection.asPromise();
      await reconcileInvoiceIndexes();
      return connection;
    }

    const conn = await mongoose.connect(process.env.MONGO_URI, {});
    console.log(`MongoDB Connected: ${conn.connection.host}`);
    await reconcileInvoiceIndexes();
    return conn.connection;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    throw error;
  }
};

module.exports = connectDB;
