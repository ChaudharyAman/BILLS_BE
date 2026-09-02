const UNIQUE_FIELDS_MAP = {
  Client: ['name'],
  Invoice: ['invoiceNo'],
  Quote: ['quoteNo'],
  Proforma: ['proformaNo'],
  PurchaseOrder: ['poNumber'],
  Employee: ['employeeId'],
  Department: ['name', 'code'],
  Role: ['name'],
  Project: ['code'],
  Category: ['name'],
  Income: ['incomeNumber'],
  Expense: ['expenseNumber'],
  LeaveType: ['name', 'code']
};

const softDeletePlugin = (schema) => {
  schema.add({
    isDeleted: {
      type: Boolean,
      default: false,
      index: true
    },
    deletedAt: {
      type: Date,
      default: null
    }
  });

  const filterNonDeleted = function() {
    if (this.getOptions().withDeleted) {
      return;
    }
    this.where({ isDeleted: { $ne: true } });
  };

  schema.pre('find', filterNonDeleted);
  schema.pre('findOne', filterNonDeleted);
  schema.pre('findOneAndUpdate', filterNonDeleted);
  schema.pre('updateMany', filterNonDeleted);
  schema.pre('countDocuments', filterNonDeleted);

  // Hook for updateMany: handle bulk soft delete name-suffixing for unique fields
  schema.pre('updateMany', async function() {
    const update = this.getUpdate();
    const modelName = this.model.modelName;

    if (update && update.$set && update.$set.isDeleted === true) {
      const uniqueFields = UNIQUE_FIELDS_MAP[modelName] || [];
      if (uniqueFields.length > 0) {
        const docs = await this.model.find(this.getQuery()).setOptions({ withDeleted: true });
        for (const doc of docs) {
          const $set = {};
          uniqueFields.forEach(field => {
            if (doc[field] && typeof doc[field] === 'string' && !doc[field].includes('_del_')) {
              $set[field] = `${doc[field]}_del_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
            }
          });
          if (Object.keys($set).length > 0) {
            await this.model.updateOne({ _id: doc._id }, { $set });
          }
        }
      }
    }
  });

  // Hook for findOneAndUpdate: handle soft delete name-suffixing and restore collision checks
  schema.pre('findOneAndUpdate', async function() {
    const update = this.getUpdate();
    const modelName = this.model.modelName;

    // 1. Soft Delete: Suffix unique fields to avoid database constraint errors
    if (update && update.$set && update.$set.isDeleted === true) {
      const doc = await this.model.findOne(this.getQuery()).setOptions({ withDeleted: true });
      if (doc) {
        const uniqueFields = UNIQUE_FIELDS_MAP[modelName] || [];
        uniqueFields.forEach(field => {
          if (doc[field] && typeof doc[field] === 'string' && !doc[field].includes('_del_')) {
            update.$set[field] = `${doc[field]}_del_${Date.now()}`;
          }
        });
      }
    }

    // 2. Restore: Clean suffixes and check for collisions
    if (update && update.$set && update.$set.isDeleted === false) {
      const doc = await this.model.findOne(this.getQuery()).setOptions({ withDeleted: true });
      if (doc) {
        const uniqueFields = UNIQUE_FIELDS_MAP[modelName] || [];
        const originalValues = {};

        uniqueFields.forEach(field => {
          if (doc[field] && typeof doc[field] === 'string' && doc[field].includes('_del_')) {
            originalValues[field] = doc[field].split('_del_')[0];
          }
        });

        if (Object.keys(originalValues).length > 0) {
          // Check if an active document already exists with the original value(s)
          const userId = doc.user || this.getQuery().user;
          const collisionQuery = { ...originalValues, isDeleted: { $ne: true } };
          if (userId) {
            collisionQuery.user = userId;
          }

          const collidingDoc = await this.model.findOne(collisionQuery);
          if (collidingDoc) {
            if (this.getOptions().forceRestore) {
              // Overwrite: delete the active colliding item
              await this.model.deleteOne({ _id: collidingDoc._id });
            } else {
              // Reject with a COLLISION error
              const err = new Error('COLLISION');
              err.collidingId = collidingDoc._id;
              throw err;
            }
          }

          // Restore original values
          Object.assign(update.$set, originalValues);
        }
      }
    }
  });
};

module.exports = softDeletePlugin;
