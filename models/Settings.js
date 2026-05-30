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

}, { timestamps: true });

module.exports = mongoose.model('Settings', SettingsSchema);
