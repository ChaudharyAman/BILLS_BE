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
const SubscriptionOrder = require('../models/SubscriptionOrder');
const BankStatement = require('../models/BankStatement');

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
  if (options.token) {
    if (options.token.startsWith('Bearer ')) {
      headers.Authorization = options.token;
    } else {
      headers.Cookie = options.token;
    }
  }

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

function cookieHeaderFromResponse(response) {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return '';

  return setCookie
    .split(/,(?=[^;,]+=)/)
    .map((cookie) => cookie.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
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
    BankStatement.deleteMany({ user: { $in: ids } }),
    Item.deleteMany({ user: { $in: ids } }),
    Invoice.deleteMany({ user: { $in: ids } }),
    Quote.deleteMany({ user: { $in: ids } }),
    Proforma.deleteMany({ user: { $in: ids } }),
    PurchaseOrder.deleteMany({ user: { $in: ids } }),
    Expense.deleteMany({ user: { $in: ids } }),
    Settings.deleteMany({ user: { $in: ids } }),
    SubscriptionOrder.deleteMany({ user: { $in: ids } }),
    User.deleteMany({ _id: { $in: ids } }),
  ]);
}

async function register(label) {
  const username = unique(label);
  const password = 'Pass@123456';
  const email = `${username}@example.com`;
  
  const user = await User.create({
    username,
    email,
    password,
  });

  state.users[label] = { username, password, email, id: String(user._id) };
  return await login(label);
}

