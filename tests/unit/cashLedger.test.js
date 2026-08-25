/**
 * tests/unit/cashLedger.test.js
 *
 * Tests for Cash Ledger movements, backfill idempotency,
 * and cross-report reconciliation between Balance Sheet and Cash Flow.
 */

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const User = require('../../models/User');
const CashAccount = require('../../models/CashAccount');
const CashLedgerEntry = require('../../models/CashLedgerEntry');
const Invoice = require('../../models/Invoice');
const Expense = require('../../models/Expense');
const Asset = require('../../models/Asset');
const Liability = require('../../models/Liability');

const {
  getOrCreateDefaultCashAccount,
  recordCashMovement,
  getCashBalanceAsOf,
} = require('../../utils/cashLedgerHelper');

const { backfillCashAccountsForUser } = require('../../scripts/backfill-cash-accounts');
const { getBalanceSheet } = require('../../controllers/reports/balanceSheetController');
const { getCashFlow } = require('../../controllers/reports/cashFlowController');

jest.setTimeout(120000);

describe('Cash Ledger & Cross-Report Reconciliation Tests', () => {
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
    await Invoice.deleteMany({});
    await Expense.deleteMany({});
    await Asset.deleteMany({});
    await Liability.deleteMany({});
  });

  test('recordCashMovement updates running balance and creates queryable ledger entries', async () => {
    const user = await User.create({ name: 'Ledger Test User', email: 'ledger@co.com', username: 'ltu', password: 'pw' });

    const account = await getOrCreateDefaultCashAccount(user._id);
    expect(account.currentBalance).toBe(0);

    // Inflow
    await recordCashMovement({
      user: user._id,
      account: account._id,
      amount: 15000,
      type: 'invoice_payment',
      notes: 'Payment for invoice #101',
    });

    const balAfterInflow = await getCashBalanceAsOf(user._id, new Date());
    expect(balAfterInflow.totalCash).toBe(15000);

    // Outflow
    await recordCashMovement({
      user: user._id,
      account: account._id,
      amount: -4500,
      type: 'expense_payment',
      notes: 'Office supplies',
    });

    const balAfterOutflow = await getCashBalanceAsOf(user._id, new Date());
    expect(balAfterOutflow.totalCash).toBe(10500);
  });

  test('Migration script backfill is strictly idempotent when executed multiple times', async () => {
    const user = await User.create({ name: 'Migrate User', email: 'mig@co.com', username: 'migu', password: 'pw' });

    // Seed historical documents
    await Invoice.create({
      user: user._id,
      invoiceNo: 'INV-100',
      client: { name: 'Migrate Client' },
      grandTotal: 10000,
      advancePaid: 10000,
      balanceDue: 0,
      status: 'PAID',
      date: new Date('2025-01-15T00:00:00.000Z'),
    });

    await Expense.create({
      user: user._id,
      expenseNumber: 'EXP-100',
      grandTotal: 3000,
      amountPaid: 3000,
      balanceDue: 0,
      status: 'PAID',
      date: new Date('2025-02-10T00:00:00.000Z'),
    });

    await Asset.create({
      user: user._id,
      name: 'MacBook',
      category: 'fixed',
      purchaseValue: 5000,
      purchaseDate: new Date('2025-03-01T00:00:00.000Z'),
      status: 'active',
    });

    await Liability.create({
      user: user._id,
      name: 'Bank OD',
      type: 'current',
      principalAmount: 2000,
      outstandingAmount: 2000,
      startDate: new Date('2025-04-01T00:00:00.000Z'),
      status: 'active',
    });

    // Run backfill pass 1
    const pass1 = await backfillCashAccountsForUser(user._id);
    expect(pass1.createdEntries).toBe(4);
    // Net cash: 10000 (Inv) - 3000 (Exp) - 5000 (Asset) + 2000 (Liab) = 4000
    expect(pass1.currentBalance).toBe(4000);

    const countAfterPass1 = await CashLedgerEntry.countDocuments({ user: user._id });
    expect(countAfterPass1).toBe(4);

    // Run backfill pass 2 (idempotency check)
    const pass2 = await backfillCashAccountsForUser(user._id);
    expect(pass2.createdEntries).toBe(0);
    expect(pass2.currentBalance).toBe(4000);

    const countAfterPass2 = await CashLedgerEntry.countDocuments({ user: user._id });
    expect(countAfterPass2).toBe(4);
  });

  test('Cross-Report Reconciliation: Balance Sheet cash delta equals Cash Flow report net cash flow', async () => {
    const user = await User.create({ name: 'Recon User', email: 'recon@co.com', username: 'ru', password: 'pw' });
    const account = await getOrCreateDefaultCashAccount(user._id);

    // Prior year (2025) transactions
    await recordCashMovement({
      user: user._id,
      account: account._id,
      date: new Date('2025-05-01T00:00:00.000Z'),
      amount: 12000,
      type: 'invoice_payment',
    });

    // Current year (2026) transactions
    await recordCashMovement({
      user: user._id,
      account: account._id,
      date: new Date('2026-02-15T00:00:00.000Z'),
      amount: 25000,
      type: 'invoice_payment',
    });
    await recordCashMovement({
      user: user._id,
      account: account._id,
      date: new Date('2026-04-10T00:00:00.000Z'),
      amount: -8000,
      type: 'expense_payment',
    });
    await recordCashMovement({
      user: user._id,
      account: account._id,
      date: new Date('2026-06-20T00:00:00.000Z'),
      amount: -5000,
      type: 'asset_purchase',
    });
    await recordCashMovement({
      user: user._id,
      account: account._id,
      date: new Date('2026-08-01T00:00:00.000Z'),
      amount: 10000,
      type: 'liability_draw',
    });

    // 1. Fetch Balance Sheet for 2026
    let bsData = null;
    await getBalanceSheet(
      { user, query: { year: 2026 } },
      { json: (d) => { bsData = d; }, status: jest.fn().mockReturnThis() }
    );

    const cashRow = bsData.categories.find(c => c.category === 'Cash');
    const bsCashDelta = cashRow.currentYear - cashRow.priorYear;

    // 2. Fetch Cash Flow for full year 2026
    let cfData = null;
    await getCashFlow(
      {
        companyId: user._id,
        user,
        query: { startDate: '2026-01-01', endDate: '2026-12-31' },
      },
      { json: (d) => { cfData = d; }, status: jest.fn().mockReturnThis() }
    );

    // Assert: Balance Sheet change in cash === Cash Flow netCashFlow
    // In 2026: Operating = 25000 - 8000 = 17000; Investing = -5000; Financing = 10000; Total = 22000
    expect(cfData.netCashFlow).toBe(22000);
    expect(bsCashDelta).toBe(22000);
    expect(bsData.changeInCash).toBe(22000);
  });
});
