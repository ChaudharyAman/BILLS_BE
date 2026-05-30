const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Invoice = require('../models/Invoice');
require('../models/Client');
const { calculateTds } = require('../utils/tdsCalculator');

dotenv.config();

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
const GSTIN_REGEX = /^[0-9A-Z]{15}$/;

function determineInvoiceType(invoice) {
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  if (items.length && items.every((item) => item.isNilRated === true || Number(item.taxRate) === 0)) return 'NilRated';
  if (/international|export/i.test(String(invoice.placeOfSupply || ''))) return 'Export';
  if (GSTIN_REGEX.test(String(invoice.client?.gstin || invoice.client?.clientRef?.gstin || '').trim().toUpperCase())) return 'B2B';
  return 'B2C';
}

async function migrate() {
  if (!mongoUri) throw new Error('MONGO_URI or MONGODB_URI is required');

  await mongoose.connect(mongoUri);
  const invoices = await Invoice.find({})
    .select('user invoiceType gstInvoiceType overrideInvoiceType items placeOfSupply client subTotal grandTotal taxTotal')
    .populate('client.clientRef')
    .lean();
  const counts = { B2B: 0, B2C: 0, Export: 0, NilRated: 0 };
  let tdsUpdated = 0;
  let missingUser = 0;

  for (const invoice of invoices) {
    const update = {};
    let gstInvoiceType = invoice.gstInvoiceType;

    if (!invoice.overrideInvoiceType) {
      gstInvoiceType = determineInvoiceType(invoice);
      update.gstInvoiceType = gstInvoiceType;
    } else if (!gstInvoiceType && ['B2B', 'B2C', 'Export', 'NilRated'].includes(invoice.invoiceType)) {
      gstInvoiceType = invoice.invoiceType;
      update.gstInvoiceType = gstInvoiceType;
    }

    counts[gstInvoiceType] = (counts[gstInvoiceType] || 0) + 1;
    const client = invoice.client?.clientRef;
    const clientTdsApplies = gstInvoiceType === 'B2B' && client?.tds_applicable === true;

    if (clientTdsApplies) {
      const baseAmount = Number(invoice.subTotal) || Math.max((Number(invoice.grandTotal) || 0) - (Number(invoice.taxTotal) || 0), 0);
      const tds = calculateTds({
        baseAmount,
        section: client.tds_default_section || client.default_tds_section || '194J',
        rate: client.tds_default_rate || client.default_tds_rate || 10,
      });

      Object.assign(update, {
        tdsApplicable: true,
        tds_applicable: true,
        tdsSection: tds.section,
        tdsRate: tds.rate,
        tdsAmount: tds.amount,
        tdsReceivable: tds.receivable,
        tds_section: tds.section,
        tds_section_label: tds.sectionLabel,
        tds_rate: tds.rate,
        tds_base_amount: tds.baseAmount,
        tds_amount: tds.amount,
        tds_receivable_amount: tds.receivable,
        client_will_deduct_tds: true,
        expected_receipt: Math.max((Number(invoice.grandTotal) || 0) - tds.receivable, 0),
      });
      tdsUpdated += 1;
    }

    if (!invoice.user) missingUser += 1;
    if (Object.keys(update).length) {
      await Invoice.updateOne({ _id: invoice._id }, { $set: update }, { runValidators: false });
    }
  }

  console.log(`Invoice type migration complete. ${JSON.stringify(counts)}. TDS updated: ${tdsUpdated}. Legacy invoices without user: ${missingUser}`);
  await mongoose.disconnect();
}

migrate().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
