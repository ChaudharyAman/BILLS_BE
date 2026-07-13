const mongoose = require('mongoose');
const softDeletePlugin = require('../middleware/softDeletePlugin');



// Sub-schema for Invoice Items (Snapshot)
const InvoiceItemSchema = new mongoose.Schema({

  itemRef: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Item',
  },
  name: { type: String, required: true },
  description: String,
  hsnCode: String,
  qty: { type: Number, required: true, min: 0 },
  unit: String,
  rate: { type: Number, required: true, min: 0 },
  discount: { type: Number, default: 0 }, // Percentage, not value
  
  // Tax details per item
  taxRate: { type: Number, default: 0 }, // %
  // Tax Amounts Split
  cgst: { type: Number, default: 0 },
  sgst: { type: Number, default: 0 },
  igst: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 }, // Total Tax
  
  // Excise per-item fields
  bedPercent: { type: Number, default: 0 },
  sedPercent: { type: Number, default: 0 },
  cessPercent: { type: Number, default: 0 },
  exciseAmount: { type: Number, default: 0 },
  
  // Final amount for this line item
  amount: { type: Number, required: true }, 
});

const InvoiceSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User',
    index: true
  },
  invoiceNo: {
    type: String,
    required: true,
  },
  invoiceType: {
    type: String,
    enum: ['Invoice', 'Retail Invoice', 'Tax Invoice', 'Excise Invoice', 'B2B', 'B2C', 'Export', 'NilRated'],
    default: 'Tax Invoice',
  },
  gstInvoiceType: {
    type: String,
    enum: ['B2B', 'B2C', 'Export', 'NilRated'],
    required: false,
  },
  overrideInvoiceType: { type: Boolean, default: false, required: false },
  date: {
    type: Date,
    default: Date.now,
    required: true,
  },
  dueDate: Date,
  paymentMode: String,
  paymentTerms: String, // e.g., "On Receipt", "Net 30"
  
  // Embedded Client Snapshot
  client: {
    clientRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Client' },
    name: { type: String, required: true },
    address: {
      line1: String,
      line2: String,
      city: String,
      state: String,
      zip: String,
      country: String,
    },
    shippingAddress: {
      line1: String,
      line2: String,
      city: String,
      state: String,
      zip: String,
      country: String,
    },
    gstin: String,
    phone: String,
    email: String,
  },
  
  // Shipping Address (Snapshot)
  shippingAddress: {
    line1: String,
    line2: String,
    city: String,
    state: String,
    zip: String,
    country: String,
  },

  // Logistics / Transport Details
  transport: {
    mode: String, // Road, Rail, Air, Ship
    vehicleNumber: String,
    distance: String,
    transporterName: String,
    challanNumber: String,
    challanDate: Date,
    poNumber: String,
    poDate: Date,
    eWayBillNo: String,
  },
  
  // GST Details
  placeOfSupply: String, // State
  reverseCharge: { type: Boolean, default: false },

  // Bank Details Snapshot
  bankDetails: {
    accountName: String,
    accountNumber: String,
    ifscCode: String,
    bankName: String,
    branch: String,
  },
  
  items: [InvoiceItemSchema],
  
  // Financial Summary
  subTotal: { type: Number, default: 0 }, // Sum of (Rate * Qty - Discount)
  taxTotal: { type: Number, default: 0 }, // Sum of all taxAmounts
  
  // Extra Charges & Discounts
  shippingCharges: { type: Number, default: 0 },
  packagingCharges: { type: Number, default: 0 }, // Optional custom amount
  customChargeLabel: { type: String, default: 'Custom Amount' },
  discountTotal: { type: Number, default: 0 }, // Global discount applied on subtotal
  totalAmount: { type: Number, default: 0 }, // subTotal - discountTotal + taxes + shipping
  radiusDiscount: { type: Number, default: 0 }, // "Discount to all" concept if valid, else ignore
  
  // Advance & Payment
  advancePaid: { type: Number, default: 0 },
  balanceDue: { type: Number, default: 0 },
  paymentDate: Date, // Date of full/partial payment

  // Global Tax Breakdown
  totalCGST: { type: Number, default: 0 },
  totalSGST: { type: Number, default: 0 },
  totalIGST: { type: Number, default: 0 },
  
  grandTotal: { type: Number, default: 0 }, // Final Payable Amount
  
  // Financial Year & Currency
  fy: String, // e.g., "2023-24"
  currency: { type: String, default: 'INR' },
  
  // Tax Deducted/Collected at Source
  tds: { type: Number, default: 0 },
  tdsApplicable: { type: Boolean, default: false },
  tdsSection: { type: String, default: '' },
  tdsRate: { type: Number, default: 0 },
  tdsAmount: { type: Number, default: 0, required: false },
  tdsReceivable: { type: Number, default: 0, required: false },
  tds_applicable: { type: Boolean, default: false },
  tds_section: { type: String, default: '' },
  tds_section_label: { type: String, default: '' },
  tds_rate: { type: Number, default: 0 },
  tds_base_amount: { type: Number, default: 0 },
  tds_amount: { type: Number, default: 0 },
  net_payable: { type: Number, default: 0 },
  client_will_deduct_tds: { type: Boolean, default: false },
  tds_receivable_amount: { type: Number, default: 0 },
  expected_receipt: { type: Number, default: 0 },
  tcs: { type: Number, default: 0 },
  
  // Debit / Credit indicator
  drCr: { type: String, default: 'Dr.' },

  // Status
  status: {
    type: String,
    enum: ['DRAFT', 'SENT', 'PAID', 'PARTIAL', 'UNPAID', 'CANCELLED'],
    default: 'DRAFT',
  },
  
  notes: String,
  terms: String,

  // Excise Invoice specific
  exciseDuty: {
    bedPercent: { type: Number, default: 0 },
    sedPercent: { type: Number, default: 0 },
    cessPercent: { type: Number, default: 0 },
    totalExcise: { type: Number, default: 0 },
    manufacturerName: String,
    manufacturerAddress: String,
    clearanceDate: Date,
    rangeCode: String,
  },

  purchaseOrderRef: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PurchaseOrder',
  },

}, { timestamps: true });

InvoiceSchema.index({ user: 1, invoiceNo: 1 }, { unique: true });
InvoiceSchema.index({ user: 1, date: 1 });
InvoiceSchema.index({ user: 1, invoiceType: 1 });
InvoiceSchema.index({ user: 1, gstInvoiceType: 1 });
InvoiceSchema.index({ user: 1, 'items.taxRate': 1 });

InvoiceItemSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Invoice', InvoiceSchema);
