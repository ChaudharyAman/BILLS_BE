const mongoose = require('mongoose');

const AssetSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  category: { type: String, enum: ['current', 'fixed', 'intangible'], required: true, index: true },
  purchaseDate: Date,
  purchaseValue: { type: Number, required: true, min: 0 },
  currentValue: { type: Number, default: 0, min: 0 },
  depreciationMethod: {
    type: String,
    enum: ['straight-line', 'declining-balance', 'none'],
    default: 'straight-line',
  },
  depreciationRate: { type: Number, default: 0, min: 0 },
  usefulLife: { type: Number, min: 0 },
  salvageValue: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: ['active', 'disposed', 'sold'], default: 'active', index: true },
}, { timestamps: true });

AssetSchema.pre('save', function(next) {
  if (!this.currentValue) this.currentValue = this.purchaseValue;
  next();
});

module.exports = mongoose.model('Asset', AssetSchema);
