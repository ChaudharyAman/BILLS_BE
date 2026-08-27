const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please fill a valid email address']
  },
  password: {
    type: String,
    required: true
  },
  phone: {
    type: String,
    trim: true,
    default: ''
  },
  avatar: {
    type: String,
    default: ''
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  subscription: {
    plan: {
      type: String,
      enum: ['free', 'pro'],
      default: 'free'
    },
    status: {
      type: String,
      enum: ['active', 'inactive', 'past_due', 'canceled', 'unpaid'],
      default: 'active'
    },
    razorpayOrderId: String,
    razorpayPaymentId: String,
    razorpaySignature: String,
    startDate: Date,
    endDate: Date,
    billingCycle: {
      type: String, // 'monthly' or 'yearly'
      enum: ['monthly', 'yearly']
    }
  },
  paymentHistory: [{
    date: { type: Date, default: Date.now },
    endDate: { type: Date },
    amount: { type: Number, required: true },
    plan: { type: String, required: true },
    billingCycle: { type: String, required: true },
    razorpayOrderId: { type: String, required: true },
    razorpayPaymentId: { type: String, required: true }
  }],
  role: {
    type: String,
    enum: ['user', 'superadmin'],
    default: 'user'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  // ── Team Members & RBAC Tenancy ──────────────────────────────────────────
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  isOwner: {
    type: Boolean,
    default: true
  },
  accessRole: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AccessRole',
    default: null
  },
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  status: {
    type: String,
    enum: ['active', 'invited', 'suspended'],
    default: 'active'
  },
  inviteToken: {
    type: String,
    default: null
  },
  inviteTokenExpires: {
    type: Date,
    default: null
  }
});

// Hash password before saving
userSchema.pre('save', async function() {
  if (!this.isModified('password')) {
    return;
  }
  
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Method to check password
userSchema.methods.matchPassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
