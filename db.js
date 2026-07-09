const mongoose = require('mongoose');

const reconcileDatabaseIndexes = async () => {
  const Invoice = require('./models/Invoice');
  const PurchaseOrder = require('./models/PurchaseOrder');

  try {
    // Reconcile Invoice Indexes
    const invoiceIndexes = await Invoice.collection.indexes();
    const staleInvoiceNoIndex = invoiceIndexes.find((index) => {
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

    // Reconcile PurchaseOrder Indexes
    const poIndexes = await PurchaseOrder.collection.indexes();
    const stalePoNoIndex = poIndexes.find((index) => {
      const keys = Object.keys(index.key || {});
      return index.name === 'poNumber_1'
        && keys.length === 1
        && index.key.poNumber === 1;
    });

    if (stalePoNoIndex) {
      await PurchaseOrder.collection.dropIndex(stalePoNoIndex.name);
      console.log('Dropped stale purchaseorders.poNumber_1 index');
    }

    await PurchaseOrder.createIndexes();
  } catch (error) {
    if (error.codeName === 'NamespaceNotFound' || error.code === 26) {
      try { await Invoice.createIndexes(); } catch (_) {}
      try { await PurchaseOrder.createIndexes(); } catch (_) {}
      return;
    }

    throw error;
  }
};

const connectDB = async () => {
  try {
    if (mongoose.connection.readyState === 1) {
      await reconcileDatabaseIndexes();
      return mongoose.connection;
    }

    if (mongoose.connection.readyState === 2) {
      const connection = await mongoose.connection.asPromise();
      await reconcileDatabaseIndexes();
      return connection;
    }

    const conn = await mongoose.connect(process.env.MONGO_URI, {});
    console.log(`MongoDB Connected: ${conn.connection.host}`);
    await reconcileDatabaseIndexes();
    return conn.connection;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    throw error;
  }
};

module.exports = connectDB;
