const mongoose = require('mongoose');

const SettingsSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  companyName: {
    type: String,
    required: true,
    default: 'My Company',
  },
  address: {
    line1: String,
    line2: String,
    city: String,
    state: String,
    zip: String,
    country: String,
  },
  gstin: String,
  pan: String,
  email: String,
  phone: String,
  website: String,
  contactName: String,
  logoUrl: String,
  signatureUrl: String,

  // Bank Details — used as snapshot on invoices
  bankDetails: {
    accountName:   String,
    bankName:      String,
    accountNumber: String,
    branch:        String,
    ifscCode:      String,
  },

  // Document Numbering Prefixes
  invoicePrefix:       { type: String, default: 'INV' },
  proformaPrefix:      { type: String, default: 'PRF' },
  quotePrefix:         { type: String, default: 'QT' },
  expensePrefix:       { type: String, default: 'EXP' },
  purchaseOrderPrefix: { type: String, default: 'PO' },
  receiptPrefix:       { type: String, default: 'REC' },

  // Document Defaults
  defaultTerms:    String,
  defaultNotes:    String,
  defaultCurrency: { type: String, default: 'INR' },
  timezone:        { type: String, default: 'Asia/Kolkata' },
  dateFormat:      { type: String, default: 'DD-MMM-YYYY' },

  integration: {
    enabled: { type: Boolean, default: false },
    externalTenantId: { type: String, default: '', index: true },
    apiUrl: { type: String, default: '' },
    apiKey: { type: String, default: '' },
    encryptionSecret: { type: String, default: '' },
    webhookSecret: { type: String, default: '' }
  },

  // Public Submission Portal — shareable link for vendors/clients to submit bills/invoices
  publicSubmissions: {
    enabled: { type: Boolean, default: false },
    // Randomly generated hex token; NEVER derived from or equal to the User _id
    token: { type: String, default: null },
    // Display name shown on the public page (not necessarily the same as companyName)
    companyDisplayName: { type: String, default: '' },
    // Which document categories the submitter may choose from
    allowedCategories: {
      type: [String],
      enum: ['invoice', 'expense', 'income', 'purchaseorder'],
      default: ['invoice', 'expense', 'income', 'purchaseorder'],
    },
    // Optional instructions shown at the top of the public page
    instructionsText: { type: String, default: '' },
    // Hard cap on submissions per calendar day (abuse guard)
    maxSubmissionsPerDay: { type: Number, default: 100, min: 1, max: 10000 },
  },

}, { timestamps: true });

// Sparse unique index: only Settings documents that have a token value are indexed.
// This allows the fast token→user lookup without indexing the null values of
// users who have never enabled the portal.
SettingsSchema.index({ 'publicSubmissions.token': 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Settings', SettingsSchema);
