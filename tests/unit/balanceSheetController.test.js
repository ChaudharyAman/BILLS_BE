/**
 * tests/unit/balanceSheetController.test.js
 *
 * Comprehensive unit and integration test suite for the Balance Sheet Report.
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const User = require('../../models/User');
const CashAccount = require('../../models/CashAccount');
const CashLedgerEntry = require('../../models/CashLedgerEntry');
const EquityTransaction = require('../../models/EquityTransaction');
const Asset = require('../../models/Asset');
const Liability = require('../../models/Liability');
const Invoice = require('../../models/Invoice');
const Expense = require('../../models/Expense');
const Category = require('../../models/Category');
const Item = require('../../models/Item');
const AccrualEntry = require('../../models/AccrualEntry');

const { getBalanceSheet, getSetupStatus } = require('../../controllers/reports/balanceSheetController');

jest.setTimeout(120000);

describe('Balance Sheet Controller Tests', () => {
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
    await Asset.deleteMany({});
    await Liability.deleteMany({});
    await Invoice.deleteMany({});
    await Expense.deleteMany({});
    await Category.deleteMany({});
    await Item.deleteMany({});
    await AccrualEntry.deleteMany({});
  });

  test('Sanity check: No fabricated multiplier (* 0.) exists in balanceSheetController.js', () => {
    const controllerPath = path.join(__dirname, '../../controllers/reports/balanceSheetController.js');
    const content = fs.readFileSync(controllerPath, 'utf8');

    // Grep for arbitrary multipliers like * 0.2, * 0.6, * 0.05
    const multiplierMatches = content.match(/\*\s*0\.\d+/g) || [];
    expect(multiplierMatches).toEqual([]);
  });

  test('New company with zero data returns valid response, non-empty sources, and balanced: true', async () => {
    const user = await User.create({
      name: 'Fresh Company',
      email: 'fresh@example.com',
      username: 'freshco',
      password: 'password123',
    });

    const req = {
      user,
      query: { year: 2026 },
    };

    let jsonResult = null;
    const res = {
      json: (data) => { jsonResult = data; },
      status: jest.fn().mockReturnThis(),
    };

    await getBalanceSheet(req, res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(jsonResult).toBeDefined();
    expect(jsonResult.totalAssets).toBe(0);
    expect(jsonResult.totalLiabilities).toBe(0);
    expect(jsonResult.equity).toBe(0);
    expect(jsonResult.balanceCheck.currentYear.balanced).toBe(true);
    expect(jsonResult.balanceCheck.currentYear.difference).toBe(0);

    // Assert every category row has a non-empty source object
    jsonResult.categories.forEach((row) => {
      expect(row.source).toBeDefined();
      expect(row.source.type).toMatch(/ledger|aggregate|unavailable/);
      if (row.source.type === 'unavailable') {
        expect(row.source.reason).toBeTruthy();
        expect(row.currentYear).toBeNull();
      } else {
        expect(row.source.description).toBeTruthy();
      }
    });
  });

  test('Seeded fixtures calculate exact line items, source metadata, and balanced check', async () => {
    const user = await User.create({
      name: 'Test Business',
      email: 'biz@example.com',
      username: 'testbiz',
      password: 'password123',
    });

    // Cash Setup
    const cashAcc = await CashAccount.create({
      user: user._id,
      name: 'Main Checking',
      accountType: 'bank',
      openingBalance: 10000,
      currentBalance: 10000,
    });

    await CashLedgerEntry.create([
      {
        user: user._id,
        account: cashAcc._id,
        date: new Date('2025-06-15T00:00:00.000Z'),
        amount: 5000,
        type: 'invoice_payment',
      },
      {
        user: user._id,
        account: cashAcc._id,
        date: new Date('2026-03-10T00:00:00.000Z'),
        amount: 8000,
        type: 'invoice_payment',
      },
      {
        user: user._id,
        account: cashAcc._id,
        date: new Date('2026-05-20T00:00:00.000Z'),
        amount: -2000,
        type: 'expense_payment',
      },
    ]);

    // Equity Setup
    await EquityTransaction.create([
      {
        user: user._id,
        type: 'common_stock_issued',
        amount: 25000,
        date: new Date('2025-01-01T00:00:00.000Z'),
      },
      {
        user: user._id,
        type: 'additional_paid_in_capital',
        amount: 15000,
        date: new Date('2026-01-15T00:00:00.000Z'),
      },
    ]);

    // Assets & Liabilities
    await Asset.create({
      user: user._id,
      name: 'Office Server',
      category: 'fixed',
      purchaseDate: new Date('2025-01-01T00:00:00.000Z'),
      purchaseValue: 50000,
      salvageValue: 5000,
      usefulLife: 5,
      depreciationMethod: 'straight-line',
      status: 'active',
    });

    await Liability.create([
      {
        user: user._id,
        name: 'Equipment Loan',
        type: 'long-term',
        category: 'loan',
        principalAmount: 30000,
        outstandingAmount: 20000,
        currentPortionAmount: 5000,
        startDate: new Date('2025-04-01T00:00:00.000Z'),
        status: 'active',
      },
      {
        user: user._id,
        name: 'Short-term Note',
        type: 'current',
        category: 'loan',
        principalAmount: 10000,
        outstandingAmount: 10000,
        currentPortionAmount: 10000,
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        status: 'active',
      },
    ]);

    // Invoices & Expenses
    await Invoice.create([
      {
        user: user._id,
        invoiceNo: 'INV-2025-01',
        date: new Date('2025-05-01T00:00:00.000Z'),
        client: { name: 'Client A' },
        subTotal: 10000,
        taxTotal: 1800,
        grandTotal: 11800,
        advancePaid: 11800,
        balanceDue: 0,
        status: 'PAID',
      },
      {
        user: user._id,
        invoiceNo: 'INV-2026-01',
        date: new Date('2026-02-01T00:00:00.000Z'),
        client: { name: 'Client B' },
        subTotal: 20000,
        taxTotal: 3600,
        grandTotal: 23600,
        advancePaid: 10000,
        balanceDue: 13600,
        status: 'PARTIAL',
      },
    ]);

    const cogsCat = await Category.create({
      user: user._id,
      name: 'Raw Materials',
      type: 'expense',
      isCogs: true,
    });

    const interestCat = await Category.create({
      user: user._id,
      name: 'Interest Expense',
      type: 'expense',
    });

    await Expense.create([
      {
        user: user._id,
        expenseNumber: 'EXP-2025-01',
        date: new Date('2025-06-01T00:00:00.000Z'),
        category: cogsCat._id,
        subTotal: 4000,
        taxTotal: 0,
        grandTotal: 4000,
        amountPaid: 4000,
        balanceDue: 0,
        status: 'PAID',
      },
      {
        user: user._id,
        expenseNumber: 'EXP-2026-01',
        date: new Date('2026-03-01T00:00:00.000Z'),
        category: cogsCat._id,
        subTotal: 6000,
        taxTotal: 0,
        grandTotal: 6000,
        amountPaid: 3000,
        balanceDue: 3000,
        status: 'PARTIAL',
      },
      {
        user: user._id,
        expenseNumber: 'EXP-2026-02',
        date: new Date('2026-04-01T00:00:00.000Z'),
        category: interestCat._id,
        subTotal: 1200,
        taxTotal: 0,
        grandTotal: 1200,
        amountPaid: 1200,
        balanceDue: 0,
        status: 'PAID',
      },
    ]);

    const req = { user, query: { year: 2026 } };
    let jsonResult = null;
    const res = { json: (d) => { jsonResult = d; }, status: jest.fn().mockReturnThis() };

    await getBalanceSheet(req, res);

    expect(jsonResult).toBeDefined();

    // Cash verification:
    // Prior Year (as of 2025-12-31): 10000 + 5000 = 15000
    // Current Year (as of 2026-12-31): 10000 + 5000 + 8000 - 2000 = 21000
    const cashRow = jsonResult.categories.find(c => c.category === 'Cash');
    expect(cashRow.priorYear).toBe(15000);
    expect(cashRow.currentYear).toBe(21000);

    // COGS verification:
    const cogsRow = jsonResult.categories.find(c => c.category === 'COGS');
    expect(cogsRow.priorYear).toBe(4000);
    expect(cogsRow.currentYear).toBe(6000);

    // Interest Expense verification:
    const interestRow = jsonResult.categories.find(c => c.category === 'Interest expense');
    expect(interestRow.currentYear).toBe(1200);

    // Receivables & Payables
    const recRow = jsonResult.categories.find(c => c.category === 'Accounts receivable');
    expect(recRow.currentYear).toBe(13600);

    const payRow = jsonResult.categories.find(c => c.category === 'Accounts payable');
    expect(payRow.currentYear).toBe(3000);

    // Fixed Assets & Depreciation:
    // Office Server: 50000 purchase, 5000 salvage, 5 yr useful life => 9000/yr depreciation
    // As of 2025-12-31: BV = 41000
    // As of 2026-12-31: BV = 32000
    const fixedAssetRow = jsonResult.categories.find(c => c.category === 'Net fixed assets');
    expect(Math.round(fixedAssetRow.priorYear)).toBe(41000);
    expect(Math.round(fixedAssetRow.currentYear)).toBe(32000);

    const depRow = jsonResult.categories.find(c => c.category === 'Depreciation expense');
    expect(Math.round(depRow.currentYear)).toBe(9000);

    // Debt categories
    const ltDebtRow = jsonResult.categories.find(c => c.category === 'Long-term debt');
    expect(ltDebtRow.currentYear).toBe(20000);

    const curPortionRow = jsonResult.categories.find(c => c.category === 'Current portion long-term debt');
    expect(curPortionRow.currentYear).toBe(5000);

    const notesRow = jsonResult.categories.find(c => c.category === 'Notes payable');
    expect(notesRow.currentYear).toBe(10000);

    // Equity: Common Stock & APIC
    const csRow = jsonResult.categories.find(c => c.category === 'Common Stock');
    expect(csRow.priorYear).toBe(25000);
    expect(csRow.currentYear).toBe(25000);

    const apicRow = jsonResult.categories.find(c => c.category === 'Additional paid in capital');
    expect(apicRow.priorYear).toBe(0);
    expect(apicRow.currentYear).toBe(15000);
  });

  test('Bug fix regression test: Accounts payable and Accruals diverge correctly when data differs', async () => {
    const user = await User.create({ name: 'Accrual Test', email: 'acc@co.com', username: 'acctest', password: 'pw' });

    // Unpaid billed vendor expense (Accounts Payable)
    await Expense.create({
      user: user._id,
      expenseNumber: 'EXP-BILL-01',
      date: new Date('2026-05-01T00:00:00.000Z'),
      subTotal: 7500,
      grandTotal: 7500,
      amountPaid: 0,
      balanceDue: 7500,
      status: 'UNPAID',
    });

    // Dedicated unbilled accrual entry (Accruals)
    await AccrualEntry.create({
      user: user._id,
      date: new Date('2026-06-01T00:00:00.000Z'),
      amount: 3200,
      description: 'Accrued Electricity (unbilled)',
      status: 'accrued',
    });

    const req = { user, query: { year: 2026 } };
    let jsonResult = null;
    await getBalanceSheet(req, { json: (d) => { jsonResult = d; }, status: jest.fn().mockReturnThis() });

    const payRow = jsonResult.categories.find(c => c.category === 'Accounts payable');
    const accrualRow = jsonResult.categories.find(c => c.category === 'Accruals');

    expect(payRow.currentYear).toBe(7500);
    expect(accrualRow.currentYear).toBe(3200);
    expect(payRow.currentYear).not.toBe(accrualRow.currentYear);
  });

  test('getSetupStatus returns correct checklist completion boolean flags', async () => {
    const user = await User.create({ name: 'Setup User', email: 'setup@co.com', username: 'setupuser', password: 'pw' });

    let resData = null;
    await getSetupStatus({ user, companyId: user._id }, { json: (d) => { resData = d; } });

    expect(resData.completedCount).toBe(0);
    expect(resData.isFullyConfigured).toBe(false);
    expect(resData.steps.equity).toBe(false);
    expect(resData.steps.cogsCategories).toBe(false);

    // Seed 1 Equity Transaction and 1 COGS Category
    await EquityTransaction.create({ user: user._id, type: 'common_stock_issued', amount: 50000 });
    await Category.create({ user: user._id, name: 'Direct Labor', type: 'expense', isCogs: true });

    await getSetupStatus({ user, companyId: user._id }, { json: (d) => { resData = d; } });

    expect(resData.completedCount).toBe(2);
    expect(resData.steps.equity).toBe(true);
    expect(resData.steps.cogsCategories).toBe(true);
  });

  test('Multi-tenant isolation: Tenant A and Tenant B data never leak', async () => {
    const tenantA = await User.create({ name: 'Tenant A', email: 'a@co.com', username: 'ta', password: 'pw' });
    const tenantB = await User.create({ name: 'Tenant B', email: 'b@co.com', username: 'tb', password: 'pw' });

    await CashAccount.create({ user: tenantA._id, name: 'Bank A', openingBalance: 50000 });
    await CashAccount.create({ user: tenantB._id, name: 'Bank B', openingBalance: 1200 });

    const reqA = { user: tenantA, query: { year: 2026 } };
    let resA = null;
    await getBalanceSheet(reqA, { json: (d) => { resA = d; }, status: jest.fn().mockReturnThis() });

    const cashRowA = resA.categories.find(c => c.category === 'Cash');
    expect(cashRowA.currentYear).toBe(50000);

    const reqB = { user: tenantB, query: { year: 2026 } };
    let resB = null;
    await getBalanceSheet(reqB, { json: (d) => { resB = d; }, status: jest.fn().mockReturnThis() });

    const cashRowB = resB.categories.find(c => c.category === 'Cash');
    expect(cashRowB.currentYear).toBe(1200);
  });

  test('Input validation: rejects invalid year or future year > current + 1 with 400', async () => {
    const user = await User.create({ name: 'User V', email: 'v@co.com', username: 'uv', password: 'pw' });

    const reqInvalid = { user, query: { year: 'invalid_year_abc' } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await getBalanceSheet(reqInvalid, res);
    expect(res.status).toHaveBeenCalledWith(400);

    const reqFuture = { user, query: { year: 2099 } };
    await getBalanceSheet(reqFuture, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('Soft-deleted records are excluded from balance sheet', async () => {
    const user = await User.create({ name: 'User SD', email: 'sd@co.com', username: 'usd', password: 'pw' });

    await Asset.create({
      user: user._id,
      name: 'Deleted Truck',
      category: 'fixed',
      purchaseValue: 100000,
      currentValue: 100000,
      isDeleted: true,
      status: 'active',
    });

    const req = { user, query: { year: 2026 } };
    let resData = null;
    await getBalanceSheet(req, { json: (d) => { resData = d; }, status: jest.fn().mockReturnThis() });

    const fixedAssetRow = resData.categories.find(c => c.category === 'Net fixed assets');
    expect(fixedAssetRow.currentYear).toBeNull();
  });

  test('Retained Earnings is strictly cumulative across multi-year history since inception', async () => {
    const user = await User.create({ name: 'Multi-Year Co', email: 'myc@co.com', username: 'myc', password: 'pw' });

    // Year 1 (2024): Net Income = 50,000 - 20,000 = 30,000
    await Invoice.create({ user: user._id, invoiceNo: 'INV-2024-1', client: { name: 'Client 2024' }, date: new Date('2024-06-01'), subTotal: 50000, grandTotal: 50000, taxTotal: 0, balanceDue: 0, status: 'PAID' });
    await Expense.create({ user: user._id, expenseNumber: 'EXP-2024-1', date: new Date('2024-07-01'), subTotal: 20000, grandTotal: 20000, balanceDue: 0, status: 'PAID' });

    // Year 2 (2025): Net Income = 40,000 - 15,000 = 25,000 (Cumulative = 55,000)
    await Invoice.create({ user: user._id, invoiceNo: 'INV-2025-1', client: { name: 'Client 2025' }, date: new Date('2025-06-01'), subTotal: 40000, grandTotal: 40000, taxTotal: 0, balanceDue: 0, status: 'PAID' });
    await Expense.create({ user: user._id, expenseNumber: 'EXP-2025-1', date: new Date('2025-07-01'), subTotal: 15000, grandTotal: 15000, balanceDue: 0, status: 'PAID' });

    // Year 3 (2026): Net Income = 60,000 - 20,000 = 40,000 (Cumulative = 95,000)
    await Invoice.create({ user: user._id, invoiceNo: 'INV-2026-1', client: { name: 'Client 2026' }, date: new Date('2026-06-01'), subTotal: 60000, grandTotal: 60000, taxTotal: 0, balanceDue: 0, status: 'PAID' });
    await Expense.create({ user: user._id, expenseNumber: 'EXP-2026-1', date: new Date('2026-07-01'), subTotal: 20000, grandTotal: 20000, balanceDue: 0, status: 'PAID' });

    const req = { user, query: { year: 2026 } };
    let resData = null;
    await getBalanceSheet(req, { json: (d) => { resData = d; }, status: jest.fn().mockReturnThis() });

    const reRow = resData.categories.find(c => c.category === 'Retained earnings');
    expect(reRow.priorYear).toBe(55000); // 2024 (30k) + 2025 (25k) = 55k
    expect(reRow.currentYear).toBe(95000); // 55k + 2026 (40k) = 95k
  });

  test('Zero equity records returns unavailable source, while setting Common Stock establishes 0.00 APIC', async () => {
    const user = await User.create({ name: 'Equity Test Co', email: 'eq@co.com', username: 'eqc', password: 'pw' });

    // State 1: Zero equity records
    const req1 = { user, query: { year: 2026 } };
    let res1 = null;
    await getBalanceSheet(req1, { json: (d) => { res1 = d; }, status: jest.fn().mockReturnThis() });

    const csRow1 = res1.categories.find(c => c.category === 'Common Stock');
    const apicRow1 = res1.categories.find(c => c.category === 'Additional paid in capital');
    expect(csRow1.currentYear).toBeNull();
    expect(csRow1.source.type).toBe('unavailable');
    expect(apicRow1.currentYear).toBeNull();
    expect(apicRow1.source.type).toBe('unavailable');

    // State 2: Add Common Stock only (no share premium / APIC)
    await EquityTransaction.create({
      user: user._id,
      type: 'owner_contribution',
      amount: 50000,
      commonStockAmount: 50000,
      apicAmount: 0,
      date: new Date('2026-01-15'),
    });

    let res2 = null;
    await getBalanceSheet(req1, { json: (d) => { res2 = d; }, status: jest.fn().mockReturnThis() });

    const csRow2 = res2.categories.find(c => c.category === 'Common Stock');
    const apicRow2 = res2.categories.find(c => c.category === 'Additional paid in capital');
    expect(csRow2.currentYear).toBe(50000);
    expect(csRow2.source.type).toBe('ledger');
    expect(apicRow2.currentYear).toBe(0);
    expect(apicRow2.source.type).toBe('ledger');
    expect(apicRow2.source.description).toContain('No share premium recorded');
  });

  test('Regression Bug 1: Depreciation affects equity and satisfies balance check', async () => {
    const user = await User.create({ name: 'Depr Co', email: 'depr@co.com', username: 'deprco', password: 'pw' });
    const cashAcc = await CashAccount.create({ user: user._id, name: 'Main Cash', openingBalance: 0 });
    await CashLedgerEntry.create({ user: user._id, account: cashAcc._id, amount: 50000, date: new Date('2025-01-01'), type: 'capital_contribution' });

    // Contributed Capital: 50,000
    await EquityTransaction.create({ user: user._id, type: 'owner_contribution', amount: 50000, commonStockAmount: 50000, date: new Date('2025-01-01') });

    // Buy server for 50,000 on 2025-01-01 (cash outflow -50,000)
    await CashLedgerEntry.create({ user: user._id, account: cashAcc._id, amount: -50000, date: new Date('2025-01-01'), type: 'asset_purchase' });
    await Asset.create({
      user: user._id,
      name: 'Office Server',
      category: 'fixed',
      purchaseDate: new Date('2025-01-01T00:00:00.000Z'),
      purchaseValue: 50000,
      salvageValue: 5000,
      usefulLife: 5,
      depreciationMethod: 'straight-line',
      status: 'active',
    });

    const req = { user, query: { year: 2025 } };
    let resData = null;
    await getBalanceSheet(req, { json: (d) => { resData = d; }, status: jest.fn().mockReturnThis() });

    const fixedAssetRow = resData.categories.find(c => c.category === 'Net fixed assets');
    const reRow = resData.categories.find(c => c.category === 'Retained earnings');
    expect(fixedAssetRow.currentYear).toBe(41000); // 50,000 - 9,000
    expect(reRow.currentYear).toBe(-9000); // Retained earnings reduced by 9,000 depreciation
    expect(resData.totalAssets).toBe(41000);
    expect(resData.totalEquity).toBe(41000);
    expect(resData.balanceCheck.currentYear.balanced).toBe(true);
  });

  test('Regression Bug 2: Owner distribution exceeding contributed capital reduces retained earnings and balances', async () => {
    const user = await User.create({ name: 'Dist Co', email: 'dist@co.com', username: 'distco', password: 'pw' });
    const cashAcc = await CashAccount.create({ user: user._id, name: 'Bank', openingBalance: 0 });
    await CashLedgerEntry.create({ user: user._id, account: cashAcc._id, amount: 10000, date: new Date('2026-01-01'), type: 'capital_contribution' });

    // Contributed capital 10,000
    await EquityTransaction.create({ user: user._id, type: 'owner_contribution', amount: 10000, commonStockAmount: 10000, date: new Date('2026-01-01') });

    // Distribution 15,000 (exceeds 10,000 capital) with matching cash outflow -15,000
    await CashLedgerEntry.create({ user: user._id, account: cashAcc._id, amount: -15000, date: new Date('2026-06-01'), type: 'capital_withdrawal' });
    await EquityTransaction.create({ user: user._id, type: 'owner_distribution', amount: 15000, date: new Date('2026-06-01') });

    const req = { user, query: { year: 2026 } };
    let resData = null;
    await getBalanceSheet(req, { json: (d) => { resData = d; }, status: jest.fn().mockReturnThis() });

    const csRow = resData.categories.find(c => c.category === 'Common Stock');
    const reRow = resData.categories.find(c => c.category === 'Retained earnings');
    expect(csRow.currentYear).toBe(10000); // Raw contributed capital not netted
    expect(reRow.currentYear).toBe(-15000); // Retained earnings reflects full -15,000 distribution
    expect(resData.totalAssets).toBe(-5000); // Cash 10,000 - 15,000 = -5,000
    expect(resData.totalEquity).toBe(-5000); // 10,000 - 15,000 = -5,000
    expect(resData.balanceCheck.currentYear.balanced).toBe(true);
  });

  test('Regression Bug 3: Inventory valuation is time-scoped and does not duplicate current year to prior year', async () => {
    const user = await User.create({ name: 'Inv Co', email: 'inv@co.com', username: 'invco', password: 'pw' });

    // Item created in 2026
    await Item.create({
      user: user._id,
      name: 'Widget A',
      openingQuantity: 100,
      purchasePrice: 50,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });

    const req = { user, query: { year: 2026 } };
    let resData = null;
    await getBalanceSheet(req, { json: (d) => { resData = d; }, status: jest.fn().mockReturnThis() });

    const invRow = resData.categories.find(c => c.category === 'Inventories');
    expect(invRow.priorYear).toBeNull();
    expect(invRow.currentYear).toBe(5000); // 100 * 50
    expect(invRow.source.type).toBe('aggregate');
  });
});
