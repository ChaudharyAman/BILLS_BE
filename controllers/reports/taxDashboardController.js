const mongoose = require('mongoose');
const Income = require('../../models/Income');
const Expense = require('../../models/Expense');
const Invoice = require('../../models/Invoice');
const Payroll = require('../../models/Payroll');
const PurchaseOrder = require('../../models/PurchaseOrder');

const ACTIVE_INVOICE_STATUSES = ['SENT', 'PAID', 'PARTIAL', 'UNPAID'];
const ACTIVE_EXPENSE_STATUSES = { $nin: ['DRAFT', 'CANCELLED'] };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const GST_CLASSES = ['B2B', 'B2C', 'Export', 'NilRated'];

const roundTwo = (value) => Math.round((Number(value) || 0) * 100) / 100;
const sum = (items, field) => items.reduce((total, item) => total + (Number(item[field]) || 0), 0);

function getMonthRange(query) {
  if (query.month || query.year) {
    const now = new Date();
    const year = Number(query.year) || now.getUTCFullYear();
    const month = Math.min(12, Math.max(1, Number(query.month) || now.getUTCMonth() + 1));
    return {
      startDate: new Date(Date.UTC(year, month - 1, 1)),
      endDate: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
    };
  }

  const now = new Date();
  const startDate = query.startDate
    ? new Date(query.startDate)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const endDate = query.endDate
    ? new Date(query.endDate)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));

  if (query.startDate && Number.isNaN(startDate.getTime())) throw new Error('Invalid startDate');
  if (query.endDate && Number.isNaN(endDate.getTime())) throw new Error('Invalid endDate');

  endDate.setUTCHours(23, 59, 59, 999);
  return { startDate, endDate };
}

function previousPeriodRange(startDate, endDate) {
  const durationMs = endDate.getTime() - startDate.getTime();
  const durationDays = Math.round(durationMs / (1000 * 60 * 60 * 24));

  // For single-month views (~28-31 days), compare against the prior month
  if (durationDays <= 31) {
    return {
      startDate: new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() - 1, 1)),
      endDate: new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 0, 23, 59, 59, 999)),
    };
  }

  // For multi-month ranges, shift the entire range backwards by its own duration
  const prevEnd = new Date(startDate.getTime() - 1);
  prevEnd.setUTCHours(23, 59, 59, 999);
  const prevStart = new Date(prevEnd.getTime() - durationMs);
  prevStart.setUTCHours(0, 0, 0, 0);
  return { startDate: prevStart, endDate: prevEnd };
}

function pctChange(current, previous) {
  if (!previous) return 0;
  return roundTwo(((Number(current) - Number(previous)) / Number(previous)) * 100);
}

function classifyInvoice(row = {}) {
  if (GST_CLASSES.includes(row.gstInvoiceType)) return row.gstInvoiceType;
  if (GST_CLASSES.includes(row.invoiceType)) return row.invoiceType;
  const items = Array.isArray(row.items) ? row.items : [];
  if (items.length && items.every((item) => item.isNilRated === true || Number(item.taxRate) === 0)) return 'NilRated';
  if (/international|export/i.test(String(row.placeOfSupply || ''))) return 'Export';
  if (/^[0-9A-Z]{15}$/.test(String(row.client?.gstin || '').trim().toUpperCase())) return 'B2B';
  return 'B2C';
}

async function aggregateTotals(Model, userId, startDate, endDate, fields, allowedStatuses = ACTIVE_EXPENSE_STATUSES, buId = null) {
  const isExpense = Model.modelName === 'Expense';
  const isIncome = Model.modelName === 'Income';
  const project = fields.reduce((acc, field) => {
    let sumExpression = `$${field}`;
    if (isExpense && field === 'taxTotal') {
      sumExpression = {
        $cond: {
          if: { $eq: ['$reverseCharge', true] },
          then: 0,
          else: `$${field}`
        }
      };
    }
    return { ...acc, [field]: { $sum: sumExpression } };
  }, {});

  const matchQuery = { user: userId, date: { $gte: startDate, $lte: endDate }, status: allowedStatuses };
  if (isIncome) {
    matchQuery.sourceType = 'manual';
  }
  if (buId) {
    matchQuery.businessUnit = buId;
  }

  const [result] = await Model.aggregate([
    { $match: matchQuery },
    { $group: { _id: null, ...project } },
  ]);
  return result || fields.reduce((acc, field) => ({ ...acc, [field]: 0 }), {});
}

