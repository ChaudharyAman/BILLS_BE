/**
 * Mongoose Schema definition for item-level logistics fields:
 * - Multi-currency support (currency, exRate, foreignRate)
 * - Taxable base override (taxableAmount)
 * - Zero-GST freight exemption flag (isTaxExempt)
 */
const logisticsItemFields = {
  currency: { type: String, default: 'INR' },
  exRate: { type: Number, default: 1 },
  foreignRate: { type: Number, default: 0 },
  taxableAmount: { type: Number },
  isTaxExempt: { type: Boolean, default: false },
};

module.exports = logisticsItemFields;
