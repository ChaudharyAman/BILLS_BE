/**
 * tests/unit/equityController.test.js
 *
 * Tests for Equity Transactions CRUD and automatic cash ledger synchronization.
 */

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const User = require('../../models/User');
const CashAccount = require('../../models/CashAccount');
const CashLedgerEntry = require('../../models/CashLedgerEntry');
const EquityTransaction = require('../../models/EquityTransaction');

const {
  getEquityTransactions,
  createEquityTransaction,
  updateEquityTransaction,
  deleteEquityTransaction,
} = require('../../controllers/equityController');

jest.setTimeout(120000);

describe('Equity Controller Tests', () => {
  let replSet;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = replSet.getUri();
    await mongoose.connect(uri);
  }, 120000);

  afterAll(async () => {
    await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  afterEach(async () => {
    await User.deleteMany({});
    await CashAccount.deleteMany({});
    await CashLedgerEntry.deleteMany({});
    await EquityTransaction.deleteMany({});
  });

  test('Creating equity contribution creates EquityTransaction and posts to CashLedgerEntry', async () => {
    const user = await User.create({ name: 'Founder User', email: 'founder@co.com', username: 'fu', password: 'pw' });

    const req = {
      user,
      companyId: user._id,
      body: {
        type: 'owner_contribution',
        amount: 100000,
        date: '2026-01-10',
        notes: 'Initial founder capital',
        postToCash: true,
      },
    };

    let createdDoc = null;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: (d) => { createdDoc = d; },
    };

    await createEquityTransaction(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(createdDoc).toBeDefined();
    expect(createdDoc.amount).toBe(100000);
    expect(createdDoc.commonStockAmount).toBe(100000);
    expect(createdDoc.type).toBe('owner_contribution');

    // Verify linked cash ledger entry
    const cashEntry = await CashLedgerEntry.findOne({
      user: user._id,
      sourceModel: 'EquityTransaction',
      sourceId: createdDoc._id,
    });

    expect(cashEntry).toBeDefined();
    expect(cashEntry.amount).toBe(100000);
    expect(cashEntry.type).toBe('capital_contribution');
  });

  test('Share Issuance automatically calculates Common Stock par value and APIC premium split', async () => {
    const user = await User.create({ name: 'Investor User', email: 'inv@co.com', username: 'iu', password: 'pw' });

    // 1000 shares at ₹100/share, par value ₹10
    // Total = ₹1,00,000 => Common Stock = ₹10,000, APIC = ₹90,000
    const req = {
      user,
      companyId: user._id,
      body: {
        type: 'share_issuance',
        shares: 1000,
        pricePerShare: 100,
        parValue: 10,
        date: '2026-02-15',
        notes: 'Angel round funding',
        postToCash: true,
      },
    };

    let createdDoc = null;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: (d) => { createdDoc = d; },
    };

    await createEquityTransaction(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(createdDoc).toBeDefined();
    expect(createdDoc.amount).toBe(100000);
    expect(createdDoc.commonStockAmount).toBe(10000);
    expect(createdDoc.apicAmount).toBe(90000);
  });

  test('Rejects invalid equity type or negative amount with 400', async () => {
    const user = await User.create({ name: 'Test User', email: 'tu@co.com', username: 'tu', password: 'pw' });

    const reqBadType = {
      user,
      companyId: user._id,
      body: { type: 'invalid_type', amount: 5000 },
    };

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await createEquityTransaction(reqBadType, res);
    expect(res.status).toHaveBeenCalledWith(400);

    const reqBadAmt = {
      user,
      companyId: user._id,
      body: { type: 'owner_contribution', amount: -500 },
    };

    await createEquityTransaction(reqBadAmt, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
