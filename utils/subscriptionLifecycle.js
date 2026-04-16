const hasValidDate = (value) => {
  if (!value) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
};

const isProExpired = (subscription, now = new Date()) => {
  if (!subscription) return false;
  if (subscription.plan !== 'pro') return false;
  if (!hasValidDate(subscription.endDate)) return false;

  const end = new Date(subscription.endDate);
  return end.getTime() <= now.getTime();
};

const downgradeToFree = (user) => {
  user.subscription = {
    plan: 'free',
    status: 'active',
    razorpayOrderId: undefined,
    razorpayPaymentId: undefined,
    razorpaySignature: undefined,
    startDate: undefined,
    endDate: undefined,
    billingCycle: undefined,
  };
};

const syncExpiredSubscription = async (user, now = new Date()) => {
  if (!user) return { updated: false };
  if (!isProExpired(user.subscription, now)) return { updated: false };

  downgradeToFree(user);
  await user.save();

  return { updated: true };
};

module.exports = {
  isProExpired,
  syncExpiredSubscription,
};
