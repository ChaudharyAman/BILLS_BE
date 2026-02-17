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
    city: String,
    state: String,
    zip: String,
  },
  gstin: String,
  email: String,
  phone: String,
  website: String,
  logoUrl: String, // Base64 or URL
}, { timestamps: true });

module.exports = mongoose.model('Settings', SettingsSchema);
