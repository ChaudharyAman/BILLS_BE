const mongoose = require('mongoose');

const ProjectSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, trim: true, uppercase: true },
  description: { type: String, default: '' },
  client: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', default: null },
  startDate: Date,
  endDate: Date,
  budget: { type: Number, default: 0, min: 0 },
  status: {
    type: String,
    enum: ['active', 'completed', 'on-hold', 'cancelled'],
    default: 'active',
    index: true,
  },
  team: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }],
}, { timestamps: true });

ProjectSchema.index({ user: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('Project', ProjectSchema);
