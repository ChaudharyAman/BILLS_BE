const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const User = require('../models/User');
const Client = require('../models/Client');
const Item = require('../models/Item');
const Invoice = require('../models/Invoice');
const Quote = require('../models/Quote');
const Proforma = require('../models/Proforma');
const PurchaseOrder = require('../models/PurchaseOrder');
const Expense = require('../models/Expense');
const Settings = require('../models/Settings');

const EXTERNAL_BASE_URL = process.env.SYSTEM_TEST_BASE_URL || '';
const PORT = Number(process.env.SYSTEM_TEST_PORT || 5051);
const REPORT_PATH = path.join(__dirname, '..', 'SYSTEM_TEST_REPORT.md');
const RUN_ID = `system-test-${Date.now()}`;

const state = {
  server: null,
  baseUrl: EXTERNAL_BASE_URL || `http://127.0.0.1:${PORT}`,
  results: [],
  users: {},
  tokens: {},
  ids: {},
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function note(status, name, detail = '') {
  state.results.push({ status, name, detail });
  const prefix = status === 'PASS' ? '[PASS]' : status === 'SKIP' ? '[SKIP]' : '[FAIL]';
  process.stdout.write(`${prefix} ${name}${detail ? ` - ${detail}` : ''}\n`);
}

async function run(name, fn) {
  try {
    const detail = await fn();
    note('PASS', name, detail || '');
  } catch (error) {
    note('FAIL', name, error.message);
  }
}

function skip(name, reason) {
  note('SKIP', name, reason);
}

function ok(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function unique(label) {
  return `${RUN_ID}-${label}`;
}

async function api(method, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  let body;
  if (options.formData) {
    body = options.formData;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${state.baseUrl}${pathname}`, { method, headers, body });
  const raw = await response.text();
  let data = raw;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch (_) {}

  if (options.expectedStatus !== undefined && response.status !== options.expectedStatus) {
    throw new Error(`${method} ${pathname} expected ${options.expectedStatus} but got ${response.status}: ${raw}`);
  }

  return { response, data };
}

async function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { response } = await api('GET', '/');
      if (response.ok) return true;
    } catch (_) {}
    await sleep(1000);
  }
  return false;
}

async function ensureServer() {
  if (EXTERNAL_BASE_URL) {
    const ready = await waitForServer(30000);
    if (!ready) throw new Error(`External server not ready at ${state.baseUrl}`);
    return;
  }

  process.env.API_RATE_LIMIT_MAX = process.env.API_RATE_LIMIT_MAX || '10000';
  const { startServer } = require('../index');
  state.server = await startServer(PORT);

  const ready = await waitForServer(30000);
  if (!ready) throw new Error(`Server not ready at ${state.baseUrl}`);
}

async function connectDb() {
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(process.env.MONGO_URI);
}

async function cleanup() {
  const users = await User.find({ username: { $regex: `^${RUN_ID}` } }).select('_id');
  const ids = users.map((user) => user._id);
  if (ids.length === 0) return;

  await Promise.all([
    Client.deleteMany({ user: { $in: ids } }),
    Item.deleteMany({ user: { $in: ids } }),
    Invoice.deleteMany({ user: { $in: ids } }),
    Quote.deleteMany({ user: { $in: ids } }),
    Proforma.deleteMany({ user: { $in: ids } }),
    PurchaseOrder.deleteMany({ user: { $in: ids } }),
    Expense.deleteMany({ user: { $in: ids } }),
    Settings.deleteMany({ user: { $in: ids } }),
    User.deleteMany({ _id: { $in: ids } }),
  ]);
}

async function register(label) {
  const username = unique(label);
  const password = 'Pass@123456';
  const email = `${username}@example.com`;
  const { data } = await api('POST', '/api/auth/register', {
    expectedStatus: 201,
    body: { username, email, password },
  });

  state.users[label] = { username, password, email, id: data.user._id };
  state.tokens[label] = data.token;
  return data.user;
}

async function login(label) {
  const user = state.users[label];
  const { data } = await api('POST', '/api/auth/login', {
    expectedStatus: 200,
    body: { username: user.username, password: user.password },
  });
  state.tokens[label] = data.token;
  return data.user;
}

function itemLine(name, itemRef) {
  return {
    itemRef,
    name,
    description: `${name} description`,
    hsnCode: '9983',
    qty: 2,
    unit: 'pcs',
    rate: 125,
    discount: 5,
    taxRate: 18,
  };
}

function reportText() {
  const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
  state.results.forEach((result) => { counts[result.status] += 1; });
  const lines = state.results.map((result) => `| ${result.status} | ${result.name} | ${String(result.detail).replace(/\|/g, '\\|')} |`).join('\n');

  return `# Automated System Test Report

Run ID: \`${RUN_ID}\`
Base URL: \`${state.baseUrl}\`

| Status | Count |
|---|---:|
| PASS | ${counts.PASS} |
| FAIL | ${counts.FAIL} |
| SKIP | ${counts.SKIP} |

| Result | Test | Detail |
|---|---|---|
${lines}

## Notes
- This single-run file automates the core system and backend business flows.
- Browser rendering, print fidelity, Cloudinary uploads, and live Razorpay checkout are marked as skipped because they need a real browser or third-party sandbox.
`;
}

async function authAndAccessCases() {
  await run('Health check', async () => {
    const { response, data } = await api('GET', '/');
    ok(response.ok, 'Root route did not respond OK');
    ok(String(data).includes('API is working fine'), 'Unexpected root response');
    return 'Backend responded';
  });

  await run('Register free user', async () => {
    const user = await register('free');
    ok(user.subscription.plan === 'free', 'Free plan not defaulted');
    return user.username;
  });

  await run('Register pro user', async () => {
    const user = await register('pro');
    return user.username;
  });

  await run('Register admin user', async () => {
    const user = await register('admin');
    return user.username;
  });

  await run('Invalid login is rejected', async () => {
    await api('POST', '/api/auth/login', {
      expectedStatus: 401,
      body: { username: state.users.free.username, password: 'wrong-password' },
    });
    return '401 returned';
  });

  await run('Promote admin in DB and re-login', async () => {
    await User.findByIdAndUpdate(state.users.admin.id, { role: 'superadmin' });
    await login('admin');
    return 'Admin role active';
  });

  await run('Protected route rejects anonymous access', async () => {
    await api('GET', '/api/clients', { expectedStatus: 401 });
    return '401 returned';
  });

  await run('Profile update works', async () => {
    const { data } = await api('PUT', '/api/auth/profile', {
      token: state.tokens.free,
      expectedStatus: 200,
      body: {
        phone: '9999999999',
        currentPassword: state.users.free.password,
        newPassword: state.users.free.password,
      },
    });
    ok(data.user.phone === '9999999999', 'Phone not updated');
    return 'Phone updated';
  });
}

async function settingsCases() {
  await run('Settings get creates default record', async () => {
    const { data } = await api('GET', '/api/settings', {
      token: state.tokens.pro,
      expectedStatus: 200,
    });
    ok(data._id, 'Settings record missing');
    return data._id;
  });

  await run('Admin upgrades pro user via admin API', async () => {
    await api('PATCH', `/api/admin/users/${state.users.pro.id}/plan`, {
      token: state.tokens.admin,
      expectedStatus: 200,
      body: {
        plan: 'pro',
        status: 'active',
        billingCycle: 'monthly',
        endDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    await login('pro');
    return 'Pro plan assigned';
  });

  await run('Settings update persists company data', async () => {
    const { data } = await api('PUT', '/api/settings', {
      token: state.tokens.pro,
      expectedStatus: 200,
      body: {
        companyName: 'Automation Company',
        phone: '9876543210',
        gstin: '07ABCDE1234F1Z5',
        address: { state: 'Delhi' },
        bankDetails: {
          accountName: 'Automation Company',
          bankName: 'Test Bank',
          accountNumber: '1234567890',
          branch: 'Main',
          ifscCode: 'TEST0001234',
        },
        invoicePrefix: 'ATINV',
        quotePrefix: 'ATQT',
        proformaPrefix: 'ATPRF',
        purchaseOrderPrefix: 'ATPO',
      },
    });
    ok(data.companyName === 'Automation Company', 'Company name not saved');
    return 'Company profile updated';
  });
}

async function masterDataCases() {
  await run('Client CRUD and search', async () => {
    const clientName = unique('client-a');
    const create = await api('POST', '/api/clients', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        name: clientName,
        email: `${clientName}@example.com`,
        phone: '9000000001',
        gstin: '07ABCDE1234F1Z5',
        placeOfSupply: 'Delhi',
        billingAddress: { state: 'Delhi', line1: 'Line 1', country: 'India' },
        shippingAddress: { state: 'Delhi', line1: 'Ship 1', country: 'India' },
      },
    });
    state.ids.client = create.data._id;

    const search = await api('GET', `/api/clients?search=${encodeURIComponent(clientName)}`, {
      token: state.tokens.pro,
      expectedStatus: 200,
    });
    ok(search.data.data.some((x) => x._id === state.ids.client), 'Client not found in search');

    const update = await api('PUT', `/api/clients/${state.ids.client}`, {
      token: state.tokens.pro,
      expectedStatus: 200,
      body: { phone: '9000000099' },
    });
    ok(update.data.phone === '9000000099', 'Client update failed');

    await api('GET', `/api/clients/${state.ids.client}`, {
      token: state.tokens.pro,
      expectedStatus: 200,
    });
    return clientName;
  });

  await run('Client bulk create', async () => {
    const { data } = await api('POST', '/api/clients/bulk', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        clients: [
          { name: unique('client-bulk-1'), email: `${unique('c1')}@example.com`, billingAddress: { state: 'Delhi' } },
          { name: unique('client-bulk-2'), email: `${unique('c2')}@example.com`, billingAddress: { state: 'Delhi' } },
        ],
      },
    });
    ok(data.count >= 2, 'Client bulk create count too low');
    return `${data.count} created`;
  });

  await run('Vendor CRUD and search', async () => {
    const vendorName = unique('vendor-a');
    const create = await api('POST', '/api/vendors', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: { name: vendorName, email: `${vendorName}@example.com`, billingAddress: { state: 'Delhi' } },
    });
    state.ids.vendor = create.data._id;

    const list = await api('GET', `/api/vendors?search=${encodeURIComponent(vendorName)}`, {
      token: state.tokens.pro,
      expectedStatus: 200,
    });
    ok(list.data.data.some((x) => x._id === state.ids.vendor), 'Vendor not found in search');

    await api('PUT', `/api/vendors/${state.ids.vendor}`, {
      token: state.tokens.pro,
      expectedStatus: 200,
      body: { phone: '9888888888' },
    });
    return vendorName;
  });

  await run('Item CRUD, search, and bulk', async () => {
    const itemName = unique('item-a');
    const create = await api('POST', '/api/items', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        name: itemName,
        type: 'Goods',
        description: 'Automation item',
        hsnCode: '9983',
        unit: 'pcs',
        rate: 125,
        sellingPrice: 125,
        purchasePrice: 100,
        taxRate: 18,
        defaultTaxRate: 18,
      },
    });
    state.ids.item = create.data._id;
    ok(create.data.sku, 'Item SKU missing');

    const search = await api('GET', `/api/items?search=${encodeURIComponent(itemName)}`, {
      token: state.tokens.pro,
      expectedStatus: 200,
    });
    ok(search.data.data.some((x) => x._id === state.ids.item), 'Item not found in search');

    await api('PUT', `/api/items/${state.ids.item}`, {
      token: state.tokens.pro,
      expectedStatus: 200,
      body: { description: 'Updated item description' },
    });

    const bulk = await api('POST', '/api/items/bulk', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        items: [
          { name: unique('item-bulk-1'), unit: 'pcs', taxRate: 5 },
          { name: unique('item-bulk-2'), unit: 'pcs', taxRate: 12 },
        ],
      },
    });
    ok(bulk.data.count >= 2, 'Item bulk create count too low');
    return itemName;
  });
}