async function login(label) {
  const user = state.users[label];
  const { response, data } = await api('POST', '/api/auth/login', {
    expectedStatus: 200,
    body: { username: user.username, password: user.password },
  });
  state.tokens[label] = cookieHeaderFromResponse(response) || (data.token ? `Bearer ${data.token}` : '');
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

  await run('Public self-registration is rejected with 403', async () => {
    const tempUsername = unique('public-signup');
    await api('POST', '/api/auth/register', {
      expectedStatus: 403,
      body: { username: tempUsername, email: `${tempUsername}@example.com`, password: 'Pass@123456' },
    });
    return '403 returned';
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

  await run('Invoice bulk import skips exact duplicates and renumbers conflicts', async () => {
    const invoiceNo = unique('duplicate-import');
    const clientName = unique('duplicate-import-client');
    await api('POST', '/api/invoices', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        invoiceNo,
        clientRef: state.ids.client,
        invoiceType: 'Tax Invoice',
        date: '2026-04-20',
        placeOfSupply: 'Delhi',
        items: [{ name: unique('duplicate-import-item'), qty: 1, unit: 'pcs', rate: 100, taxRate: 0 }],
        status: 'SENT',
      },
    });

    const { data } = await api('POST', '/api/invoices/bulk', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        invoices: [
          {
            invoiceNo,
            clientName,
            date: '2026-04-20',
            placeOfSupply: 'Delhi',
            importedGrandTotal: 100,
            items: [{ name: unique('duplicate-import-same'), qty: 1, rate: 100, taxRate: 0 }],
          },
          {
            invoiceNo,
            clientName: unique('duplicate-import-client-2'),
            date: '2026-04-20',
            placeOfSupply: 'Delhi',
            importedGrandTotal: 125,
            items: [{ name: unique('duplicate-import-different'), qty: 1, rate: 125, taxRate: 0 }],
          },
        ],
      },
    });

    ok(data.count === 1, `Expected 1 imported invoice, got ${data.count}`);
    ok(data.skipped === 1, `Expected 1 skipped duplicate, got ${data.skipped}`);
    ok(data.renumbered === 1, `Expected 1 renumbered invoice, got ${data.renumbered}`);
    ok(/^INV-\d+$/.test(data.renumberedInvoices?.[0]?.invoiceNo || ''), 'Renumbered invoice did not use INV prefix');
    return `${data.count} created, ${data.skipped} skipped, ${data.renumbered} renumbered`;
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

    // Reverse Charge Math test case (RCM)
    const rcmExpenseNumber = unique('expense-rcm');
    const rcmCreate = await api('POST', '/api/expenses', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        expenseNumber: rcmExpenseNumber,
        date: '2026-04-11',
        vendor: { vendorRef: state.ids.vendor, name: 'RCM Vendor' },
        client: { clientRef: state.ids.client, name: 'RCM Client' },
        paymentMethod: 'UPI',
        reverseCharge: true,
        items: [{ itemRef: state.ids.item, name: unique('rcm-item'), qty: 1, unit: 'pcs', rate: 32143, taxRate: 12, taxAmount: 3857.16, amount: 36000.16 }],
        subTotal: 32143,
        taxTotal: 3857.16,
        grandTotal: 36000.16,
        amountPaid: 32143,
        status: 'PAID'
      },
    });
    ok(rcmCreate.data.grandTotal === 36000.16, 'RCM Grand Total should be full amount including tax');
    ok(rcmCreate.data.balanceDue === 0, 'RCM balanceDue should be 0 because amountPaid covers base payable amount');
    ok(rcmCreate.data.amountPaid === 32143, 'RCM amountPaid should be base payable amount');
    await api('DELETE', `/api/expenses/${rcmCreate.data._id}`, { token: state.tokens.pro, expectedStatus: 200 });

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

  await run('Admin user lifecycle (create, deactivate block, delete)', async () => {
    const tempUsername = unique('temp-admin-user');
    const tempEmail = `${tempUsername}@example.com`;
    const tempPassword = 'Pass@123456';

    // 1. Create User
    const createRes = await api('POST', '/api/admin/users', {
      token: state.tokens.admin,
      expectedStatus: 201,
      body: {
        username: tempUsername,
        email: tempEmail,
        password: tempPassword,
        role: 'user',
        plan: 'pro',
        billingCycle: 'monthly',
        endDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
      }
    });
    const tempUserId = createRes.data._id;
    ok(tempUserId, 'User was not created');

    // 2. Verify we can login
    const loginRes = await api('POST', '/api/auth/login', {
      expectedStatus: 200,
      body: { username: tempUsername, password: tempPassword }
    });
    ok(loginRes.data.user.username === tempUsername, 'Failed to login as temp user');
    const tempUserCookie = cookieHeaderFromResponse(loginRes.response);

    // 3. Deactivate User
    await api('PATCH', `/api/admin/users/${tempUserId}/plan`, {
      token: state.tokens.admin,
      expectedStatus: 200,
      body: { isActive: false }
    });

    // 4. Verify login is blocked
    await api('POST', '/api/auth/login', {
      expectedStatus: 401,
      body: { username: tempUsername, password: tempPassword }
    });

    // 5. Verify API request by deactivated user cookie is blocked
    await api('GET', '/api/settings', {
      token: tempUserCookie,
      expectedStatus: 401
    });

    // 6. Delete User
    await api('DELETE', `/api/admin/users/${tempUserId}`, {
      token: state.tokens.admin,
      expectedStatus: 200
    });

    // 7. Verify login fails because user is deleted
    await api('POST', '/api/auth/login', {
      expectedStatus: 401,
      body: { username: tempUsername, password: tempPassword }
    });

    return 'Lifecycle verified';
  });

  skip('Browser-rendered frontend, print layouts, and modal UX', 'Needs Playwright/Cypress browser automation');
  skip('Cloudinary logo/signature upload', 'Needs external upload infrastructure');
  skip('Real Razorpay checkout success flow', 'Needs live payment sandbox and browser callback');
}

