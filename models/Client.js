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

module.exports = mongoose.model('Client', ClientSchema);