async function invoiceCases() {
  await run('Free user is blocked from premium report', async () => {
    await api('GET', '/api/invoices/reports/gst', {
      token: state.tokens.free,
      expectedStatus: 403,
    });
    return '403 returned';
  });

  await run('Invoice create, duplicate reject, get, search, update', async () => {
    const invoiceNo = unique('invoice-a');
    const create = await api('POST', '/api/invoices', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        clientRef: state.ids.client,
        invoiceNo,
        invoiceType: 'Tax Invoice',
        date: '2026-04-11',
        dueDate: '2026-04-20',
        paymentMode: 'Cash',
        paymentTerms: 'On Receipt',
        placeOfSupply: 'Delhi',
        items: [itemLine(unique('invoice-item'), state.ids.item)],
        shippingCharges: 10,
        packagingCharges: 5,
        advancePaid: 25,
        status: 'DRAFT',
      },
    });
    state.ids.invoice = create.data._id;

    await api('POST', '/api/invoices', {
      token: state.tokens.pro,
      expectedStatus: 400,
      body: {
        clientRef: state.ids.client,
        invoiceNo,
        invoiceType: 'Tax Invoice',
        date: '2026-04-11',
        items: [itemLine(unique('invoice-item-dup'), state.ids.item)],
      },
    });

    const get = await api('GET', `/api/invoices/${state.ids.invoice}`, {
      token: state.tokens.pro,
      expectedStatus: 200,
    });
    ok(get.data.invoiceNo === invoiceNo, 'Invoice fetch mismatch');

    const search = await api('GET', `/api/invoices?search=${encodeURIComponent(invoiceNo)}`, {
      token: state.tokens.pro,
      expectedStatus: 200,
    });
    ok(search.data.data.some((x) => x._id === state.ids.invoice), 'Invoice search failed');

    const update = await api('PUT', `/api/invoices/${state.ids.invoice}`, {
      token: state.tokens.pro,
      expectedStatus: 200,
      body: {
        clientRef: state.ids.client,
        invoiceNo,
        invoiceType: 'Tax Invoice',
        date: '2026-04-12',
        dueDate: '2026-04-25',
        paymentMode: 'UPI',
        paymentTerms: 'Net 15',
        placeOfSupply: 'Delhi',
        items: [itemLine(unique('invoice-item-updated'), state.ids.item)],
        status: 'SENT',
      },
    });
    ok(update.data.paymentMode === 'UPI', 'Invoice update failed');
    return invoiceNo;
  });

  await run('Invoice bulk create', async () => {
    const { data } = await api('POST', '/api/invoices/bulk', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        invoices: [
          { clientName: unique('bulk-invoice-client-1'), placeOfSupply: 'Delhi', items: [{ name: 'Bulk Invoice 1', qty: 1, rate: 100, taxRate: 18 }] },
          { clientName: unique('bulk-invoice-client-2'), placeOfSupply: 'Delhi', items: [{ name: 'Bulk Invoice 2', qty: 2, rate: 120, taxRate: 18 }] },
        ],
      },
    });
    ok(data.count >= 2, 'Invoice bulk create count too low');
    return `${data.count} created`;
  });

  await run('PDF invoice import auto-creates missing client and item', async () => {
    const clientName = unique('pdf-client');
    const itemName = unique('pdf-item');
    await api('POST', '/api/invoices', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        importSource: 'pdf',
        clientName,
        clientGST: '07ABCDE1234F1Z5',
        invoiceNo: unique('pdf-invoice'),
        invoiceType: 'Tax Invoice',
        date: '2026-04-11',
        dueDate: '2026-04-18',
        placeOfSupply: 'Delhi',
        items: [{ name: itemName, description: 'Imported item', unit: 'pcs', qty: 1, rate: 250, taxRate: 18, discount: 0 }],
      },
    });
    const client = await Client.findOne({ user: state.users.pro.id, name: clientName });
    const item = await Item.findOne({ user: state.users.pro.id, name: itemName });
    ok(client, 'PDF client not created');
    ok(item, 'PDF item not created');
    return `${clientName} and ${itemName}`;
  });

  await run('PDF extract endpoint rejects missing file', async () => {
    await api('POST', '/api/pdf/extract', {
      token: state.tokens.pro,
      expectedStatus: 400,
      body: {},
    });
    return '400 returned';
  });

  await run('Premium reports and account endpoints load for pro user', async () => {
    await api('GET', '/api/invoices/reports/gst', { token: state.tokens.pro, expectedStatus: 200 });
    await api('GET', '/api/invoices/reports/revenue', { token: state.tokens.pro, expectedStatus: 200 });
    await api('GET', '/api/invoices/accounts/payments', { token: state.tokens.pro, expectedStatus: 200 });
    await api('GET', `/api/invoices/accounts/statements?clientId=${state.ids.client}`, {
      token: state.tokens.pro,
      expectedStatus: 200,
    });
    return 'Premium invoice endpoints responded';
  });
}

