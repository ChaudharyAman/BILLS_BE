const mongoose = require('mongoose');
const softDeletePlugin = require('../middleware/softDeletePlugin');

const CompanyDocumentSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  profile: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ClientProfile',
    required: false,
    index: true,
  },
  title: {
    type: String,
    required: true,
    trim: true,
  },
  category: {
    type: String,
    required: true,
    default: 'General Documents',
    trim: true,
  },
  originalName: {
    type: String,
    required: true,
  },
  mimeType: {
    type: String,
    required: true,
    default: 'application/octet-stream',
  },
  sizeBytes: {
    type: Number,
    required: true,
    default: 0,
  },
  buffer: {
    type: Buffer,
    required: true,
  },
  notes: {
    type: String,
    default: '',
    trim: true,
  },
  referenceNumber: {
    type: String,
    default: '',
    trim: true,
  },
  expiryDate: {
    type: Date,
    required: false,
  },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, { timestamps: true });

CompanyDocumentSchema.index({ user: 1, profile: 1, category: 1 });
CompanyDocumentSchema.index({ user: 1, title: 'text', originalName: 'text', notes: 'text' });

CompanyDocumentSchema.plugin(softDeletePlugin);

module.exports = mongoose.model('CompanyDocument', CompanyDocumentSchema);
