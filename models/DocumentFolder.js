const mongoose = require('mongoose');

const DocumentFolderSchema = new mongoose.Schema({
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
  name: {
    type: String,
    required: true,
    trim: true,
  },
  color: {
    type: String,
    default: 'text-indigo-500 bg-indigo-50 dark:bg-indigo-900/30',
  },
  icon: {
    type: String,
    default: 'Folder',
  },
}, { timestamps: true });

DocumentFolderSchema.index({ user: 1, profile: 1, name: 1 }, { unique: true, sparse: true });
DocumentFolderSchema.index({ user: 1, name: 1 }, { unique: true, partialFilterExpression: { profile: null } });

module.exports = mongoose.model('DocumentFolder', DocumentFolderSchema);