async function quoteLikeCases() {
  await run('Quote create, update, convert, bulk, delete', async () => {
    const create = await api('POST', '/api/quotes', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        clientRef: state.ids.client,
        invoiceType: 'Tax Invoice',
        date: '2026-04-11',
        validUntil: '2026-05-11',
        placeOfSupply: 'Delhi',
        items: [itemLine(unique('quote-item'), state.ids.item)],
      },
    });
    state.ids.quote = create.data._id;
    await api('PUT', `/api/quotes/${state.ids.quote}`, {
      token: state.tokens.pro,
      expectedStatus: 200,
      body: {
        clientRef: state.ids.client,
        invoiceType: 'Tax Invoice',
        date: '2026-04-12',
        validUntil: '2026-05-12',
        placeOfSupply: 'Delhi',
        items: [itemLine(unique('quote-item-updated'), state.ids.item)],
        status: 'SENT',
      },
    });
    const convert = await api('POST', `/api/quotes/${state.ids.quote}/convert`, {
      token: state.tokens.pro,
      expectedStatus: 201,
    });
    ok(convert.data.invoice && convert.data.invoice._id, 'Quote convert failed');
    const bulk = await api('POST', '/api/quotes/bulk', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        quotes: [{ clientName: unique('bulk-quote-client'), placeOfSupply: 'Delhi', items: [{ name: 'Bulk Quote', qty: 1, rate: 90, taxRate: 18 }] }],
      },
    });
    ok(bulk.data.count >= 1, 'Quote bulk create failed');
    const deletable = await api('POST', '/api/quotes', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        clientRef: state.ids.client,
        invoiceType: 'Tax Invoice',
        date: '2026-04-11',
        validUntil: '2026-05-11',
        placeOfSupply: 'Delhi',
        items: [itemLine(unique('quote-delete-item'), state.ids.item)],
      },
    });
    await api('DELETE', `/api/quotes/${deletable.data._id}`, {
      token: state.tokens.pro,
      expectedStatus: 200,
    });
    return state.ids.quote;
  });

  await run('Proforma create, update, convert, bulk, delete', async () => {
    const create = await api('POST', '/api/proformas', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        clientRef: state.ids.client,
        invoiceType: 'Tax Invoice',
        date: '2026-04-11',
        validUntil: '2026-05-11',
        placeOfSupply: 'Delhi',
        items: [itemLine(unique('proforma-item'), state.ids.item)],
      },
    });
    state.ids.proforma = create.data._id;
    await api('PUT', `/api/proformas/${state.ids.proforma}`, {
      token: state.tokens.pro,
      expectedStatus: 200,
      body: {
        clientRef: state.ids.client,
        invoiceType: 'Tax Invoice',
        date: '2026-04-12',
        validUntil: '2026-05-12',
        placeOfSupply: 'Delhi',
        items: [itemLine(unique('proforma-item-updated'), state.ids.item)],
        status: 'SENT',
      },
    });
    const convert = await api('POST', `/api/proformas/${state.ids.proforma}/convert`, {
      token: state.tokens.pro,
      expectedStatus: 201,
    });
    ok(convert.data.invoice && convert.data.invoice._id, 'Proforma convert failed');
    const bulk = await api('POST', '/api/proformas/bulk', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        proformas: [{ clientName: unique('bulk-proforma-client'), placeOfSupply: 'Delhi', items: [{ name: 'Bulk Proforma', qty: 1, rate: 110, taxRate: 18 }] }],
      },
    });
    ok(bulk.data.count >= 1, 'Proforma bulk create failed');
    const deletable = await api('POST', '/api/proformas', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        clientRef: state.ids.client,
        invoiceType: 'Tax Invoice',
        date: '2026-04-11',
        validUntil: '2026-05-11',
        placeOfSupply: 'Delhi',
        items: [itemLine(unique('proforma-delete-item'), state.ids.item)],
      },
    });
    await api('DELETE', `/api/proformas/${deletable.data._id}`, {
      token: state.tokens.pro,
      expectedStatus: 200,
    });
    return state.ids.proforma;
  });

  await run('Purchase order create, update, convert, bulk, delete', async () => {
    const create = await api('POST', '/api/purchase-orders', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        vendorRef: state.ids.vendor,
        invoiceType: 'Tax Invoice',
        date: '2026-04-11',
        validUntil: '2026-05-11',
        placeOfSupply: 'Delhi',
        items: [itemLine(unique('po-item'), state.ids.item)],
      },
    });
    state.ids.purchaseOrder = create.data._id;
    await api('PUT', `/api/purchase-orders/${state.ids.purchaseOrder}`, {
      token: state.tokens.pro,
      expectedStatus: 200,
      body: {
        vendorRef: state.ids.vendor,
        invoiceType: 'Tax Invoice',
        date: '2026-04-12',
        validUntil: '2026-05-12',
        placeOfSupply: 'Delhi',
        items: [itemLine(unique('po-item-updated'), state.ids.item)],
        status: 'SENT',
      },
    });
    const convert = await api('POST', `/api/purchase-orders/${state.ids.purchaseOrder}/convert`, {
      token: state.tokens.pro,
      expectedStatus: 201,
    });
    ok(convert.data.invoice && convert.data.invoice._id, 'Purchase order convert failed');
    const bulk = await api('POST', '/api/purchase-orders/bulk', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        purchaseOrders: [{ vendorName: unique('bulk-po-vendor'), placeOfSupply: 'Delhi', items: [{ name: 'Bulk PO', qty: 1, rate: 140, taxRate: 18 }] }],
      },
    });
    ok(bulk.data.count >= 1, 'Purchase order bulk create failed');
    const deletable = await api('POST', '/api/purchase-orders', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        vendorRef: state.ids.vendor,
        invoiceType: 'Tax Invoice',
        date: '2026-04-11',
        validUntil: '2026-05-11',
        placeOfSupply: 'Delhi',
        items: [itemLine(unique('po-delete-item'), state.ids.item)],
      },
    });
    await api('DELETE', `/api/purchase-orders/${deletable.data._id}`, {
      token: state.tokens.pro,
      expectedStatus: 200,
    });
    return state.ids.purchaseOrder;
  });
}

