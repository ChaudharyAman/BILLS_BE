const Income = require('../models/Income');

function mapInvoiceStatusToIncomeStatus(invoice) {
  if (invoice.status === 'PAID' || Number(invoice.balanceDue) <= 0) {
    return 'PAID';
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
  while (true) {
    const candidate = `${baseNumber}-INV${counter}`;
    const taken = await Income.findOne({
      user: invoice.user,
      incomeNumber: candidate,
      sourceInvoice: { $ne: invoice._id },
    }).select('_id');

    if (!taken) {
      return candidate;
    }

    counter += 1;
  }
}

async function syncIncomeFromInvoice(invoice, session = null) {
  if (!invoice?._id || !invoice?.user) {
    return null;
  }

  if (String(invoice.status || '').toUpperCase() === 'DRAFT') {
    await removeIncomeForInvoice(invoice._id, invoice.user, session);
    return null;
  }

  const vendorRef = invoice.client?.clientRef || null;
  const vendorName = String(invoice.client?.name || '').trim();
  const incomeNumber = await buildSyncedIncomeNumber(invoice, session);

  const payload = {
    user: invoice.user,
    sourceType: 'invoice',
    sourceInvoice: invoice._id,
    incomeNumber,
    date: invoice.date || new Date(),
    vendor: vendorRef || vendorName
      ? {
          ...(vendorRef ? { vendorRef } : {}),
          ...(vendorName ? { name: vendorName } : {}),
        }
      : undefined,
    client: undefined,
    paymentMethod: invoice.paymentMode || '',
    reverseCharge: !!invoice.reverseCharge,
    items: mapInvoiceItemsToIncomeItems(invoice.items),
    subTotal: Number(invoice.subTotal) || 0,
    taxTotal: Number(invoice.taxTotal) || 0,
    grandTotal: Number(invoice.grandTotal) || 0,
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

module.exports = {
  syncIncomeFromInvoice,
  removeIncomeForInvoice,
};
