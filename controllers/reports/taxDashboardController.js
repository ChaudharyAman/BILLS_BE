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
    const year = Number(query.year) || now.getFullYear();
    const month = Math.min(12, Math.max(1, Number(query.month) || now.getMonth() + 1));
    return {
      startDate: new Date(year, month - 1, 1),
      endDate: new Date(year, month, 0, 23, 59, 59, 999),
    };
  }

  const now = new Date();
  const startDate = query.startDate ? new Date(query.startDate) : new Date(now.getFullYear(), now.getMonth(), 1);
  const endDate = query.endDate ? new Date(query.endDate) : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  if (query.startDate && Number.isNaN(startDate.getTime())) throw new Error('Invalid startDate');
  if (query.endDate && Number.isNaN(endDate.getTime())) throw new Error('Invalid endDate');

  endDate.setHours(23, 59, 59, 999);
  return { startDate, endDate };
}

function previousPeriodRange(startDate, endDate) {
  const durationMs = endDate.getTime() - startDate.getTime();
  const durationDays = Math.round(durationMs / (1000 * 60 * 60 * 24));

  // For single-month views (~28-31 days), compare against the prior month
  if (durationDays <= 31) {
    return {
      startDate: new Date(startDate.getFullYear(), startDate.getMonth() - 1, 1),
      endDate: new Date(startDate.getFullYear(), startDate.getMonth(), 0, 23, 59, 59, 999),
    };
  }

  // For multi-month ranges, shift the entire range backwards by its own duration
  const prevEnd = new Date(startDate.getTime() - 1);
  prevEnd.setHours(23, 59, 59, 999);
  const prevStart = new Date(prevEnd.getTime() - durationMs);
  prevStart.setHours(0, 0, 0, 0);
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

async function aggregateTotals(Model, userId, startDate, endDate, fields, allowedStatuses = ACTIVE_EXPENSE_STATUSES) {
  const project = fields.reduce((acc, field) => ({ ...acc, [field]: { $sum: `$${field}` } }), {});
  const [result] = await Model.aggregate([
    { $match: { user: userId, date: { $gte: startDate, $lte: endDate }, status: allowedStatuses } },
    { $group: { _id: null, ...project } },
  ]);
  return result || fields.reduce((acc, field) => ({ ...acc, [field]: 0 }), {});
}

async function getInvoiceSplit(userId, startDate, endDate) {
  const invoices = await Invoice.find({
    user: userId,
    date: { $gte: startDate, $lte: endDate },
    status: { $in: ACTIVE_INVOICE_STATUSES },
  }).select('invoiceType gstInvoiceType placeOfSupply client.gstin items.taxRate items.isNilRated').lean();

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

async function getSlabTotals(Model, userId, startDate, endDate, allowedStatuses = ACTIVE_EXPENSE_STATUSES) {
  const isExpense = Model.modelName === 'Expense';

  const sumExpression = isExpense
    ? {
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
    : '$items.taxAmount';

  const rows = await Model.aggregate([
    { $match: { user: userId, date: { $gte: startDate, $lte: endDate }, status: allowedStatuses } },
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

async function getTrend6Months(userId, endDate) {
  const start = new Date(endDate.getFullYear(), endDate.getMonth() - 5, 1);
  const end = new Date(endDate.getFullYear(), endDate.getMonth() + 1, 0, 23, 59, 59, 999);
  const pipeline = (statusFilter) => [
    { $match: { user: userId, date: { $gte: start, $lte: end }, status: statusFilter } },
    { $group: { _id: { year: { $year: '$date' }, month: { $month: '$date' } }, tax: { $sum: '$taxTotal' }, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
  ];

  const [invoiceRows, expenseRows] = await Promise.all([
    Invoice.aggregate(pipeline({ $in: ACTIVE_INVOICE_STATUSES })),
    Expense.aggregate(pipeline(ACTIVE_EXPENSE_STATUSES)),
  ]);
  const invoiceMap = new Map(invoiceRows.map((row) => [`${row._id.year}-${row._id.month}`, row]));
  const expenseMap = new Map(expenseRows.map((row) => [`${row._id.year}-${row._id.month}`, row]));

  return Array.from({ length: 6 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth() + index, 1);
    const key = `${date.getFullYear()}-${date.getMonth() + 1}`;
    const output = invoiceMap.get(key);
    const input = expenseMap.get(key);
    return {
      month: MONTHS[date.getMonth()],
      output: roundTwo(output?.tax || 0),
      input: roundTwo(input?.tax || 0),
      revenue: roundTwo(output?.total || 0),
      expenses: roundTwo(input?.total || 0),
      invoiceCount: output?.count || 0,
    };
  });
}

async function getExpenseGstCredits(userId, startDate, endDate) {
  const Settings = require('../../models/Settings');
  const Client = require('../../models/Client');

  // 1. Get user's business state code from their GSTIN in Settings
  const settings = await Settings.findOne({ user: userId }).select('gstin').lean();
  const userGstin = String(settings?.gstin || '').trim().toUpperCase();
  const userStateCode = /^[0-9]{2}/.test(userGstin) ? userGstin.substring(0, 2) : '';

  // 2. Fetch all active expenses with their vendor refs and item tax data
  const expenses = await Expense.find({
    user: userId,
    date: { $gte: startDate, $lte: endDate },
    status: ACTIVE_EXPENSE_STATUSES,
  }).select('vendor items.taxRate items.taxAmount items.amount').lean();

  // 3. Collect unique vendor refs to batch-lookup their GSTINs
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

  // 4. Iterate expenses and split each item's tax into IGST or CGST+SGST
  let igst = 0;
  let cgst = 0;
  let sgst = 0;

  for (const expense of expenses) {
    const vendorGstin = expense.vendor?.vendorRef
      ? (vendorGstinMap.get(String(expense.vendor.vendorRef)) || '')
      : '';
    const vendorStateCode = /^[0-9]{2}/.test(vendorGstin) ? vendorGstin.substring(0, 2) : '';

    // Determine inter-state vs intra-state
    // If both state codes are known and different → IGST (inter-state)
    // Otherwise → CGST+SGST (intra-state, or default when state unknown)
    const isInterState = userStateCode && vendorStateCode && userStateCode !== vendorStateCode;

    const items = Array.isArray(expense.items) ? expense.items : [];
    for (const item of items) {
      const taxAmt = Number(item.taxAmount) || 0;
      // If taxAmount is 0, try to compute from amount * taxRate
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

async function getExpenseCategories(userId, startDate, endDate) {
  return Expense.aggregate([
    { $match: { user: userId, date: { $gte: startDate, $lte: endDate }, status: ACTIVE_EXPENSE_STATUSES } },
    { $group: { _id: '$category', total: { $sum: '$grandTotal' } } },
    { $lookup: { from: 'categories', localField: '_id', foreignField: '_id', as: 'category' } },
    { $unwind: { path: '$category', preserveNullAndEmptyArrays: true } },
    { $project: { _id: 0, name: { $ifNull: ['$category.name', 'Uncategorized'] }, total: 1 } },
    { $sort: { total: -1 } },
    { $limit: 6 },
  ]);
}



async function getPayrollTdsPayable(userId, startDate, endDate) {
  const [result] = await Payroll.aggregate([
    { $match: { user: userId, status: { $nin: ['cancelled', 'draft'] }, paymentDate: { $gte: startDate, $lte: endDate } } },
    { $group: { _id: null, total: { $sum: '$deductions.tds' } } },
  ]);
  return result?.total || 0;
}

async function getReceivables(userId) {
  const [result] = await Invoice.aggregate([
    { $match: { user: userId, status: { $nin: ['DRAFT', 'PAID', 'CANCELLED'] } } },
    { $group: { _id: null, total: { $sum: '$balanceDue' } } },
  ]);
  return result?.total || 0;
}

async function getPayables(userId) {
  const [result] = await Expense.aggregate([
    { $match: { user: userId, status: { $nin: ['DRAFT', 'PAID', 'CANCELLED'] } } },
    { $group: { _id: null, total: { $sum: '$balanceDue' } } },
  ]);
  return result?.total || 0;
}

async function getOverdueInvoices(userId) {
  const now = new Date();
  const invoices = await Invoice.aggregate([
    { $match: { user: userId, status: { $nin: ['DRAFT', 'PAID', 'CANCELLED'] }, dueDate: { $lt: now, $exists: true } } },
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
  return { total, count: invoices.length, aging };
}

const getTopClients = (userId, startDate, endDate) => Invoice.aggregate([
  { $match: { user: userId, date: { $gte: startDate, $lte: endDate }, status: { $in: ACTIVE_INVOICE_STATUSES } } },
  { $group: { _id: { $ifNull: ['$client.name', 'Unknown'] }, total: { $sum: '$grandTotal' } } },
  { $sort: { total: -1 } },
  { $limit: 5 },
  { $project: { _id: 0, name: '$_id', total: 1 } },
]);

async function getPendingPO(userId) {
  const [result] = await PurchaseOrder.aggregate([
    { $match: { user: userId, status: { $nin: ['DRAFT', 'RECEIVED', 'BILLED', 'CANCELLED'] } } },
    { $group: { _id: null, total: { $sum: '$grandTotal' }, count: { $sum: 1 } } },
  ]);
  return { total: result?.total || 0, count: result?.count || 0 };
}

async function getDraftCounts(userId) {
  const [invoices, expenses] = await Promise.all([
    Invoice.countDocuments({ user: userId, status: 'DRAFT' }),
    Expense.countDocuments({ user: userId, status: 'DRAFT' }),
  ]);
  return { invoices, expenses, total: invoices + expenses };
}

async function getExpenseTdsPayable(userId, startDate, endDate) {
  const [result] = await Expense.aggregate([
    { $match: { user: userId, date: { $gte: startDate, $lte: endDate }, status: ACTIVE_EXPENSE_STATUSES, tds_applicable: true } },
    { $group: { _id: null, total: { $sum: '$tds_amount' } } },
  ]);
  return result?.total || 0;
}

async function getInvoiceTdsDeducted(userId, startDate, endDate) {
  const [result] = await Invoice.aggregate([
    { $match: { user: userId, date: { $gte: startDate, $lte: endDate }, status: { $in: ACTIVE_INVOICE_STATUSES } } },
    {
      $project: {
        tdsValue: { $max: [{ $ifNull: ['$tds_amount', 0] }, { $ifNull: ['$tdsAmount', 0] }, { $ifNull: ['$tds', 0] }] },
      },
    },
    { $group: { _id: null, total: { $sum: '$tdsValue' } } },
  ]);
  return result?.total || 0;
}

exports.getTaxDashboard = async (req, res) => {
  try {
    const { startDate, endDate } = getMonthRange(req.query);
    const previous = previousPeriodRange(startDate, endDate);
    const userId = req.user._id;

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
      aggregateTotals(Income, userId, startDate, endDate, ['subTotal', 'taxTotal', 'grandTotal'], { $in: ['PAID', 'PARTIAL'] }),
      aggregateTotals(Expense, userId, startDate, endDate, ['subTotal', 'taxTotal', 'grandTotal']),
      aggregateTotals(Invoice, userId, startDate, endDate, ['subTotal', 'taxTotal', 'grandTotal', 'totalCGST', 'totalSGST', 'totalIGST', 'tds', 'tds_amount', 'tdsAmount', 'tcs'], { $in: ACTIVE_INVOICE_STATUSES }),
      aggregateTotals(Invoice, userId, previous.startDate, previous.endDate, ['taxTotal'], { $in: ACTIVE_INVOICE_STATUSES }),
      aggregateTotals(Expense, userId, previous.startDate, previous.endDate, ['taxTotal']),
      getInvoiceSplit(userId, startDate, endDate),
      getSlabTotals(Invoice, userId, startDate, endDate, { $in: ACTIVE_INVOICE_STATUSES }),
      getSlabTotals(Expense, userId, startDate, endDate, ACTIVE_EXPENSE_STATUSES),
      getTrend6Months(userId, endDate),
      getExpenseGstCredits(userId, startDate, endDate),
      getExpenseCategories(userId, startDate, endDate),
      getPayrollTdsPayable(userId, startDate, endDate),
      getExpenseTdsPayable(userId, startDate, endDate),
      getInvoiceTdsDeducted(userId, startDate, endDate),
      getReceivables(userId),
      getPayables(userId),
      getOverdueInvoices(userId),
      getTopClients(userId, startDate, endDate),
      getPendingPO(userId),
      getDraftCounts(userId),
    ]);

    const outputLiability = roundTwo(invoiceTotals.taxTotal);
    const inputCredit = roundTwo(expenseTotals.taxTotal);
    const netPayable = Math.max(roundTwo(outputLiability - inputCredit), 0);
    const itcUtilisation = outputLiability ? roundTwo((inputCredit / outputLiability) * 100) : 0;
    const tdsDeducted = roundTwo(invoiceTdsDeducted);
    const tdsPayable = roundTwo(payrollTdsPayable + expenseTdsPayable);
    const netTaxPayable = Math.max(roundTwo(netPayable + tdsPayable - tdsDeducted), 0);
    const dueDate = new Date(endDate.getFullYear(), endDate.getMonth() + 1, 20);

    res.json({
      period: { startDate, endDate, month: MONTHS[startDate.getMonth()], year: startDate.getFullYear() },
      summary: {
        outputLiability,
        inputCredit,
        netPayable,
        momOutput: pctChange(outputLiability, previousInvoiceTotals.taxTotal),
        momInput: pctChange(inputCredit, previousExpenseTotals.taxTotal),
        dueDate,
        totalInvoices: invoiceSplit.total,
        totalRevenue: roundTwo(incomeTotals.grandTotal || invoiceTotals.grandTotal),
        totalExpenses: roundTwo(expenseTotals.grandTotal),
        netProfit: roundTwo((incomeTotals.grandTotal || invoiceTotals.grandTotal) - expenseTotals.grandTotal),
        taxableRevenue: roundTwo(incomeTotals.subTotal || invoiceTotals.subTotal),
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
      previousPeriod: {
        revenue: 0,
        expenses: 0,
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
