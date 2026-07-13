const mongoose = require('mongoose');
const softDeletePlugin = require('../middleware/softDeletePlugin');

const ItemSchema = new mongoose.Schema({
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
  type: {
    type: String,
    enum: ['Goods', 'Service'],
    default: 'Goods',
  },
  description: String,
  hsnCode: {
    type: String,
    trim: true,
  },
  sku: {
    type: String,
    trim: true,
  },
  openingQuantity: {
    type: Number,
    default: 0,
  },
  unit: {
    type: String,
    default: 'pcs',
    trim: true,
  },
  salesInfo: {
    price: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
    cessPercent: { type: Number, default: 0 },
    cessAmount: { type: Number, default: 0 },
  },
  purchaseInfo: {
    price: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
    cessPercent: { type: Number, default: 0 },
    cessAmount: { type: Number, default: 0 },
  },
  // Keep rate/taxRate for backward compatibility or simple usage if needed, 
  // but UI will primarily use salesInfo/purchaseInfo
  rate: {
    type: Number,
    default: 0,
  },
  // Top-level convenience fields (mapped from salesInfo/purchaseInfo by controller)
  purchasePrice: { type: Number, default: 0 },
  sellingPrice:  { type: Number, default: 0 },
  taxRate:       { type: Number, default: 0 }, // Alias for defaultTaxRate
  defaultTaxRate: {
    type: Number,
    default: 0, 
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
}, { timestamps: true });

ItemSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('Item', ItemSchema);
