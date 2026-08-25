const User = require('../models/User');
const SubscriptionOrder = require('../models/SubscriptionOrder');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const getRazorpayConfig = () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    const error = new Error('Razorpay credentials are not configured');
    error.statusCode = 500;
    throw error;
  }

  return { keyId, keySecret };
};

const createRazorpayClient = () => {
  const { keyId, keySecret } = getRazorpayConfig();
  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
};

const PLAN_PRICES = {
  pro: {
    monthly: 999 * 100,
    yearly: 9588 * 100,
  },
};

const getAmountForPlan = (plan, billingCycle) => PLAN_PRICES[plan]?.[billingCycle] || 0;

const addMonthsClamped = (date, monthsToAdd) => {
  const base = new Date(date);
  const day = base.getDate();
  const hour = base.getHours();
  const minute = base.getMinutes();
  const second = base.getSeconds();
  const ms = base.getMilliseconds();

  const targetMonthIndex = base.getMonth() + monthsToAdd;
  const year = base.getFullYear() + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(year, month + 1, 0).getDate();
  const clampedDay = Math.min(day, lastDayOfTargetMonth);

  return new Date(year, month, clampedDay, hour, minute, second, ms);
};

const addYearsClamped = (date, yearsToAdd) => addMonthsClamped(date, yearsToAdd * 12);

// @desc    Create a Razorpay order
// @route   POST /api/subscriptions/create-order
// @access  Private
exports.createOrder = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const { plan, billingCycle } = req.body;

    if (!plan || !billingCycle) {
      return res.status(400).json({ message: 'Plan and billing cycle are required' });
    }

    const amount = getAmountForPlan(plan, billingCycle);

    if (amount === 0) {
      return res.status(400).json({ message: 'Invalid plan or billing cycle' });
    }

    const options = {
      amount,
      currency: 'INR',
      receipt: `sub_${Date.now()}`,
    };

    const razorpay = createRazorpayClient();
    const order = await razorpay.orders.create(options);

    if (!order) {
      return res.status(500).json({ message: 'Error creating Razorpay order' });
    }

    await SubscriptionOrder.create({
      user: companyId,
      razorpayOrderId: order.id,
      plan,
      billingCycle,
      amount: order.amount,
      currency: order.currency,
      status: 'created',
      rawOrder: order,
    });

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
    const companyId = req.companyId || req.user._id;
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ message: 'Payment verification details are required' });
    }

    const sign = razorpay_order_id + '|' + razorpay_payment_id;
    const { keySecret } = getRazorpayConfig();
    const expectedSign = crypto
      .createHmac('sha256', keySecret)
      .update(sign.toString())
      .digest('hex');

    if (razorpay_signature !== expectedSign) {
      return res.status(400).json({ message: 'Invalid signature sent!' });
    }

    const pendingOrder = await SubscriptionOrder.findOne({
      user: companyId,
      razorpayOrderId: razorpay_order_id,
    });

    if (!pendingOrder) {
      return res.status(400).json({ message: 'Subscription order was not created by this user.' });
    }

    if (pendingOrder.status !== 'created') {
      return res.status(400).json({ message: 'Subscription order has already been processed.' });
    }

    const existingOrderPayment = await SubscriptionOrder.findOne({
      razorpayPaymentId: razorpay_payment_id,
    }).lean();
    const existingUserPayment = await User.exists({
      'paymentHistory.razorpayPaymentId': razorpay_payment_id,
    });

    if (existingOrderPayment || existingUserPayment) {
      return res.status(400).json({ message: 'This payment has already been used.' });
    }

    const razorpay = createRazorpayClient();
    const order = await razorpay.orders.fetch(razorpay_order_id);
    const payment = await razorpay.payments.fetch(razorpay_payment_id);

    if (
      order?.id !== pendingOrder.razorpayOrderId ||
      order?.amount !== pendingOrder.amount ||
      order?.currency !== pendingOrder.currency
    ) {
      return res.status(400).json({ message: 'Subscription order details do not match.' });
    }

    if (
      payment?.order_id !== pendingOrder.razorpayOrderId ||
      payment?.amount !== pendingOrder.amount ||
      payment?.currency !== pendingOrder.currency ||
      !['captured', 'authorized'].includes(payment?.status)
    ) {
      return res.status(400).json({ message: 'Payment details do not match the subscription order.' });
    }

    const startDate = new Date();
    const endDate = pendingOrder.billingCycle === 'monthly'
      ? addMonthsClamped(startDate, 1)
      : addYearsClamped(startDate, 1);

    const user = await User.findById(companyId);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.subscription = {
      plan: pendingOrder.plan,
      status: 'active',
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      razorpaySignature: razorpay_signature,
      startDate,
      endDate,
      billingCycle: pendingOrder.billingCycle,
    };

    user.paymentHistory.push({
      amount: pendingOrder.amount / 100,
      plan: pendingOrder.plan,
      billingCycle: pendingOrder.billingCycle,
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      endDate,
    });

    const updatedOrder = await SubscriptionOrder.findOneAndUpdate(
      { _id: pendingOrder._id, status: 'created' },
      {
        status: 'paid',
        razorpayPaymentId: razorpay_payment_id,
        rawOrder: order,
        rawPayment: payment,
        paidAt: startDate,
      },
      { returnDocument: 'after' }
    );

    if (!updatedOrder) {
      return res.status(400).json({ message: 'Subscription order has already been processed.' });
    }

    await user.save();

    return res.status(200).json({ message: 'Payment verified successfully', user });
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
    const companyId = req.companyId || req.user._id;
    const user = await User.findById(companyId).select('subscription role');
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.status(200).json({
      subscription: user.subscription,
      role: user.role,
    });
  } catch (error) {
    console.error('Fetch Subscription Error:', error);
    res.status(500).json({ message: 'Server error while fetching subscription', error: error.message });
  }
};

