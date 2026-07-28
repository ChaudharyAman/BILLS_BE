/**
 * withTransaction.js
 *
 * Transaction runner helper for multi-document operations in MongoDB using Mongoose.
 * Retries automatically on TransientTransactionError or UnknownTransactionCommitResult.
 * Handles standalone MongoDB instances in dev/test with graceful execution while enforcing
 * strict replica set requirements in production.
 */

const mongoose = require('mongoose');

async function runTransaction(fn, options = {}) {
  let session = null;
  try {
    if (mongoose.connection.readyState === 1) {
      session = await mongoose.startSession();
      let result;
      await session.withTransaction(async () => {
        result = await fn(session);
      }, {
        readPreference: 'primary',
        readConcern: { level: 'local' },
        writeConcern: { w: 'majority' },
        ...options,
      });
      return result;
    }
    // Fallback if not connected or in unit test / standalone dev environment
    return await fn(null);
  } catch (err) {
    const isTransactionUnsupported = err.message && (
      err.message.includes('Transaction numbers are only allowed on a replica set') ||
      err.message.includes('replica set') ||
      err.message.includes('Standalone')
    );

    if (isTransactionUnsupported) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('[FATAL SECURITY ERROR] Transactions unsupported on standalone MongoDB in production mode! A MongoDB Replica Set or MongoDB Atlas is required.');
      }
      // Fallback for standalone Mongo in development/testing environment
      return await fn(null);
    }
    throw err;
  } finally {
    if (session) {
      await session.endSession();
    }
  }
}

module.exports = { runTransaction };