async function payrollAndEmployeeCases() {
  await run('Department create, fetch and delete', async () => {
    const deptName = unique('Engineering');
    const create = await api('POST', '/api/departments', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: { name: deptName, code: 'ENG' }
    });
    state.ids.department = create.data._id;
    ok(create.data._id, 'Department create failed');
    return deptName;
  });

  await run('Employee create, dynamic active list mid-month proration, salary revise', async () => {
    const employeeId = unique('EMP');
    const create = await api('POST', '/api/employees', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        employeeId,
        firstName: 'Aman',
        lastName: 'Tomar',
        email: `${employeeId}@test.com`,
        joiningDate: '2026-05-15', // Mid-month joining
        monthlyCTC: 10000,
        department: state.ids.department,
        pfEnabled: true,
        esiEnabled: true,
        ptEnabled: true,
        lwfEnabled: true,
        gratuityEnabled: true,
        includePfInCTC: true,
        includeGratuityInCTC: true
      }
    });
    state.ids.employee = create.data._id;
    ok(create.data._id, 'Employee create failed');

    // Dynamic Active List Query Mid-month Join
    const list = await api('GET', `/api/employees/active?month=5&year=2026`, {
      token: state.tokens.pro,
      expectedStatus: 200
    });
    ok(list.data.some(x => x._id === state.ids.employee), 'Employee mid-month joining not returned in active list');

    // Revise salary
    const revise = await api('POST', `/api/employees/${state.ids.employee}/salary-revision`, {
      token: state.tokens.pro,
      expectedStatus: 200,
      body: {
        newCTC: 12000,
        effectiveDate: '2026-06-01',
        reason: 'Performance appraisal'
      }
    });
    ok(revise.data.monthlyCTC === 12000, 'Salary revision new CTC mismatch');
    return employeeId;
  });

  await run('Mid-month salary revision weighted CTC proration', async () => {
    // 1. Revise salary effective mid-month (June 16th, 2026)
    // Old CTC was 12000 (effective June 1st).
    // New CTC is 15000 effective June 16th, 2026.
    // Days in June 2026 = 30.
    // June 1 to June 15 = 15 days @ 12000.
    // June 16 to June 30 = 15 days @ 15000.
    // Expected weighted CTC = (15 * 12000 + 15 * 15000) / 30 = 13500.
    const revise = await api('POST', `/api/employees/${state.ids.employee}/salary-revision`, {
      token: state.tokens.pro,
      expectedStatus: 200,
      body: {
        newCTC: 15000,
        effectiveDate: '2026-06-16',
        reason: 'Promotion'
      }
    });
    ok(revise.data.monthlyCTC === 15000, 'Salary revision new CTC mismatch');

    // 2. Process payroll draft for June 2026
    const process = await api('POST', '/api/payroll/process', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        month: 6,
        year: 2026,
        saveAsDraft: true,
        employees: [{
          employeeId: state.ids.employee,
          workingDays: 30,
          paidDays: 30,
          paidLeaves: 0,
          unpaidLeaves: 0,
          adjustments: {
            pfEnabled: true,
            esiEnabled: true,
            ptEnabled: true,
            lwfEnabled: true,
            gratuityEnabled: true,
            includePfInCTC: true,
            includeGratuityInCTC: true,
            basicPercent: 50,
            hraPercent: 50,
            tds: 0
          }
        }]
      }
    });
    ok(process.data.success.length === 1, 'Payroll process bulk run failed');
    const payrollId = process.data.success[0].payrollId;

    // 3. Fetch processed payroll draft and assert details
    const getPayroll = await api('GET', `/api/payroll/${payrollId}`, {
      token: state.tokens.pro,
      expectedStatus: 200
    });

    const snapshotCTC = getPayroll.data.employeeSnapshot?.monthlyCTC;
    ok(snapshotCTC === 13500, `Expected weighted monthlyCTC of 13500, got: ${snapshotCTC}`);

    const basicEarning = getPayroll.data.earnings?.basic;
    ok(basicEarning === 6750, `Expected Basic Earning of 6750 (50% of 13500), got: ${basicEarning}`);

    // Verify salarySplits are computed and returned
    ok(Array.isArray(getPayroll.data.salarySplits), 'Expected salarySplits to be an array');
    ok(getPayroll.data.salarySplits.length === 2, `Expected 2 splits, got: ${getPayroll.data.salarySplits.length}`);
    ok(getPayroll.data.salarySplits[0].monthlyCTC === 12000, `Expected segment 1 CTC 12000, got: ${getPayroll.data.salarySplits[0].monthlyCTC}`);
    ok(getPayroll.data.salarySplits[1].monthlyCTC === 15000, `Expected segment 2 CTC 15000, got: ${getPayroll.data.salarySplits[1].monthlyCTC}`);
    ok(getPayroll.data.salarySplits[0].daysCount === 15, `Expected segment 1 to have 15 days, got: ${getPayroll.data.salarySplits[0].daysCount}`);
    ok(getPayroll.data.salarySplits[1].daysCount === 15, `Expected segment 2 to have 15 days, got: ${getPayroll.data.salarySplits[1].daysCount}`);

    // Verify generate-payslip returns splits
    const getPayslip = await api('GET', `/api/payroll/${payrollId}/generate-payslip`, {
      token: state.tokens.pro,
      expectedStatus: 200
    });
    const payslipSplits = getPayslip.data.payslip?.salarySplits;
    ok(Array.isArray(payslipSplits), 'Expected payslip salarySplits to be an array');
    ok(payslipSplits.length === 2, `Expected 2 payslip splits, got: ${payslipSplits.length}`);

    // Return result summary
    return `Weighted CTC: ${snapshotCTC}, Basic: ${basicEarning}`;
  });

  await run('Mid-month salary revision with statutory toggle changes', async () => {
    // 1. Create a new employee with CTC 20,000, joining July 1st, 2026. pfEnabled = true.
    const employeeId = unique('EMP-TOGGLE');
    const create = await api('POST', '/api/employees', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        employeeId,
        firstName: 'Test',
        lastName: 'Toggles',
        email: `${employeeId}@test.com`,
        joiningDate: '2026-07-01',
        monthlyCTC: 20000,
        pfEnabled: true,
        esiEnabled: false,
        ptEnabled: false,
        lwfEnabled: false,
        gratuityEnabled: false,
        includePfInCTC: true,
        includeGratuityInCTC: false
      }
    });
    const targetEmpId = create.data._id;

    // 2. Revise salary effective July 16th, 2026. newCTC = 30000, pfEnabled = false.
    await api('POST', `/api/employees/${targetEmpId}/salary-revision`, {
      token: state.tokens.pro,
      expectedStatus: 200,
      body: {
        newCTC: 30000,
        effectiveDate: '2026-07-16',
        reason: 'Change toggles',
        pfEnabled: false,
        esiEnabled: false,
        ptEnabled: false,
        lwfEnabled: false,
        gratuityEnabled: false,
        includePfInCTC: true,
        includeGratuityInCTC: false
      }
    });

    // 3. Process payroll draft for July 2026 (31 days)
    const process = await api('POST', '/api/payroll/process', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        month: 7,
        year: 2026,
        saveAsDraft: true,
        employees: [{
          employeeId: targetEmpId,
          workingDays: 31,
          paidDays: 31,
          paidLeaves: 0,
          unpaidLeaves: 0,
          adjustments: {
            esiEnabled: false,
            ptEnabled: false,
            lwfEnabled: false,
            gratuityEnabled: false,
            includePfInCTC: true,
            includeGratuityInCTC: false,
            basicPercent: 50,
            hraPercent: 50,
            tds: 0
          }
        }]
      }
    });
    ok(process.data.success.length === 1, 'Payroll process bulk run failed');
    const payrollId = process.data.success[0].payrollId;

    // 4. Fetch processed payroll draft and assert details
    const getPayroll = await api('GET', `/api/payroll/${payrollId}`, {
      token: state.tokens.pro,
      expectedStatus: 200
    });

    const snapshotCTC = getPayroll.data.employeeSnapshot?.monthlyCTC;
    // (15 days * 20000 + 16 * 30000) / 31 = (300000 + 480000) / 31 = 780000 / 31 = 25161.29
    ok(Math.abs(snapshotCTC - 25161.29) < 0.1, `Expected weighted monthlyCTC ~25161.29, got: ${snapshotCTC}`);

    const pfEmployee = getPayroll.data.deductions?.pfEmployee;
    // 15 days * (20000 * 0.50 * 0.12 = 1200 / 31 = 38.71) = 580.65
    // 16 days * 0 = 0
    // Total expected: 580.65
    ok(Math.abs(pfEmployee - 580.65) < 0.1, `Expected prorated PF of 580.65, got: ${pfEmployee}`);

    return `Weighted CTC: ${snapshotCTC}, Prorated PF: ${pfEmployee}`;
  });

  await run('Mid-month salary revision with LOP deduction strategies (older_first / newer_first)', async () => {
    const employeeId = unique('EMP-LOPSTRAT');
    const create = await api('POST', '/api/employees', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        employeeId,
        firstName: 'Lop',
        lastName: 'Strategies',
        email: `${employeeId}@test.com`,
        joiningDate: '2026-06-01',
        monthlyCTC: 10000,
        pfEnabled: false,
        esiEnabled: false,
        ptEnabled: false,
        lwfEnabled: false,
        gratuityEnabled: false,
        includePfInCTC: false,
        includeGratuityInCTC: false
      }
    });
    const targetEmpId = create.data._id;

    await api('POST', `/api/employees/${targetEmpId}/salary-revision`, {
      token: state.tokens.pro,
      expectedStatus: 200,
      body: {
        newCTC: 20000,
        effectiveDate: '2026-06-16',
        reason: 'LOP strategies test'
      }
    });

    const processOlder = await api('POST', '/api/payroll/process', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        month: 6,
        year: 2026,
        saveAsDraft: true,
        employees: [{
          employeeId: targetEmpId,
          workingDays: 30,
          paidDays: 28,
          paidLeaves: 0,
          unpaidLeaves: 2,
          adjustments: {
            esiEnabled: false,
            ptEnabled: false,
            lwfEnabled: false,
            gratuityEnabled: false,
            includePfInCTC: false,
            includeGratuityInCTC: false,
            basicPercent: 50,
            hraPercent: 50,
            tds: 0,
            lopStrategy: 'older_first'
          }
        }]
      }
    });
    const payrollIdOlder = processOlder.data.success[0].payrollId;

    const getPayrollOlder = await api('GET', `/api/payroll/${payrollIdOlder}`, {
      token: state.tokens.pro,
      expectedStatus: 200
    });
    const basicOlder = getPayrollOlder.data.earnings?.basic;
    ok(Math.abs(basicOlder - 7166.67) < 1.0, `Expected older_first Basic ~7166.67, got: ${basicOlder}`);

    const Payroll = require('../models/Payroll');
    await Payroll.deleteOne({ _id: payrollIdOlder });

    const processNewer = await api('POST', '/api/payroll/process', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        month: 6,
        year: 2026,
        saveAsDraft: true,
        employees: [{
          employeeId: targetEmpId,
          workingDays: 30,
          paidDays: 28,
          paidLeaves: 0,
          unpaidLeaves: 2,
          adjustments: {
            esiEnabled: false,
            ptEnabled: false,
            lwfEnabled: false,
            gratuityEnabled: false,
            includePfInCTC: false,
            includeGratuityInCTC: false,
            basicPercent: 50,
            hraPercent: 50,
            tds: 0,
            lopStrategy: 'newer_first'
          }
        }]
      }
    });
    const payrollIdNewer = processNewer.data.success[0].payrollId;

    const getPayrollNewer = await api('GET', `/api/payroll/${payrollIdNewer}`, {
      token: state.tokens.pro,
      expectedStatus: 200
    });
    const basicNewer = getPayrollNewer.data.earnings?.basic;
    ok(Math.abs(basicNewer - 6833.33) < 1.0, `Expected newer_first Basic ~6833.33, got: ${basicNewer}`);

    await Payroll.deleteOne({ _id: payrollIdNewer });

    const processCustom = await api('POST', '/api/payroll/process', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        month: 6,
        year: 2026,
        saveAsDraft: true,
        employees: [{
          employeeId: targetEmpId,
          workingDays: 30,
          paidDays: 28,
          paidLeaves: 0,
          unpaidLeaves: 2,
          adjustments: {
            esiEnabled: false,
            ptEnabled: false,
            lwfEnabled: false,
            gratuityEnabled: false,
            includePfInCTC: false,
            includeGratuityInCTC: false,
            basicPercent: 50,
            hraPercent: 50,
            tds: 0,
            lopStrategy: 'custom',
            segmentLops: [1.5, 0.5]
          }
        }]
      }
    });
    const payrollIdCustom = processCustom.data.success[0].payrollId;

    const getPayrollCustom = await api('GET', `/api/payroll/${payrollIdCustom}`, {
      token: state.tokens.pro,
      expectedStatus: 200
    });
    const basicCustom = getPayrollCustom.data.earnings?.basic;
    ok(Math.abs(basicCustom - 7083.33) < 1.0, `Expected custom Basic ~7083.33, got: ${basicCustom}`);

    await Payroll.deleteOne({ _id: payrollIdCustom });

    return `older_first Basic: ${basicOlder}, newer_first Basic: ${basicNewer}, custom Basic: ${basicCustom}`;
  });

  await run('Loan create, approve, and payroll EMI amortization', async () => {
    // Create loan
    const create = await api('POST', '/api/loans', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        employee: state.ids.employee,
        principalAmount: 5000,
        emiAmount: 1000,
        interestRate: 0,
        status: 'pending_approval'
      }
    });
    state.ids.loan = create.data._id;
    ok(create.data.status === 'pending_approval', 'Loan status should default to pending_approval');

    // Approve loan
    const approve = await api('PUT', `/api/loans/${state.ids.loan}/status`, {
      token: state.tokens.pro,
      expectedStatus: 200,
      body: { status: 'active' }
    });
    ok(approve.data.status === 'active', 'Loan status did not transition to active');

    // Settle / Amortize via payroll processing
    const calculate = await api('POST', '/api/payroll/calculate-salary', {
      token: state.tokens.pro,
      expectedStatus: 200,
      body: {
        monthlyCTC: 10000,
        pfEnabled: true,
        esiEnabled: true,
        ptEnabled: true,
        lwfEnabled: true,
        gratuityEnabled: true,
        includePfInCTC: true,
        includeGratuityInCTC: true,
        basicPercent: 50,
        hraPercent: 50
      }
    });
    ok(calculate.data.monthlyCTC === 10000, 'Salary calculator preview math mismatch');

    // Process payroll batch
    const process = await api('POST', '/api/payroll/process', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        month: 5,
        year: 2026,
        saveAsDraft: false,
        employees: [{
          employeeId: state.ids.employee,
          workingDays: 26,
          paidDays: 26,
          paidLeaves: 0,
          unpaidLeaves: 0,
          adjustments: {
            pfEnabled: true,
            esiEnabled: true,
            ptEnabled: true,
            lwfEnabled: true,
            gratuityEnabled: true,
            includePfInCTC: true,
            includeGratuityInCTC: true,
            basicPercent: 50,
            hraPercent: 50,
            tds: 0
          }
        }]
      }
    });
    ok(process.data.success.length === 1, 'Payroll process bulk run failed');
    const payrollId = process.data.success[0].payrollId;

    // Mark paid to trigger amortization
    await api('POST', `/api/payroll/${payrollId}/mark-paid`, {
      token: state.tokens.pro,
      expectedStatus: 200,
      body: {
        paymentDate: '2026-05-31',
        paymentMethod: 'Bank Transfer'
      }
    });

    // Fetch and check loan remaining balance
    const verify = await api('GET', `/api/loans/${state.ids.loan}`, {
      token: state.tokens.pro,
      expectedStatus: 200
    });
    ok(verify.data.remainingBalance === 4000, `EMI was not amortized. Balance: ${verify.data.remainingBalance}`);
    ok(verify.data.repaymentLedger.length === 1, 'Repayment ledger log missing');
    return 'Amortization verified';
  });

  await run('Reimbursement claim submit, approve, and payroll verification', async () => {
    // Submit claim
    const create = await api('POST', '/api/reimbursements', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        employee: state.ids.employee,
        category: 'broadband',
        amount: 850,
        billUrl: 'https://cloudinary.com/receipt.pdf'
      }
    });
    state.ids.claim = create.data._id;
    ok(create.data.status === 'pending', 'Reimbursement status should default to pending');

    // Approve claim
    const approve = await api('PUT', `/api/reimbursements/${state.ids.claim}/status`, {
      token: state.tokens.pro,
      expectedStatus: 200,
      body: { status: 'approved', approverRemarks: 'Approved verified internet receipt' }
    });
    ok(approve.data.status === 'approved', 'Reimbursement claim was not approved');
    return 'Reimbursement verified';
  });

  await run('Hourly contractor employee lifecycle and payroll processing', async () => {
    // 1. Create hourly contractor employee
    const employeeId = unique('EMP-HOURLY');
    const create = await api('POST', '/api/employees', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        employeeId,
        firstName: 'Hourly',
        lastName: 'Contractor',
        email: `${employeeId}@test.com`,
        joiningDate: '2026-06-01',
        payType: 'hourly',
        hourlyRate: 25,
        pfEnabled: false,
        esiEnabled: false,
        ptEnabled: false,
        lwfEnabled: false,
        gratuityEnabled: false,
        includePfInCTC: false,
        includeGratuityInCTC: false
      }
    });
    const targetEmpId = create.data._id;
    ok(create.data.payType === 'hourly', 'Pay type should be hourly');
    ok(create.data.hourlyRate === 25, 'Hourly rate should be 25');

    // 2. Revise hourly rate
    const revise = await api('POST', `/api/employees/${targetEmpId}/salary-revision`, {
      token: state.tokens.pro,
      expectedStatus: 200,
      body: {
        newHourlyRate: 30,
        effectiveDate: '2026-06-16',
        reason: 'Rate adjustment'
      }
    });
    ok(revise.data.hourlyRate === 30, 'Revised hourly rate should be 30');

    // 3. Process payroll for June 2026
    const process = await api('POST', '/api/payroll/process', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: {
        month: 6,
        year: 2026,
        saveAsDraft: true,
        employees: [{
          employeeId: targetEmpId,
          workingDays: 30,
          paidDays: 30,
          paidLeaves: 0,
          unpaidLeaves: 0,
          hoursWorked: 160,
          adjustments: {
            hoursWorked: 160,
            esiEnabled: false,
            ptEnabled: false,
            lwfEnabled: false,
            gratuityEnabled: false,
            includePfInCTC: false,
            includeGratuityInCTC: false,
            tds: 0
          }
        }]
      }
    });
    ok(process.data.success.length === 1, 'Payroll process bulk run failed');
    const payrollId = process.data.success[0].payrollId;

    // 4. Fetch processed payroll draft and assert details
    const getPayroll = await api('GET', `/api/payroll/${payrollId}`, {
      token: state.tokens.pro,
      expectedStatus: 200
    });

    const netSalary = getPayroll.data.netSalary;
    ok(Math.abs(netSalary - 4400) < 0.1, `Expected net salary ~4400, got: ${netSalary}`);
    return `Hourly rate: 30, Hours worked: 160, Net Salary: ${netSalary}`;
  });
}

