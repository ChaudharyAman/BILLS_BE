const mongoose = require('mongoose');

const reconcileDatabaseIndexes = async () => {
  const Invoice = require('./models/Invoice');
  const PurchaseOrder = require('./models/PurchaseOrder');
  const Payroll = require('./models/Payroll');

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

    // Reconcile Payroll Indexes:
    // Drop any old index on { user, employee, month, year } or { user, employee, month, year, isDeleted }
    // that lacks partialFilterExpression: { isDeleted: false }.
    // This ensures active payrolls cannot have duplicate runs (unique: true) while allowing
    // reprocessing after soft-deleting an old payroll record.
    try {
      const payrollIndexes = await Payroll.collection.indexes();
      const stalePayrollIndex = payrollIndexes.find((index) => {
        const keys = Object.keys(index.key || {});
        const isFourKeys = keys.length === 4
          && index.key.user === 1
          && index.key.employee === 1
          && index.key.month === 1
          && index.key.year === 1;

        const isFiveKeys = keys.length === 5
          && index.key.user === 1
          && index.key.employee === 1
          && index.key.month === 1
          && index.key.year === 1
          && index.key.isDeleted === 1;

        const hasPartialFilter = index.partialFilterExpression && index.partialFilterExpression.isDeleted === false;

        return (isFourKeys || isFiveKeys) && (!index.unique || !hasPartialFilter);
      });

      if (stalePayrollIndex) {
        await Payroll.collection.dropIndex(stalePayrollIndex.name);
        console.log(`Dropped stale payroll index: ${stalePayrollIndex.name}`);
      }

      await Payroll.createIndexes();
    } catch (payrollIndexErr) {
      if (payrollIndexErr.codeName !== 'NamespaceNotFound' && payrollIndexErr.code !== 26) {
        console.warn('Payroll index reconciliation warning:', payrollIndexErr.message);
      }
    }
  } catch (error) {
    if (error.codeName === 'NamespaceNotFound' || error.code === 26) {
      try { await Invoice.createIndexes(); } catch (_) {}
      try { await PurchaseOrder.createIndexes(); } catch (_) {}
      return;
    }

    throw error;
  }
};

const validateReplicaSetSupport = async (connection) => {
  if (process.env.NODE_ENV === 'production') {
    try {
      const adminDb = connection.db.admin();
      const status = await adminDb.command({ isMaster: 1 });
      if (!status.setName && !status.hosts) {
        console.error('[FATAL SECURITY ERROR] MongoDB is running as a standalone instance in PRODUCTION mode!');
        console.error('MongoDB multi-document transactions require a replica set or MongoDB Atlas.');
        process.exit(1);
      }
    } catch (err) {
      console.warn('Could not verify MongoDB replica set status:', err.message);
    }
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
    await validateReplicaSetSupport(conn.connection);
    await reconcileDatabaseIndexes();
    return conn.connection;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    throw error;
  }
};

module.exports = connectDB;
