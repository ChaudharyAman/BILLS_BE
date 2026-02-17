const mongoose = require('mongoose');

const ClientSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
  },
  phone: {
    type: String,
    trim: true,
  },
  gstin: {
    type: String,
    trim: true,
    uppercase: true,
  },
  address: {
    line1: String,
    line2: String,
    city: String,
    state: String,
    zip: String,
    country: {
      type: String,
      default: 'India',
    },
  },
  // Shipping Address (Optional)
  shippingAddress: {
    line1: String,
    line2: String,
    city: String,
    state: String,
    zip: String,
    country: { type: String, default: 'India' },
  },
  // Place of Supply (usually State) for GST
  placeOfSupply: {
    type: String,
    required: true, 
    default: 'Delhi' // Default to home state if not specified, should be validated
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Client', ClientSchema);