async function expenseAndBillingCases() {
  await run('Expense create, get, list, update, delete', async () => {
    const expenseNumber = unique('expense-a');
    const create = await api('POST', '/api/expenses', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        expenseNumber,
        date: '2026-04-11',
        vendor: { vendorRef: state.ids.vendor, name: 'Expense Vendor' },
        client: { clientRef: state.ids.client, name: 'Expense Client' },
        paymentMethod: 'Cash',
        reverseCharge: false,
        items: [{ itemRef: state.ids.item, name: unique('expense-item'), qty: 1, unit: 'pcs', rate: 80, taxRate: 18, taxAmount: 14.4, amount: 94.4 }],
        subTotal: 80,
        taxTotal: 14.4,
        grandTotal: 94.4,
      },
    });
    state.ids.expense = create.data._id;
    await api('GET', `/api/expenses/${state.ids.expense}`, { token: state.tokens.pro, expectedStatus: 200 });
    const list = await api('GET', `/api/expenses?search=${encodeURIComponent(expenseNumber)}`, {
      token: state.tokens.pro,
      expectedStatus: 200,
    });
    ok(list.data.data.some((x) => x._id === state.ids.expense), 'Expense not found in search');
    const update = await api('PUT', `/api/expenses/${state.ids.expense}`, {
      token: state.tokens.pro,
      expectedStatus: 200,
      body: { expenseNumber, paymentMethod: 'UPI', status: 'PAID' },
    });
    ok(update.data.paymentMethod === 'UPI', 'Expense update failed');
    await api('DELETE', `/api/expenses/${state.ids.expense}`, { token: state.tokens.pro, expectedStatus: 200 });
    return expenseNumber;
  });

  await run('Subscription status, usage, history, invalid order and invalid verify', async () => {
    const status = await api('GET', '/api/subscriptions/status', {
      token: state.tokens.pro,
      expectedStatus: 200,
    });
    ok(status.data.subscription.plan === 'pro', 'Subscription status did not show pro');
    const usage = await api('GET', '/api/subscriptions/usage', {
      token: state.tokens.pro,
      expectedStatus: 200,
    });
    ok(usage.data.invoices && usage.data.quotes, 'Usage payload incomplete');
    await api('GET', '/api/subscriptions/history', {
      token: state.tokens.pro,
      expectedStatus: 200,
    });
    await api('POST', '/api/subscriptions/create-order', {
      token: state.tokens.pro,
      expectedStatus: 400,
      body: { plan: 'bad-plan', billingCycle: 'monthly' },
    });
    await api('POST', '/api/subscriptions/verify', {
      token: state.tokens.pro,
      expectedStatus: 400,
      body: {
        razorpay_order_id: 'order_invalid',
        razorpay_payment_id: 'payment_invalid',
        razorpay_signature: 'invalid-signature',
      },
    });
    return 'Billing endpoints validated';
  });

  await run('Admin user list and payment history load', async () => {
    const users = await api('GET', '/api/admin/users', {
      token: state.tokens.admin,
      expectedStatus: 200,
    });
    ok(Array.isArray(users.data), 'Admin users payload not array');
    const payments = await api('GET', `/api/admin/users/${state.users.pro.id}/payments`, {
      token: state.tokens.admin,
      expectedStatus: 200,
    });
    ok(payments.data._id === state.users.pro.id, 'Admin payments endpoint returned wrong user');
    return `${users.data.length} users visible`;
  });

  skip('Browser-rendered frontend, print layouts, and modal UX', 'Needs Playwright/Cypress browser automation');
  skip('Cloudinary logo/signature upload', 'Needs external upload infrastructure');
  skip('Real Razorpay checkout success flow', 'Needs live payment sandbox and browser callback');
}