// @desc    Get subscription payment history
// @route   GET /api/subscriptions/history
// @access  Private
exports.getPaymentHistory = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const user = await User.findById(companyId).select('paymentHistory').lean();
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Sort history descending by date natively in JS since it's an embedded array
    let history = user.paymentHistory || [];

    // Backward compatibility for older Pro purchases saved before paymentHistory existed.
    if (history.length === 0) {
      const fullUser = await User.findById(companyId).select('subscription').lean();
      if (fullUser && fullUser.subscription && fullUser.subscription.plan === 'pro' && fullUser.subscription.razorpayPaymentId) {
        const sub = fullUser.subscription;
        let amountPaid = 0;
        if (sub.billingCycle === 'monthly') amountPaid = 999;
        else if (sub.billingCycle === 'yearly') amountPaid = 9588;

        history = [{
          _id: fullUser._id,
          date: sub.startDate || new Date(),
          endDate: sub.endDate,
          amount: amountPaid,
          plan: sub.plan,
          billingCycle: sub.billingCycle,
          razorpayOrderId: sub.razorpayOrderId,
          razorpayPaymentId: sub.razorpayPaymentId,
        }];
      }
    }

    history.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.status(200).json(history);
  } catch (error) {
    console.error('Fetch Payment History Error:', error);
    res.status(500).json({ message: 'Server error while fetching payment history', error: error.message });
  }
};

// @desc    Get quota usage stats
// @route   GET /api/subscriptions/usage
// @access  Private
exports.getUsageStats = async (req, res) => {
  try {
    const companyId = req.companyId || req.user._id;
    const Invoice = require('../models/Invoice');
    const Quote = require('../models/Quote');
    const PurchaseOrder = require('../models/PurchaseOrder');
    const Proforma = require('../models/Proforma');

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const invoicesCount = await Invoice.countDocuments({
      user: companyId,
      createdAt: { $gte: startOfMonth },
    });

    const quotesCount = await Quote.countDocuments({
      user: companyId,
      createdAt: { $gte: startOfMonth },
    });

    const purchaseOrdersCount = await PurchaseOrder.countDocuments({
      user: companyId,
      createdAt: { $gte: startOfMonth },
    });

    const editedInvoicesCount = await Invoice.countDocuments({
      user: companyId,
      updatedAt: { $gte: startOfMonth },
      $expr: { $gt: ['$updatedAt', '$createdAt'] },
    });

    const editedQuotesCount = await Quote.countDocuments({
      user: companyId,
      updatedAt: { $gte: startOfMonth },
      $expr: { $gt: ['$updatedAt', '$createdAt'] },
    });

    const editedPurchaseOrdersCount = await PurchaseOrder.countDocuments({
      user: companyId,
      updatedAt: { $gte: startOfMonth },
      $expr: { $gt: ['$updatedAt', '$createdAt'] },
    });

    const proformasCount = await Proforma.countDocuments({
      user: companyId,
      createdAt: { $gte: startOfMonth },
    });

    const editedProformasCount = await Proforma.countDocuments({
      user: companyId,
      updatedAt: { $gte: startOfMonth },
      $expr: { $gt: ['$updatedAt', '$createdAt'] },
    });

    res.json({
      invoices: { used: invoicesCount, limit: 15 },
      quotes: { used: quotesCount + proformasCount, limit: 15 },
      purchaseOrders: { used: purchaseOrdersCount, limit: 15 },
      edits: { used: editedInvoicesCount + editedQuotesCount + editedPurchaseOrdersCount + editedProformasCount, limit: 5 },
    });
  } catch (error) {
    console.error('Error fetching usage stats:', error);
    res.status(500).json({ message: 'Internal server error while fetching usage.' });
  }
};
