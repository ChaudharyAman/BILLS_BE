const Income = require('../models/Income');

function mapInvoiceStatusToIncomeStatus(invoice) {
  if (invoice.status === 'PAID' || invoice.status === 'RECEIVED' || Number(invoice.balanceDue) <= 0) {
    return 'PAID';
  }

  if (invoice.status === 'PARTIAL' || (invoice.status === 'SENT' && Number(invoice.advancePaid) > 0)) {
    return 'PARTIAL';
  }

  if (invoice.status === 'CANCELLED') {
    return 'CANCELLED';
  }

  if (invoice.status === 'DRAFT') {
    return 'DRAFT';
  }

  return 'UNPAID';
}

function mapInvoiceItemsToIncomeItems(items = []) {
  return items.map((item) => ({
    itemRef: item.itemRef || undefined,
    name: item.name || '',
    description: item.description || '',
    qty: Number(item.qty) || 0,
    unit: item.unit || '',
    rate: Number(item.rate) || 0,
    taxRate: Number(item.taxRate) || 0,
    taxAmount: Number(item.taxAmount) || 0,
    amount: Number(item.amount) || 0,
  }));
}

async function buildSyncedIncomeNumber(invoice, session = null) {
  const baseNumber = String(invoice.invoiceNo || '').trim() || `INV-${invoice._id}`;
  const currentMatchQuery = Income.findOne({
    user: invoice.user,
    sourceInvoice: invoice._id,
  }).select('incomeNumber');
  if (session) currentMatchQuery.session(session);
  const currentMatch = await currentMatchQuery;

  if (currentMatch?.incomeNumber === baseNumber) {
    return baseNumber;
  }

  const conflictingQuery = Income.findOne({
    user: invoice.user,
    incomeNumber: baseNumber,
    sourceInvoice: { $ne: invoice._id },
  }).select('_id');
  if (session) conflictingQuery.session(session);
  const conflicting = await conflictingQuery;

  if (!conflicting) {
    return baseNumber;
  }

  let counter = 1;
  const maxAttempts = 200;
  while (counter <= maxAttempts) {
    const candidate = `${baseNumber}-INV${counter}`;
    const takenQuery = Income.findOne({
      user: invoice.user,
      incomeNumber: candidate,
      sourceInvoice: { $ne: invoice._id },
    }).select('_id');
    if (session) takenQuery.session(session);
    const taken = await takenQuery;

    if (!taken) {
      return candidate;
    }

    counter += 1;
  }

  throw new Error('Cannot generate unique income number');
}

async function syncIncomeFromInvoice(invoice, session = null) {
  if (!invoice?._id || !invoice?.user) {
    return null;
  }

  const isFullyPaid = invoice.status === 'PAID' || invoice.status === 'RECEIVED' || Number(invoice.balanceDue) <= 0;
  const isPartial = invoice.status === 'PARTIAL' || (invoice.status === 'SENT' && Number(invoice.advancePaid) > 0);

  if (!isFullyPaid && !isPartial) {
    await removeIncomeForInvoice(invoice._id, invoice.user, session);
    return null;
  }

  // Calculate ratio of payment received
  let ratio = 1;
  if (!isFullyPaid && isPartial) {
    const total = Number(invoice.grandTotal) || 0;
    const paid = Number(invoice.advancePaid) || 0;
    if (total > 0) {
      ratio = paid / total;
    } else {
      ratio = 0;
    }
  }

  const clientRef = invoice.client?.clientRef || null;
  const clientName = String(invoice.client?.name || '').trim();
  const incomeNumber = await buildSyncedIncomeNumber(invoice, session);

  const payload = {
    user: invoice.user,
    sourceType: 'invoice',
    sourceInvoice: invoice._id,
    businessUnit: invoice.businessUnit || null,
    incomeNumber,
    date: invoice.date || new Date(),
    vendor: undefined,
    client: clientRef || clientName
      ? {
          ...(clientRef ? { clientRef } : {}),
          ...(clientName ? { name: clientName } : {}),
        }
      : undefined,
    paymentMethod: invoice.paymentMode || '',
    reverseCharge: !!invoice.reverseCharge,
    items: mapInvoiceItemsToIncomeItems(invoice.items),
    subTotal: Math.round((Number(invoice.subTotal) || 0) * ratio * 100) / 100,
    taxTotal: Math.round((Number(invoice.taxTotal) || 0) * ratio * 100) / 100,
    totalCGST: Math.round((Number(invoice.totalCGST) || 0) * ratio * 100) / 100,
    totalSGST: Math.round((Number(invoice.totalSGST) || 0) * ratio * 100) / 100,
    totalIGST: Math.round((Number(invoice.totalIGST) || 0) * ratio * 100) / 100,
    grandTotal: Math.round((Number(invoice.grandTotal) || 0) * ratio * 100) / 100,
    terms: invoice.terms || '',
    privateNotes: invoice.notes || '',
    status: mapInvoiceStatusToIncomeStatus(invoice),
  };

  const query = Income.findOneAndUpdate(
    { user: invoice.user, sourceInvoice: invoice._id },
    { $set: payload },
    {
      upsert: true,
      returnDocument: 'after',
      runValidators: true,
      setDefaultsOnInsert: true,
    }
  );
  if (session) query.session(session);
  return query;
}

async function removeIncomeForInvoice(invoiceId, userId, session = null) {
  if (!invoiceId || !userId) {
    return;
  }

  const deleteQuery = Income.deleteOne({ user: userId, sourceInvoice: invoiceId });
  if (session) deleteQuery.session(session);
  await deleteQuery;
}

/**
 * Startup cleanup: remove synced income records where the source invoice
 * is not PAID or PARTIAL (e.g. UNPAID, DRAFT, CANCELLED, or orphaned).
 */
async function cleanupStaleIncomes() {
  const Invoice = require('../models/Invoice');

  const syncedIncomes = await Income.find({ sourceType: 'invoice' })
    .select('_id incomeNumber sourceInvoice')
    .lean();

  if (syncedIncomes.length === 0) return;

  let removedCount = 0;

  for (const income of syncedIncomes) {
    let shouldRemove = false;

    if (!income.sourceInvoice) {
      shouldRemove = true;
    } else {
      const invoice = await Invoice.findById(income.sourceInvoice)
        .select('status balanceDue advancePaid')
        .lean();

      if (!invoice) {
        shouldRemove = true;
      } else {
        const isFullyPaid = invoice.status === 'PAID' || Number(invoice.balanceDue) <= 0;
        const isPartial = invoice.status === 'PARTIAL' || (invoice.status === 'SENT' && Number(invoice.advancePaid) > 0);
        shouldRemove = !isFullyPaid && !isPartial;
      }
    }

    if (shouldRemove) {
      await Income.deleteOne({ _id: income._id });
      removedCount++;
    } else {
      // Backfill missing businessUnit from source invoice
      const invoice = await Invoice.findById(income.sourceInvoice).select('businessUnit').lean();
      if (invoice?.businessUnit && String(income.businessUnit || '') !== String(invoice.businessUnit)) {
        await Income.updateOne({ _id: income._id }, { $set: { businessUnit: invoice.businessUnit } });
      }
    }
  }

  if (removedCount > 0) {
    console.log(`[Income Cleanup] Removed ${removedCount} stale synced income records.`);
  }
}

module.exports = {
  syncIncomeFromInvoice,
  removeIncomeForInvoice,
  cleanupStaleIncomes,
};
