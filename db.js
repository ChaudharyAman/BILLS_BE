const mongoose = require('mongoose');

const reconcileModelIndexes = async (Model) => {
  try {
    const existingIndexes = await Model.collection.indexes();
    for (const existing of existingIndexes) {
      if (existing.name === '_id_') continue;
      const keys = Object.keys(existing.key || {});

      // 1. Obsolete ancient single-field indexes (e.g. poNumber_1, invoiceNo_1, expenseNumber_1)
      const isAncientSingleKey = keys.length === 1 && ['poNumber', 'invoiceNo', 'expenseNumber', 'quoteNo', 'proformaNo', 'incomeNumber'].includes(keys[0]);
      const isAncientNamedIndex = ['poNumber_1', 'invoiceNo_1', 'expenseNumber_1', 'quoteNo_1', 'proformaNo_1', 'incomeNumber_1'].includes(existing.name);
      if (isAncientSingleKey || isAncientNamedIndex) {
        console.log(`[db.js] Dropping obsolete single-key index: ${Model.collection.collectionName}.${existing.name}`);
        try {
          await Model.collection.dropIndex(existing.name);
        } catch (dropErr) {
          console.warn(`[db.js] Could not drop single-key index ${Model.collection.collectionName}.${existing.name}:`, dropErr.message);
        }
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

      // 3. Legacy unscoped profile-first unique indexes:
      // Any unique index whose key starts with profile (or only contains profile) but lacks user / companyId / owner.
      // e.g. profile_1_invoiceNo_1, profile_1_expenseNumber_1, profile_1_sourceInvoice_1, profile_1_name_1, etc.
      const startsWithProfile = Number(existing.key?.profile) === 1;
      const hasTenantOwner = ('user' in (existing.key || {})) || ('companyId' in (existing.key || {})) || ('owner' in (existing.key || {}));
      if (existing.unique && startsWithProfile && !hasTenantOwner) {
        console.log(`[db.js] Dropping legacy user-unscoped profile unique index: ${Model.collection.collectionName}.${existing.name}`);
        try {
          await Model.collection.dropIndex(existing.name);
        } catch (_) {}
        continue;
      }

      // 4. Stale Income sourceInvoice unique index lacking objectId partial filter
      // (Without this partial filter, documents with sourceInvoice: null collide and throw E11000 duplicate key error)
      if (Model.modelName === 'Income' && existing.unique && 'sourceInvoice' in (existing.key || {})) {
        const hasValidPartial = existing.partialFilterExpression?.sourceInvoice?.['$type'] === 'objectId';
        if (!hasValidPartial) {
          console.log(`[db.js] Dropping stale income sourceInvoice unique index lacking objectId filter: ${Model.collection.collectionName}.${existing.name}`);
          try {
            await Model.collection.dropIndex(existing.name);
          } catch (_) {}
          continue;
        }
      }

      // 5. Incompatible or stale payroll indexes (e.g. sparse mixed with partialFilterExpression or missing isDeleted filter)
      if (Model.modelName === 'Payroll' && (
        existing.sparse ||
        (existing.name && existing.name.includes('employee_1_month_1_year_1') && existing.sparse) ||
        (existing.unique && (!existing.partialFilterExpression || existing.partialFilterExpression.isDeleted !== false))
      )) {
        console.log(`[db.js] Dropping stale/incompatible payroll index: ${Model.collection.collectionName}.${existing.name}`);
        try {
          await Model.collection.dropIndex(existing.name);
        } catch (dropErr) {
          console.warn(`[db.js] Could not drop payroll index ${existing.name}:`, dropErr.message);
        }
        continue;
      }

      // 6. Generic check: Drop any index where partialFilterExpression and sparse are illegally combined
      if (existing.partialFilterExpression && existing.sparse) {
        console.log(`[db.js] Dropping illegally mixed partialFilterExpression + sparse index: ${Model.collection.collectionName}.${existing.name}`);
        try {
          await Model.collection.dropIndex(existing.name);
        } catch (_) {}
        continue;
      }

      // 7. Stale settings user_1 or stale profile_1
      if (Model.modelName === 'Settings') {
        if (existing.name === 'user_1' && existing.unique) {
          console.log(`[db.js] Dropping stale unique settings.user_1 index`);
          try {
            await Model.collection.dropIndex(existing.name);
          } catch (_) {}
          continue;
        }
        if (existing.name === 'profile_1') {
          console.log(`[db.js] Dropping stale settings.profile_1 index`);
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
      // Auto-heal: If MongoDB reports code 85 ("An existing index has the same name as the requested index")
      // or "cannot mix partialFilterExpression and sparse", extract the index name, drop it, and retry createIndexes once.
      const isNameConflict = createErr.code === 85 || (createErr.message && createErr.message.includes('An existing index has the same name'));
      const isSparsePartialConflict = createErr.message && createErr.message.includes('cannot mix "partialFilterExpression" and "sparse"');

      if (isNameConflict || isSparsePartialConflict) {
        const existingNameMatch = createErr.message.match(/name:\s*"([^"]+)"/) || createErr.message.match(/existing index:[\s\S]*?name:\s*"([^"]+)"/);
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
        console.warn(`[db.js] Index reconciliation for ${Model.modelName || Model.collection?.collectionName}:`, createErr.message);
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

connectDB.reconcileDatabaseIndexes = reconcileDatabaseIndexes;
connectDB.reconcileModelIndexes = reconcileModelIndexes;

module.exports = connectDB;