async function bankStatementCases() {
  await run('Bank statement CRUD lifecycle', async () => {
    // 1. Create a bank statement
    const statementPayload = {
      fileName: 'test_statement.xlsx',
      label: 'Test Statement Label',
      transactions: [
        { date: '2026-04-01', description: 'UPI/Porter/Devendra', debit: 500, credit: 0, balance: 10000, category: 'UPI', txnId: 'T1' },
        { date: '2026-04-02', description: 'Salary credit', debit: 0, credit: 25000, balance: 35000, category: 'Salary', txnId: 'T2' }
      ]
    };

    const createRes = await api('POST', '/api/bank-statements', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: statementPayload
    });

    const statementId = createRes.data._id;
    ok(statementId, 'Bank statement ID should be generated');
    ok(createRes.data.totalCredits === 25000, 'Total credits should match');
    ok(createRes.data.totalDebits === 500, 'Total debits should match');
    ok(createRes.data.netFlow === 24500, 'Net flow should match');
    ok(createRes.data.txnCount === 2, 'Txn count should match');

    // 2. Fetch list of statements and verify transactions array is excluded
    const listRes = await api('GET', '/api/bank-statements', {
      token: state.tokens.pro,
      expectedStatus: 200
    });

    const found = listRes.data.data.find(s => s._id === statementId);
    ok(found, 'Created statement should be in the list');
    ok(!found.transactions, 'List endpoint should not return transactions array');
    ok(found.label === 'Test Statement Label', 'Label should match');

    // 2b. Fetch list of statements WITH transactions and verify they are populated
    const listWithTxnsRes = await api('GET', '/api/bank-statements?includeTransactions=true', {
      token: state.tokens.pro,
      expectedStatus: 200
    });
    const foundWithTxns = listWithTxnsRes.data.data.find(s => s._id === statementId);
    ok(foundWithTxns && foundWithTxns.transactions && foundWithTxns.transactions.length === 2, 'List endpoint with includeTransactions=true should return transactions');

    // 3. Fetch single statement and verify transactions are populated
    const getRes = await api('GET', `/api/bank-statements/${statementId}`, {
      token: state.tokens.pro,
      expectedStatus: 200
    });

    ok(getRes.data.transactions && getRes.data.transactions.length === 2, 'Single get should return all transactions');
    ok(getRes.data.transactions[0].description === 'UPI/Porter/Devendra', 'Transaction description should match');

    // 3b. Verify Duplicate Transaction Checking
    // Upload a new statement containing T1 (which already exists in the statement we just created above)
    // and a new transaction T3.
    const dupStatementPayload = {
      fileName: 'another_statement.xlsx',
      label: 'Duplicate Check Statement',
      syncToLedgers: false,
      transactions: [
        { date: '2026-04-01', description: 'UPI/Porter/Devendra (dup)', debit: 500, credit: 0, balance: 10000, category: 'UPI', txnId: 'T1' },
        { date: '2026-04-03', description: 'New unique txn', debit: 1200, credit: 0, balance: 8800, category: 'UPI', txnId: 'T3' }
      ]
    };

    const BankStatement = require('../models/BankStatement');

    const dupCreateRes = await api('POST', '/api/bank-statements', {
      token: state.tokens.pro,
      expectedStatus: 201,
      body: dupStatementPayload
    });

    const dupStatementId = dupCreateRes.data._id;
    ok(dupStatementId, 'Should successfully create statement with filtered transactions');
    ok(dupCreateRes.data.txnCount === 1, `Expected only 1 transaction to be saved (unique), but got ${dupCreateRes.data.txnCount}`);

    // Verify in DB that only T3 was saved for this second statement
    const checkDupStmt = await BankStatement.findById(dupStatementId);
    ok(checkDupStmt.transactions.length === 1, 'Transaction list should only contain 1 item');
    ok(checkDupStmt.transactions[0].txnId === 'T3', 'The saved transaction should be T3');

    // Clean up dup statement
    await api('DELETE', `/api/bank-statements/${dupStatementId}`, {
      token: state.tokens.pro,
      expectedStatus: 200
    });

    // Attempt to save a statement containing ONLY duplicate transaction IDs (T1 and T2)
    const allDupPayload = {
      fileName: 'all_duplicates.xlsx',
      label: 'All Duplicates',
      syncToLedgers: false,
      transactions: [
        { date: '2026-04-01', description: 'UPI/Porter/Devendra (dup)', debit: 500, credit: 0, balance: 10000, category: 'UPI', txnId: 'T1' },
        { date: '2026-04-02', description: 'Salary credit (dup)', debit: 0, credit: 25000, balance: 35000, category: 'Salary', txnId: 'T2' }
      ]
    };

    await api('POST', '/api/bank-statements', {
      token: state.tokens.pro,
      expectedStatus: 400,
      body: allDupPayload
    });

    // 4. Delete the statement
    await api('DELETE', `/api/bank-statements/${statementId}`, {
      token: state.tokens.pro,
      expectedStatus: 200
    });

    // 5. Subsequent fetch should return 404
    await api('GET', `/api/bank-statements/${statementId}`, {
      token: state.tokens.pro,
      expectedStatus: 404
    });

    return 'BankStatement CRUD & ledger sync verified successfully';
  });
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
  await payrollAndEmployeeCases();
  await bankStatementCases();

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