async function writeReportAndClose(exitCode) {
  try {
    fs.writeFileSync(REPORT_PATH, reportText(), 'utf8');
  } catch (error) {
    process.stderr.write(`Report write failed: ${error.message}\n`);
  }

  try {
    await cleanup();
  } catch (error) {
    process.stderr.write(`Cleanup failed: ${error.message}\n`);
  }

  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  } catch (error) {
    process.stderr.write(`Disconnect failed: ${error.message}\n`);
  }

  if (state.server) {
    await new Promise((resolve) => state.server.close(resolve));
  }

  process.exit(exitCode);
}

async function main() {
  await connectDb();
  await cleanup();
  await ensureServer();

  await authAndAccessCases();
  await settingsCases();
  await masterDataCases();
  await invoiceCases();
  await quoteLikeCases();
  await expenseAndBillingCases();

  await run('Logout endpoint responds', async () => {
    await api('POST', '/api/auth/logout', { expectedStatus: 200 });
    return 'Logout responded';
  });
}

main()
  .then(async () => {
    const hasFailures = state.results.some((result) => result.status === 'FAIL');
    await writeReportAndClose(hasFailures ? 1 : 0);
  })
  .catch(async (error) => {
    note('FAIL', 'Runner bootstrap', error.message);
    await writeReportAndClose(1);
  });
