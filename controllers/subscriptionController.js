const mongoose = require('mongoose');
const User = require('../models/User');
const Razorpay = require('razorpay');
const crypto = require('crypto');

// Initialize Razorpay instance
// Note: In a real app, you'd want to handle the case where keys are missing more gracefully
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'dummy_key_id',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummy_key_secret',
});

// @desc    Create a Razorpay order
// @route   POST /api/subscriptions/create-order
// @access  Private
exports.createOrder = async (req, res) => {
  try {
    const { plan, billingCycle } = req.body; // plan: 'pro', billingCycle: 'monthly'|'yearly'

    if (!plan || !billingCycle) {
      return res.status(400).json({ message: 'Plan and billing cycle are required' });
    }

    // Define pricing logic (amounts in paise for INR)
    let amount = 0;
    if (plan === 'pro') {
      if (billingCycle === 'monthly') {
        amount = 999 * 100; // ₹999
      } else if (billingCycle === 'yearly') {
        amount = 9588 * 100; // ₹799 * 12
      }
    }

    if (amount === 0) {
      return res.status(400).json({ message: 'Invalid plan or billing cycle' });
    }

    const options = {
      amount,
      currency: 'INR',
      receipt: `receipt_order_${Date.now()}`,
    };

    const order = await razorpay.orders.create(options);

    if (!order) {
      return res.status(500).json({ message: 'Error creating Razorpay order' });
    }

    res.status(200).json(order);
  } catch (error) {
    console.error('Create Order Error:', error);
    res.status(500).json({ message: 'Server error while creating order', error: error.message });
  }
};

// @desc    Verify Razorpay payment
// @route   POST /api/subscriptions/verify
// @access  Private
exports.verifyPayment = async (req, res) => {
  try {
    const { 
      razorpay_order_id, 
      razorpay_payment_id, 
      razorpay_signature,
      plan,
      billingCycle
    } = req.body;

    // The logic to verify the signature
    const sign = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSign = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'dummy_key_secret')
      .update(sign.toString())
      .digest('hex');

    if (razorpay_signature === expectedSign) {
      // Payment is verified
      
      // Calculate subscription end date
      const startDate = new Date();
      const endDate = new Date();
      if (billingCycle === 'monthly') {
        endDate.setMonth(endDate.getMonth() + 1);
      } else if (billingCycle === 'yearly') {
        endDate.setFullYear(endDate.getFullYear() + 1);
      }

      // Update user in DB
      const user = await User.findById(req.user._id);
      
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      user.subscription = {
        plan: plan,
        status: 'active',
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
        startDate: startDate,
        endDate: endDate,
        billingCycle: billingCycle
      };

      await user.save();

      return res.status(200).json({ message: 'Payment verified successfully', user });
    } else {
      return res.status(400).json({ message: 'Invalid signature sent!' });
    }
  } catch (error) {
    console.error('Payment Verification Error:', error);
    return res.status(500).json({ message: 'Server error during payment verification', error: error.message });
  }
};

// @desc    Get current subscription status
// @route   GET /api/subscriptions/status
// @access  Private
exports.getSubscriptionStatus = async (req, res) => {
  try {
     const user = await User.findById(req.user._id).select('subscription');
     if (!user) {
         return res.status(404).json({ message: 'User not found' });
     }
     res.status(200).json(user.subscription);
  } catch (error) {
     console.error('Fetch Subscription Error:', error);
     res.status(500).json({ message: 'Server error while fetching subscription', error: error.message });
  }
};

// @desc    Get quota usage stats
// @route   GET /api/subscriptions/usage
// @access  Private
exports.getUsageStats = async (req, res) => {
  try {
    const Invoice = require('../models/Invoice');
    const Quote = require('../models/Quote');
    const PurchaseOrder = require('../models/PurchaseOrder');

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const invoicesCount = await Invoice.countDocuments({
      user: req.user._id,
      createdAt: { $gte: startOfMonth }
    });

    const quotesCount = await Quote.countDocuments({
      user: req.user._id,
      createdAt: { $gte: startOfMonth }
    });

    const purchaseOrdersCount = await PurchaseOrder.countDocuments({
      user: req.user._id,
      createdAt: { $gte: startOfMonth }
    });

    const editedInvoicesCount = await Invoice.countDocuments({
      user: req.user._id,
      updatedAt: { $gte: startOfMonth },
      $expr: { $gt: ["$updatedAt", "$createdAt"] }
    });

    const editedQuotesCount = await Quote.countDocuments({
      user: req.user._id,
      updatedAt: { $gte: startOfMonth },
      $expr: { $gt: ["$updatedAt", "$createdAt"] }
    });

    const editedPurchaseOrdersCount = await PurchaseOrder.countDocuments({
      user: req.user._id,
      updatedAt: { $gte: startOfMonth },
      $expr: { $gt: ["$updatedAt", "$createdAt"] }
    });

    res.json({
      invoices: { used: invoicesCount, limit: 15 },
      quotes: { used: quotesCount, limit: 15 }, // Quotes model includes Proformas
      purchaseOrders: { used: purchaseOrdersCount, limit: 15 },
      edits: { used: editedInvoicesCount + editedQuotesCount + editedPurchaseOrdersCount, limit: 5 }
    });
  } catch (error) {
    console.error('Error fetching usage stats:', error);
    res.status(500).json({ message: 'Internal server error while fetching usage.' });
  }
};
