const mongoose = require('mongoose');

// ── File sub-document ────────────────────────────────────────────────────────
// The buffer field stores the raw file bytes in MongoDB.
// This avoids any external storage dependency.
// Per-file cap: 10 MB (enforced in documentUpload middleware).
// Max files per submission: 5 (enforced in the route).
const SubmissionFileSchema = new mongoose.Schema({
  originalName: { type: String, required: true },
  mimeType:     { type: String, required: true },
  sizeBytes:    { type: Number, required: true },
  buffer:       { type: Buffer, required: true },
  uploadedAt:   { type: Date,   default: Date.now },
}, { _id: false });

// ── Main schema ──────────────────────────────────────────────────────────────
const PublicSubmissionSchema = new mongoose.Schema({
  // The business owner who will review this submission.
  // Populated from Settings.user via the public token lookup.
  // Never exposed in public API responses.
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },

  // ── Submitter identity (all optional — unauthenticated external party) ──
  submitterName:  { type: String, default: '' },
  submitterEmail: { type: String, default: '' },
  submitterPhone: { type: String, default: '' },
  submitterNote:  { type: String, default: '' },

  // ── Uploaded files ──────────────────────────────────────────────────────
  files: [SubmissionFileSchema],

  // ── Parsing output ──────────────────────────────────────────────────────
  // Shape is identical to what parseInvoice() / nvidiaInvoiceParser return.
  // This lets the review UI reuse InvoiceForm / ExpenseForm field components.
  parsedData: { type: mongoose.Schema.Types.Mixed, default: {} },

  // ── Category classification ─────────────────────────────────────────────
  // Best-effort guess set at submission time. Reviewer always confirms.
  suggestedCategory: {
    type: String,
    enum: ['invoice', 'expense', 'income', 'purchaseorder', 'unknown'],
    default: 'unknown',
  },

  // ── Review lifecycle ────────────────────────────────────────────────────
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'needs-changes'],
    default: 'pending',
    index: true,
  },

  // Internal note visible only to the business owner (never shown to submitter)
  reviewerNote: { type: String, default: '' },

  // Set when the reviewer takes an action
  decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decidedAt: { type: Date, default: null },

  // Permanent audit trail: which real record was created on approval
  resultingRecord: {
    collection: { type: String, default: null }, // e.g. 'expenses', 'invoices'
    recordId:   { type: mongoose.Schema.Types.ObjectId, default: null },
  },

  // ── Abuse / moderation ──────────────────────────────────────────────────
  // Stored for internal investigation only — never returned in any API response.
  ipAddress: { type: String, default: '' },

}, { timestamps: true }); // createdAt + updatedAt

// ── Indexes ──────────────────────────────────────────────────────────────────
// Primary review-dashboard query: "all pending submissions for this user, newest first"
PublicSubmissionSchema.index({ user: 1, status: 1, createdAt: -1 });

// ── Virtual: human-readable reference number ─────────────────────────────────
// Derived from the last 8 hex chars of the ObjectId.
// e.g. SUB-3F7A21BC  — shown to the submitter in the success response.
PublicSubmissionSchema.virtual('referenceNumber').get(function () {
  return `SUB-${this._id.toString().slice(-8).toUpperCase()}`;
});

module.exports = mongoose.model('PublicSubmission', PublicSubmissionSchema);