async function getInvoiceSplit(userId, startDate, endDate, buId = null) {
  const query = {
    user: userId,
    date: { $gte: startDate, $lte: endDate },
    status: { $in: ACTIVE_INVOICE_STATUSES },
  };
  if (buId) query.businessUnit = buId;

  const invoices = await Invoice.find(query)
    .select('invoiceType gstInvoiceType placeOfSupply client.gstin items.taxRate items.isNilRated').lean();

  const split = { total: invoices.length, b2b: 0, b2c: 0, export: 0, nilRated: 0, percentages: {} };
  invoices.forEach((invoice) => {
    const type = classifyInvoice(invoice);
    if (type === 'B2B') split.b2b += 1;
    else if (type === 'B2C') split.b2c += 1;
    else if (type === 'Export') split.export += 1;
    else if (type === 'NilRated') split.nilRated += 1;
  });

  ['b2b', 'b2c', 'export', 'nilRated'].forEach((key) => {
    split.percentages[key] = split.total ? roundTwo((split[key] / split.total) * 100) : 0;
  });
  return split;
}

async function getSlabTotals(Model, userId, startDate, endDate, allowedStatuses = ACTIVE_EXPENSE_STATUSES, buId = null) {
  const isExpense = Model.modelName === 'Expense';

  const sumExpression = isExpense
    ? {
        $cond: {
          if: { $eq: ['$reverseCharge', true] },
          then: 0,
          else: {
            $cond: {
              if: { $gt: [{ $ifNull: ['$items.taxAmount', 0] }, 0] },
              then: '$items.taxAmount',
              else: {
                $multiply: [
                  { $ifNull: ['$items.amount', 0] },
                  { $divide: [{ $ifNull: ['$items.taxRate', 0] }, 100] }
                ]
              }
            }
          }
        }
      }
    : '$items.taxAmount';

  const matchQuery = { user: userId, date: { $gte: startDate, $lte: endDate }, status: allowedStatuses };
  if (buId) matchQuery.businessUnit = buId;

  const rows = await Model.aggregate([
    { $match: matchQuery },
    { $unwind: { path: '$items', preserveNullAndEmptyArrays: false } },
    {
      $group: {
        _id: { $toDouble: { $ifNull: ['$items.taxRate', 0] } },
        amount: { $sum: sumExpression },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const byRate = new Map(rows.map((row) => [Number(row._id), roundTwo(row.amount)]));
  return [0, 5, 12, 18, 28].map((slab) => ({
    slab: `${slab}%`,
    amount: byRate.get(slab) || 0,
  }));
}

async function getTrend6Months(userId, endDate, buId = null) {
  const start = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() - 5, 1));
  const end = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  
  const invMatch = { user: userId, date: { $gte: start, $lte: end }, status: { $in: ACTIVE_INVOICE_STATUSES } };
  const expMatch = { user: userId, date: { $gte: start, $lte: end }, status: ACTIVE_EXPENSE_STATUSES };
  if (buId) {
    invMatch.businessUnit = buId;
    expMatch.businessUnit = buId;
  }

  const invoicePipeline = [
    { $match: invMatch },
    { $group: { _id: { year: { $year: '$date' }, month: { $month: '$date' } }, tax: { $sum: '$taxTotal' }, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
  ];

  const expensePipeline = [
    { $match: expMatch },
    {
      $group: {
        _id: { year: { $year: '$date' }, month: { $month: '$date' } },
        tax: {
          $sum: {
            $cond: {
              if: { $eq: ['$reverseCharge', true] },
              then: 0,
              else: '$taxTotal'
            }
          }
        },
        total: { $sum: '$grandTotal' },
        count: { $sum: 1 }
      }
    },
  ];

  const [invoiceRows, expenseRows] = await Promise.all([
    Invoice.aggregate(invoicePipeline),
    Expense.aggregate(expensePipeline),
  ]);
  const invoiceMap = new Map(invoiceRows.map((row) => [`${row._id.year}-${row._id.month}`, row]));
  const expenseMap = new Map(expenseRows.map((row) => [`${row._id.year}-${row._id.month}`, row]));

  return Array.from({ length: 6 }, (_, index) => {
    const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1));
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`;
    const output = invoiceMap.get(key);
    const input = expenseMap.get(key);
    return {
      month: MONTHS[date.getUTCMonth()],
      output: roundTwo(output?.tax || 0),
      input: roundTwo(input?.tax || 0),
      revenue: roundTwo(output?.total || 0),
      expenses: roundTwo(input?.total || 0),
      invoiceCount: output?.count || 0,
    };
  });
}

async function getExpenseGstCredits(userId, startDate, endDate, buId = null) {
  const Settings = require('../../models/Settings');
  const Client = require('../../models/Client');

  const settings = await Settings.findOne({ user: userId }).select('gstin').lean();
  const userGstin = String(settings?.gstin || '').trim().toUpperCase();
  const userStateCode = /^[0-9]{2}/.test(userGstin) ? userGstin.substring(0, 2) : '';

  const expQuery = {
    user: userId,
    date: { $gte: startDate, $lte: endDate },
    status: ACTIVE_EXPENSE_STATUSES,
  };
  if (buId) expQuery.businessUnit = buId;

  const expenses = await Expense.find(expQuery).select('vendor items.taxRate items.taxAmount items.amount reverseCharge').lean();

  const vendorRefIds = [...new Set(
    expenses
      .map(e => e.vendor?.vendorRef)
      .filter(Boolean)
      .map(String)
  )];

  const vendorDocs = vendorRefIds.length
    ? await Client.find({ _id: { $in: vendorRefIds } }).select('gstin').lean()
    : [];
  const vendorGstinMap = new Map(vendorDocs.map(v => [String(v._id), String(v.gstin || '').trim().toUpperCase()]));

  let igst = 0;
  let cgst = 0;
  let sgst = 0;

  for (const expense of expenses) {
    if (expense.reverseCharge === true) continue;

    const vendorGstin = expense.vendor?.vendorRef
      ? (vendorGstinMap.get(String(expense.vendor.vendorRef)) || '')
      : '';
    const vendorStateCode = /^[0-9]{2}/.test(vendorGstin) ? vendorGstin.substring(0, 2) : '';
    const isInterState = userStateCode && vendorStateCode && userStateCode !== vendorStateCode;

    const items = Array.isArray(expense.items) ? expense.items : [];
    for (const item of items) {
      const taxAmt = Number(item.taxAmount) || 0;
      const effectiveTax = taxAmt > 0
        ? taxAmt
        : roundTwo((Number(item.amount) || 0) * ((Number(item.taxRate) || 0) / 100));

      if (effectiveTax <= 0) continue;

      if (isInterState) {
        igst += effectiveTax;
      } else {
        cgst += effectiveTax / 2;
        sgst += effectiveTax / 2;
      }
    }
  }

  return { igst: roundTwo(igst), cgstSgst: roundTwo(cgst + sgst) };
}

async function getExpenseCategories(userId, startDate, endDate, buId = null) {
  const match = { user: userId, date: { $gte: startDate, $lte: endDate }, status: ACTIVE_EXPENSE_STATUSES };
  if (buId) match.businessUnit = buId;

  return Expense.aggregate([
    { $match: match },
    { $group: { _id: '$category', total: { $sum: '$grandTotal' } } },
    { $lookup: { from: 'categories', localField: '_id', foreignField: '_id', as: 'category' } },
    { $unwind: { path: '$category', preserveNullAndEmptyArrays: true } },
    { $project: { _id: 0, name: { $ifNull: ['$category.name', 'Uncategorized'] }, total: 1 } },
    { $sort: { total: -1 } },
    { $limit: 6 },
  ]);
}

async function getPayrollTdsPayable(userId, startDate, endDate, buId = null) {
  const match = { user: userId, status: { $nin: ['cancelled', 'draft'] }, paymentDate: { $gte: startDate, $lte: endDate } };
  if (buId) match.businessUnit = buId;

  const [result] = await Payroll.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$deductions.tds' } } },
  ]);
  return roundTwo(result?.total || 0);
}

async function getReceivables(userId, buId = null) {
  const match = { user: userId, status: { $nin: ['DRAFT', 'PAID', 'CANCELLED'] } };
  if (buId) match.businessUnit = buId;

  const [result] = await Invoice.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$balanceDue' } } },
  ]);
  return roundTwo(result?.total || 0);
}

async function getPayables(userId, buId = null) {
  const match = { user: userId, status: { $nin: ['DRAFT', 'PAID', 'CANCELLED'] } };
  if (buId) match.businessUnit = buId;

  const [result] = await Expense.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$balanceDue' } } },
  ]);
  return roundTwo(result?.total || 0);
}

async function getOverdueInvoices(userId, buId = null) {
  const now = new Date();
  const match = { user: userId, status: { $nin: ['DRAFT', 'PAID', 'CANCELLED'] }, dueDate: { $lt: now, $exists: true } };
  if (buId) match.businessUnit = buId;

  const invoices = await Invoice.aggregate([
    { $match: match },
    { $project: { balanceDue: 1, daysOverdue: { $ceil: { $divide: [{ $subtract: [now, '$dueDate'] }, 1000 * 60 * 60 * 24] } } } },
  ]);

  const aging = { d0_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  let total = 0;
  invoices.forEach((invoice) => {
    const amount = Number(invoice.balanceDue) || 0;
    total += amount;
    if (invoice.daysOverdue <= 30) aging.d0_30 += amount;
    else if (invoice.daysOverdue <= 60) aging.d31_60 += amount;
    else if (invoice.daysOverdue <= 90) aging.d61_90 += amount;
    else aging.d90plus += amount;
  });

  total = roundTwo(total);
  ['d0_30', 'd31_60', 'd61_90', 'd90plus'].forEach((key) => {
    aging[key] = roundTwo(aging[key]);
  });

  return { total, count: invoices.length, aging };
}

async function getTopClients(userId, startDate, endDate, buId = null) {
  const match = { user: userId, date: { $gte: startDate, $lte: endDate }, status: { $in: ACTIVE_INVOICE_STATUSES } };
  if (buId) match.businessUnit = buId;

  const rows = await Invoice.aggregate([
    { $match: match },
    { $group: { _id: { $ifNull: ['$client.name', 'Unknown'] }, total: { $sum: '$grandTotal' } } },
    { $sort: { total: -1 } },
    { $limit: 5 },
    { $project: { _id: 0, name: '$_id', total: 1 } },
  ]);
  return rows.map((row) => ({ ...row, total: roundTwo(row.total) }));
}

async function getPendingPO(userId, buId = null) {
  const match = { user: userId, status: { $nin: ['DRAFT', 'RECEIVED', 'BILLED', 'CANCELLED'] } };
  if (buId) match.businessUnit = buId;

  const [result] = await PurchaseOrder.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
  ]);
  return { total: roundTwo(result?.total || 0), count: result?.count || 0 };
}

async function getDraftCounts(userId, buId = null) {
  const invQuery = { user: userId, status: 'DRAFT' };
  const expQuery = { user: userId, status: 'DRAFT' };
  if (buId) {
    invQuery.businessUnit = buId;
    expQuery.businessUnit = buId;
  }

  const [invoices, expenses] = await Promise.all([
    Invoice.countDocuments(invQuery),
    Expense.countDocuments(expQuery),
  ]);
  return { invoices, expenses, total: invoices + expenses };
}

async function getExpenseTdsPayable(userId, startDate, endDate, buId = null) {
  const match = {
    user: userId,
    date: { $gte: startDate, $lte: endDate },
    status: ACTIVE_EXPENSE_STATUSES,
    $or: [{ tds_applicable: true }, { tdsApplicable: true }],
  };
  if (buId) match.businessUnit = buId;

  const [result] = await Expense.aggregate([
    { $match: match },
    {
      $project: {
        tdsValue: { $max: [{ $ifNull: ['$tds_amount', 0] }, { $ifNull: ['$tdsAmount', 0] }] },
      },
    },
    { $group: { _id: null, total: { $sum: '$tdsValue' } } },
  ]);
  return roundTwo(result?.total || 0);
}

async function getInvoiceTdsDeducted(userId, startDate, endDate, buId = null) {
  const match = { user: userId, date: { $gte: startDate, $lte: endDate }, status: { $in: ACTIVE_INVOICE_STATUSES } };
  if (buId) match.businessUnit = buId;

  const [result] = await Invoice.aggregate([
    { $match: match },
    {
      $project: {
        tdsValue: { $max: [{ $ifNull: ['$tds_amount', 0] }, { $ifNull: ['$tdsAmount', 0] }, { $ifNull: ['$tds', 0] }] },
      },
    },
    { $group: { _id: null, total: { $sum: '$tdsValue' } } },
  ]);
  return roundTwo(result?.total || 0);
}

exports.getTaxDashboard = async (req, res) => {
  try {
    const { startDate, endDate } = getMonthRange(req.query);
    const previous = previousPeriodRange(startDate, endDate);
    const userId = req.user._id;
    const buId = req.query.businessUnit && mongoose.Types.ObjectId.isValid(req.query.businessUnit)
      ? new mongoose.Types.ObjectId(req.query.businessUnit)
      : null;

    const [
      incomeTotals,
      expenseTotals,
      invoiceTotals,
      previousInvoiceTotals,
      previousExpenseTotals,
      invoiceSplit,
      outputBySlab,
      inputBySlab,
      trend6Months,
      expenseCredits,
      expenseCategories,
      payrollTdsPayable,
      expenseTdsPayable,
      invoiceTdsDeducted,
      receivables,
      payables,
      overdueInvoices,
      topClients,
      pendingPO,
      draftCounts,
    ] = await Promise.all([
      aggregateTotals(Income, userId, startDate, endDate, ['subTotal', 'taxTotal', 'grandTotal'], { $in: ['PAID', 'PARTIAL'] }, buId),
      aggregateTotals(Expense, userId, startDate, endDate, ['subTotal', 'taxTotal', 'grandTotal'], ACTIVE_EXPENSE_STATUSES, buId),
      aggregateTotals(Invoice, userId, startDate, endDate, ['subTotal', 'taxTotal', 'grandTotal', 'totalCGST', 'totalSGST', 'totalIGST', 'tds', 'tds_amount', 'tdsAmount', 'tcs'], { $in: ACTIVE_INVOICE_STATUSES }, buId),
      aggregateTotals(Invoice, userId, previous.startDate, previous.endDate, ['taxTotal', 'grandTotal'], { $in: ACTIVE_INVOICE_STATUSES }, buId),
      aggregateTotals(Expense, userId, previous.startDate, previous.endDate, ['taxTotal', 'grandTotal'], ACTIVE_EXPENSE_STATUSES, buId),
      getInvoiceSplit(userId, startDate, endDate, buId),
      getSlabTotals(Invoice, userId, startDate, endDate, { $in: ACTIVE_INVOICE_STATUSES }, buId),
      getSlabTotals(Expense, userId, startDate, endDate, ACTIVE_EXPENSE_STATUSES, buId),
      getTrend6Months(userId, endDate, buId),
      getExpenseGstCredits(userId, startDate, endDate, buId),
      getExpenseCategories(userId, startDate, endDate, buId),
      getPayrollTdsPayable(userId, startDate, endDate, buId),
      getExpenseTdsPayable(userId, startDate, endDate, buId),
      getInvoiceTdsDeducted(userId, startDate, endDate, buId),
      getReceivables(userId, buId),
      getPayables(userId, buId),
      getOverdueInvoices(userId, buId),
      getTopClients(userId, startDate, endDate, buId),
      getPendingPO(userId, buId),
      getDraftCounts(userId, buId),
    ]);

    const outputLiability = roundTwo(invoiceTotals.taxTotal);
    const inputCredit = roundTwo(expenseTotals.taxTotal);
    const netPayable = Math.max(roundTwo(outputLiability - inputCredit), 0);
    const itcUtilisation = outputLiability ? roundTwo((inputCredit / outputLiability) * 100) : 0;
    const tdsDeducted = roundTwo(invoiceTdsDeducted);
    const tdsPayable = roundTwo(payrollTdsPayable + expenseTdsPayable);
    const netTaxPayable = roundTwo(netPayable + tdsPayable);
    
    const gstDueDate = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() + 1, 20));
    // TDS due date: 7th of next month for all months EXCEPT March (month=2), where it is April 30th
    const isMarch = endDate.getUTCMonth() === 2;
    const tdsDueDate = isMarch
      ? new Date(Date.UTC(endDate.getUTCFullYear(), 3, 30))  // April 30 for March quarter
      : new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() + 1, 7));


    const revInvQuery = {
      user: userId,
      date: { $gte: startDate, $lte: endDate },
      status: { $in: ACTIVE_INVOICE_STATUSES }
    };
    if (buId) revInvQuery.businessUnit = buId;

    const revIncQuery = {
      user: userId,
      date: { $gte: startDate, $lte: endDate },
      status: { $in: ['PAID', 'PARTIAL'] },
      sourceType: 'manual'
    };
    if (buId) revIncQuery.businessUnit = buId;

    const revenueInvoices = await Invoice.find(revInvQuery).select('invoiceNo client.name grandTotal date status').sort({ date: -1 }).lean();
    const revenueManualIncomes = await Income.find(revIncQuery).select('number party grandTotal date status').sort({ date: -1 }).lean();

    const revenueItems = [
      ...revenueInvoices.map(i => ({
        id: i._id,
        party: i.client?.name || 'Client',
        number: i.invoiceNo || 'Invoice',
        amount: i.grandTotal,
        status: i.status,
        date: i.date,
        source: 'Invoice'
      })),
      ...revenueManualIncomes.map(i => ({
        id: i._id,
        party: i.party || 'Manual Income',
        number: i.number || 'Income',
        amount: i.grandTotal,
        status: i.status,
        date: i.date,
        source: 'Manual Income'
      }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    const expDocQuery = {
      user: userId,
      date: { $gte: startDate, $lte: endDate },
      status: ACTIVE_EXPENSE_STATUSES
    };
    if (buId) expDocQuery.businessUnit = buId;

    const expenseDocs = await Expense.find(expDocQuery).select('expenseNumber vendor.name party grandTotal date status').sort({ date: -1 }).lean();

    const expenseItems = expenseDocs.map(e => ({
      id: e._id,
      party: e.vendor?.name || e.party || 'Vendor',
      number: e.expenseNumber || 'Expense',
      amount: e.grandTotal,
      status: e.status,
      date: e.date,
      source: 'Expense'
    }));

    const gstLiabQuery = {
      user: userId,
      date: { $gte: startDate, $lte: endDate },
      status: { $in: ACTIVE_INVOICE_STATUSES },
      taxTotal: { $gt: 0 }
    };
    if (buId) gstLiabQuery.businessUnit = buId;

    const gstLiabilityInvoices = await Invoice.find(gstLiabQuery).select('invoiceNo client.name taxTotal totalCGST totalSGST totalIGST date status').sort({ date: -1 }).lean();

    const gstLiabilityItems = gstLiabilityInvoices.map(i => ({
      id: i._id,
      party: i.client?.name || 'Client',
      number: i.invoiceNo || 'Invoice',
      amount: i.taxTotal,
      cgst: i.totalCGST || 0,
      sgst: i.totalSGST || 0,
      igst: i.totalIGST || 0,
      status: i.status,
      date: i.date,
      source: 'Invoice GST'
    }));

    const tdsDedQuery = {
      user: userId,
      date: { $gte: startDate, $lte: endDate },
      status: { $in: ACTIVE_INVOICE_STATUSES },
      $or: [
        { tdsAmount: { $gt: 0 } },
        { tds_amount: { $gt: 0 } },
        { tds: { $gt: 0 } }
      ]
    };
    if (buId) tdsDedQuery.businessUnit = buId;

    const tdsDeductedInvoices = await Invoice.find(tdsDedQuery).select('invoiceNo client.name grandTotal tdsAmount tds_amount tds date status').sort({ date: -1 }).lean();

    const tdsDeductedItems = tdsDeductedInvoices.map(i => ({
      id: i._id,
      party: i.client?.name || 'Client',
      number: i.invoiceNo || 'Invoice',
      amount: i.tdsAmount || i.tds_amount || i.tds || 0,
      grandTotal: i.grandTotal,
      status: i.status,
      date: i.date,
      source: 'Invoice TDS'
    }));

    const tdsPayExpQuery = {
      user: userId,
      date: { $gte: startDate, $lte: endDate },
      status: ACTIVE_EXPENSE_STATUSES,
      $or: [
        { tdsAmount: { $gt: 0 } },
        { tds_amount: { $gt: 0 } },
        { tdsApplicable: true },
        { tds_applicable: true }
      ]
    };
    if (buId) tdsPayExpQuery.businessUnit = buId;

    const tdsPayableExpenses = await Expense.find(tdsPayExpQuery).select('expenseNumber vendor.name party grandTotal tdsAmount tds_amount date status').sort({ date: -1 }).lean();

    const tdsPayablePayrolls = await Payroll.find({
      user: userId,
      status: { $nin: ['cancelled', 'draft'] },
      paymentDate: { $gte: startDate, $lte: endDate },
      'deductions.tds': { $gt: 0 }
    }).populate('employee', 'firstName lastName').sort({ paymentDate: -1 }).lean();

    const tdsPayableItems = [
      ...tdsPayableExpenses.map(e => ({
        id: e._id,
        party: e.vendor?.name || e.party || 'Vendor',
        number: e.expenseNumber || 'Expense',
        amount: e.tdsAmount || e.tds_amount || 0,
        grandTotal: e.grandTotal,
        status: e.status,
        date: e.date,
        source: 'Expense TDS'
      })),
      ...tdsPayablePayrolls.map(p => ({
        id: p._id,
        party: p.employee ? `${p.employee.firstName} ${p.employee.lastName}` : 'Employee',
        number: `Payroll ${MONTHS[p.month - 1]} ${p.year}`,
        amount: p.deductions?.tds || 0,
        grandTotal: p.netSalary,
        status: p.status,
        date: p.paymentDate || p.createdAt,
        source: 'Payroll TDS'
      }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    const poQuery = {
      user: userId,
      status: { $nin: ['DRAFT', 'RECEIVED', 'BILLED', 'CANCELLED'] }
    };
    if (buId) poQuery.businessUnit = buId;

    const pendingPODocs = await PurchaseOrder.find(poQuery).select('poNumber vendor.name grandTotal date status').sort({ date: -1 }).lean();

    const pendingPOItems = pendingPODocs.map(po => ({
      id: po._id,
      party: po.vendor?.name || 'Vendor',
      number: po.poNumber || 'PO',
      amount: po.grandTotal,
      status: po.status,
      date: po.date,
      source: 'Purchase Order'
    }));

    const receivableDocs = await Invoice.find({
      user: userId,
      status: { $nin: ['DRAFT', 'PAID', 'CANCELLED'] }
    }).select('invoiceNo client.name grandTotal balanceDue date status').sort({ date: -1 }).lean();

    const receivableItems = receivableDocs.map(i => ({
      id: i._id,
      party: i.client?.name || 'Client',
      number: i.invoiceNo || 'Invoice',
      amount: i.balanceDue,
      grandTotal: i.grandTotal,
      status: i.status,
      date: i.date,
      source: 'Invoice Receivable'
    }));

    const payableDocs = await Expense.find({
      user: userId,
      status: { $nin: ['DRAFT', 'PAID', 'CANCELLED'] }
    }).select('expenseNumber vendor.name party grandTotal balanceDue date status').sort({ date: -1 }).lean();

    const payableItems = payableDocs.map(e => ({
      id: e._id,
      party: e.vendor?.name || e.party || 'Vendor',
      number: e.expenseNumber || 'Expense',
      amount: e.balanceDue,
      grandTotal: e.grandTotal,
      status: e.status,
      date: e.date,
      source: 'Expense Payable'
    }));

    res.json({
      period: { startDate, endDate, month: MONTHS[startDate.getUTCMonth()], year: startDate.getUTCFullYear() },
      summary: {
        outputLiability,
        inputCredit,
        netPayable,
        momOutput: pctChange(outputLiability, previousInvoiceTotals.taxTotal),
        momInput: pctChange(inputCredit, previousExpenseTotals.taxTotal),
        dueDate: gstDueDate,
        gstDueDate,
        tdsDueDate,
        totalInvoices: invoiceSplit.total,
        totalRevenue: roundTwo(incomeTotals.grandTotal + invoiceTotals.grandTotal),
        totalExpenses: roundTwo(expenseTotals.grandTotal),
        netProfit: roundTwo((incomeTotals.grandTotal + invoiceTotals.grandTotal) - expenseTotals.grandTotal),
        taxableRevenue: roundTwo(incomeTotals.subTotal + invoiceTotals.subTotal),
        gstLiability: outputLiability,
        gstCredit: inputCredit,
        netGstPayable: netPayable,
        tdsDeducted,
        tdsPayable,
        receivables,
        payables,
        netTaxPayable,
        tcsCollected: roundTwo(invoiceTotals.tcs),
        pendingPO: pendingPO.total,
        pendingPOCount: pendingPO.count,
        overdueTotal: overdueInvoices.total,
        overdueCount: overdueInvoices.count,
      },
      invoiceSplit,
      outputBySlab,
      inputBySlab,
      slabComparison: outputBySlab.map((row) => ({
        slab: row.slab,
        output: row.amount,
        input: inputBySlab.find((item) => item.slab === row.slab)?.amount || 0,
      })),
      trend6Months,
      itcUtilisation,
      igstCredit: expenseCredits.igst,
      cgstSgstCredit: expenseCredits.cgstSgst,
      creditOutputRatio: itcUtilisation,
      gst: {
        cgst: roundTwo(invoiceTotals.totalCGST),
        sgst: roundTwo(invoiceTotals.totalSGST),
        igst: roundTwo(invoiceTotals.totalIGST),
        liability: outputLiability,
        credit: inputCredit,
        netPayable,
        inputIgst: expenseCredits.igst,
        inputCgstSgst: expenseCredits.cgstSgst,
      },
      categories: expenseCategories,
      trend: trend6Months,
      overdueInvoices,
      topClients,
      pendingPO,
      draftCounts,
      recentIncome: revenueItems.slice(0, 10),
      recentExpenses: expenseItems.slice(0, 10),
      revenueItems,
      expenseItems,
      gstLiabilityItems,
      tdsDeductedItems,
      tdsPayableItems,
      pendingPOItems,
      receivableItems,
      payableItems,
      previousPeriod: {
        revenue: roundTwo(previousInvoiceTotals.grandTotal),
        expenses: roundTwo(previousExpenseTotals.grandTotal),
        outputLiability: roundTwo(previousInvoiceTotals.taxTotal),
        inputCredit: roundTwo(previousExpenseTotals.taxTotal),
      },
      totals: {
        incomeTax: roundTwo(incomeTotals.taxTotal),
        expenseTax: inputCredit,
        categoryExpenses: sum(expenseCategories, 'total'),
      },
    });
  } catch (error) {
    console.error('Error building tax dashboard:', error);
    if (error.message === 'Invalid startDate' || error.message === 'Invalid endDate') {
      return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Server error building tax dashboard' });
  }
};
