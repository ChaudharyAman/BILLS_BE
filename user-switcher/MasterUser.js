const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

/**
 * Isolated MasterUser Model
 * 
 * Stored in its own collection ('masterusers') so that the primary 'User' model
 * contains only regular users and admins.
 * 
 * If the user-switcher folder is deleted, this model and its code are completely gone.
 */
const masterUserSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
  },
  password: {
    type: String,
    required: true,
    minlength: [8, 'Master user password must be at least 8 characters long'],
  },
  phone: {
    type: String,
    trim: true,
    default: '',
  },
  avatar: {
    type: String,
    default: '',
  },
  role: {
    type: String,
    default: 'superadmin',
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  isMasterUser: {
    type: Boolean,
    default: true,
  },
  subscription: {
    plan: {
      type: String,
      default: 'pro',
    },
    status: {
      type: String,
      default: 'active',
    },
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Hash password before saving if modified
masterUserSchema.pre('save', async function() {
  if (!this.isModified('password')) {
    return;
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Method to verify password against bcrypt hash
masterUserSchema.methods.matchPassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.models.MasterUser || mongoose.model('MasterUser', masterUserSchema);
