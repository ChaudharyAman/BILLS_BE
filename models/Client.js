const mongoose = require('mongoose');

const ClientSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User',
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  clientType: {
    type: String,
    enum: ['Company', 'Individual'],
    default: 'Company',
  },
  // Basic Info
  gstTreatment: { type: String, default: 'Registered Business' },
  gstin: { type: String, trim: true, uppercase: true },
  pan: { type: String, trim: true, uppercase: true },
  tan: { type: String, trim: true, uppercase: true },
  tin: { type: String, trim: true },
  vat: { type: String, trim: true },
  tds_applicable: { type: Boolean, default: false },
  tds_default_section: { type: String, default: null, required: false },
  tds_default_rate: { type: Number, default: null, required: false },
  default_tds_section: { type: String, default: '' },
  default_tds_rate: { type: Number, default: 0 },
  website: { type: String, trim: true },
  currency: { type: String, default: 'INR' },
  
  // Flags
  isClient: { type: Boolean, default: true },
  isVendor: { type: Boolean, default: false },
  vendorRelation: { type: String, enum: ['Bought From', 'Sold To'], default: 'Bought From' },
  useForDispatch: { type: Boolean, default: false },
  clientWiseItemPrice: { type: Boolean, default: false },
  vendorCode: { type: String, trim: true },

  // Contact Info (Primary)
  email: { type: String, trim: true, lowercase: true },
  phone: { type: String, trim: true },

  // Multiple Contact Persons
  contacts: [{
    firstName: String,
    lastName: String,
    email: String,
    phone: String,
  }],

  // Addresses
  billingAddress: {
    line1: String,
    line2: String,
    city: String,
    state: String,
    zip: String,
    country: { type: String, default: 'India' },
  },
  shippingAddress: {
    line1: String,
    line2: String,
    city: String,
    state: String,
    zip: String,
    country: { type: String, default: 'India' },
  },
  placeOfSupply: { type: String, default: 'Delhi' }, // Keep for backward compat or auto-fill from address

  // Other Info Tab
  facebook: String,
  lst: String,
  cst: String,
  dlNo: String,

  // Notes Tab
  notes: String,

  // Opening Balance Tab
  openingBalance: { type: Number, default: 0 },
  pendingPayment: { type: Number, default: 0 },

}, { timestamps: true });

ClientSchema.index({ user: 1, name: 1 }, { unique: true });

function hasValidGstin(gstin) {
  return /^[0-9A-Z]{15}$/.test(String(gstin || '').trim().toUpperCase());
}

ClientSchema.pre('save', function() {
  if (hasValidGstin(this.gstin)) {
    this.clientType = 'Company';
    this.tds_applicable = true;
    this.tds_default_section = this.tds_default_section || this.default_tds_section || '194J';
    this.tds_default_rate = Number(this.tds_default_rate || this.default_tds_rate || 10);
    this.default_tds_section = this.tds_default_section;
    this.default_tds_rate = this.tds_default_rate;
  } else {
    this.clientType = 'Individual';
    this.tds_applicable = false;
    this.tds_default_section = null;
    this.tds_default_rate = null;
    this.default_tds_section = '';
    this.default_tds_rate = 0;
  }
});

module.exports = mongoose.model('Client', ClientSchema);
