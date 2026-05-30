const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Expense = require('../models/Expense');
const Client = require('../models/Client'); // Vendor represents Client model theoretically
const Category = require('../models/Category');

dotenv.config();

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;

// Thresholds / default rates for FY 2025-26
const TDS_MAPPING = {
  '194C': { section: '194C', rate: 2, defaultLabel: 'Contractor' },
  '194J': { section: '194J', rate: 10, defaultLabel: 'Professional/Technical Fees' },
  '194I': { section: '194I', rate: 10, defaultLabel: 'Rent' },
  '194A': { section: '194A', rate: 10, defaultLabel: 'Interest' }
};

async function migrate() {
  if (!mongoUri) throw new Error('MONGO_URI or MONGODB_URI is required');

  await mongoose.connect(mongoUri);

  const expenses = await Expense.find({})
    .populate('category')
    .populate('subCategory')
    .populate('vendor.vendorRef')
    .lean();

  console.log(`Found ${expenses.length} expenses to migrate.`);

  let migratedCount = 0;

  for (const exp of expenses) {
    const update = {};
    const vendor = exp.vendor?.vendorRef;

    // Check if vendor has a valid GSTIN
    const vendorGST = String(vendor?.gstin || '').trim().toUpperCase();
    const hasGst = /^[0-9A-Z]{15}$/.test(vendorGST);

    // If vendor has GSTIN -> likely B2B expense, may have TDS applicable
    if (hasGst) {
      const catName = String(exp.category?.name || '').toLowerCase();
      const subCatName = String(exp.subCategory?.name || '').toLowerCase();

      let targetSection = null;

      if (catName.includes('rent') || subCatName.includes('rent')) {
        targetSection = '194I';
      } else if (catName.includes('professional') || subCatName.includes('legal') || subCatName.includes('accounting') || subCatName.includes('consulting')) {
        targetSection = '194J';
      } else if (catName.includes('contractor') || catName.includes('outsource') || subCatName.includes('freelancer') || subCatName.includes('developer') || subCatName.includes('contract')) {
        targetSection = '194C';
      } else if (catName.includes('interest') || subCatName.includes('interest')) {
        targetSection = '194A';
      }

      if (targetSection) {
        const mapping = TDS_MAPPING[targetSection];
        const baseAmount = Number(exp.subTotal) || 0;
        const computedTds = Math.round((baseAmount * (mapping.rate / 100)) * 100) / 100;

        Object.assign(update, {
          tdsApplicable: true,
          tdsSection: mapping.section,
          tdsRate: mapping.rate,
          tdsAmount: computedTds,
          tdsReceivable: computedTds,
          tdsPaidToGovernment: false,

          tds_applicable: true,
          tds_section: mapping.section,
          tds_rate: mapping.rate,
          tds_amount: computedTds,
          tds_nature: 'deductor',
          net_vendor_payment: Math.max(roundToTwo((Number(exp.grandTotal) || 0) - computedTds), 0)
        });
        migratedCount++;
      }
    }

    if (Object.keys(update).length) {
      await Expense.updateOne({ _id: exp._id }, { $set: update }, { runValidators: false });
    }
  }

  console.log(`Expense TDS migration complete. Migrated ${migratedCount} active TDS expenses.`);
  await mongoose.disconnect();
}

function roundToTwo(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

migrate().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
