const parseDateParam = (value, label, endOfDay = false) => {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${label}`);
  }

  if (endOfDay) {
    parsed.setHours(23, 59, 59, 999);
  } else {
    parsed.setHours(0, 0, 0, 0);
  }

  return parsed;
};

const parseOptionalDateRange = (query = {}) => ({
  startDate: query.startDate ? parseDateParam(query.startDate, 'startDate') : null,
  endDate: query.endDate ? parseDateParam(query.endDate, 'endDate', true) : null,
});

const parseMonthlyDateRange = (query = {}) => {
  const now = new Date();
  const defaultStartDate = new Date(now.getFullYear(), now.getMonth(), 1);
  const defaultEndDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  return {
    startDate: query.startDate ? parseDateParam(query.startDate, 'startDate') : defaultStartDate,
    endDate: query.endDate ? parseDateParam(query.endDate, 'endDate', true) : defaultEndDate,
  };
};

module.exports = {
  parseOptionalDateRange,
  parseMonthlyDateRange,
};
