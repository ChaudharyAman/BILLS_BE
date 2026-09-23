const mongoose = require('mongoose');

const reconcileModelIndexes = async (Model) => {
  try {
    const existingIndexes = await Model.collection.indexes();
    for (const existing of existingIndexes) {
      if (existing.name === '_id_') continue;
      const keys = Object.keys(existing.key || {});

      // 1. Obsolete ancient single-field indexes (e.g. poNumber_1, invoiceNo_1)
      if (keys.length === 1 && ['poNumber', 'invoiceNo', 'expenseNumber', 'quoteNo', 'proformaNo', 'incomeNumber'].includes(keys[0])) {
        console.log(`[db.js] Dropping obsolete single-key index: ${Model.collection.collectionName}.${existing.name}`);
        try {
          await Model.collection.dropIndex(existing.name);
        } catch (_) {}
        continue;
      }

      // 2. Legacy unique indexes on { user: 1, ... } or { companyId: 1, ... } that lack profile scoping
      // Any unique index whose key starts with user/companyId, but lacks profile in its key and
      // lacks profile in its partialFilterExpression, is the old single-tenant index that conflicts.
      const isUserScoped = (Number(existing.key?.user) === 1 || Number(existing.key?.companyId) === 1);
      const hasProfileInKey = 'profile' in (existing.key || {});
      const hasProfileInFilter = Boolean(existing.partialFilterExpression && ('profile' in existing.partialFilterExpression));

      if (existing.unique && isUserScoped && !hasProfileInKey && !hasProfileInFilter) {
        console.log(`[db.js] Dropping legacy unscoped unique index: ${Model.collection.collectionName}.${existing.name}`);
        try {
          await Model.collection.dropIndex(existing.name);
        } catch (_) {}
        continue;
      }

      // 3. Stale payroll index lacking isDeleted partial filter
      if (Model.modelName === 'Payroll' && existing.unique && (!existing.partialFilterExpression || existing.partialFilterExpression.isDeleted !== false)) {
        console.log(`[db.js] Dropping stale payroll index: ${Model.collection.collectionName}.${existing.name}`);
        try {
          await Model.collection.dropIndex(existing.name);
        } catch (_) {}
        continue;
      }

      // 4. Stale settings user_1 or non-unique profile_1
      if (Model.modelName === 'Settings') {
        if (existing.name === 'user_1' && existing.unique) {
          console.log(`[db.js] Dropping stale unique settings.user_1 index`);
          try {
            await Model.collection.dropIndex(existing.name);
          } catch (_) {}
          continue;
        }
        if (existing.name === 'profile_1' && !existing.unique) {
          console.log(`[db.js] Dropping stale non-unique settings.profile_1 index`);
          try {
            await Model.collection.dropIndex(existing.name);
          } catch (_) {}
          continue;
        }
      }
    }

    try {
      await Model.createIndexes();
    } catch (createErr) {
      // Auto-heal: If MongoDB reports code 85 ("An existing index has the same name as the requested index"),
      // extract the existing index name, drop it, and retry createIndexes once.
      if (createErr.code === 85 || (createErr.message && createErr.message.includes('An existing index has the same name'))) {
        const existingNameMatch = createErr.message.match(/existing index:[\s\S]*?name:\s*"([^"]+)"/);
        const conflictingName = existingNameMatch ? existingNameMatch[1] : null;

        if (conflictingName) {
          console.log(`[db.js] Auto-healing: dropping conflicting index ${Model.collection.collectionName}.${conflictingName}`);
          try {
            await Model.collection.dropIndex(conflictingName);
            await Model.createIndexes();
          } catch (retryErr) {
            console.warn(`[db.js] Auto-heal retry for ${Model.collection.collectionName}:`, retryErr.message);
          }
        } else {
          console.warn(`[db.js] Index conflict for ${Model.collection.collectionName}:`, createErr.message);
        }
      } else {
        throw createErr;
      }
    }
  } catch (err) {
    if (err.codeName !== 'NamespaceNotFound' && err.code !== 26) {
      console.warn(`[db.js] Index reconciliation for ${Model.modelName || Model.collection?.collectionName}:`, err.message);
    }
  }
};

const reconcileDatabaseIndexes = async () => {
  const models = [
    require('./models/Invoice'),
    require('./models/PurchaseOrder'),
    require('./models/Quote'),
    require('./models/Proforma'),
    require('./models/Expense'),
    require('./models/Income'),
    require('./models/Client'),
    require('./models/Employee'),
    require('./models/Category'),
    require('./models/Department'),
    require('./models/BusinessUnit'),
    require('./models/Project'),
    require('./models/Role'),
    require('./models/LeaveType'),
    require('./models/LeaveBalance'),
    require('./models/CashAccount'),
    require('./models/DocumentFolder'),
    require('./models/Item'),
    require('./models/Settings'),
    require('./models/AccessRole'),
    require('./models/Payroll'),
    require('./models/PayrollConfig'),
  ];

  for (const Model of models) {
    await reconcileModelIndexes(Model);
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
    mongoose.set('autoIndex', false);

    if (mongoose.connection.readyState === 1) {
      await reconcileDatabaseIndexes();
      return mongoose.connection;
    }

    if (mongoose.connection.readyState === 2) {
      const connection = await mongoose.connection.asPromise();
      await reconcileDatabaseIndexes();
      return connection;
    }

    const conn = await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
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
