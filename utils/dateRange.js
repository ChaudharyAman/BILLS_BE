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

const parseImportedDate = (val) => {
  if (!val) return new Date();
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return new Date();
    return val;
  }
  
  if (typeof val === 'number') {
    // Excel date serial number
    const date = new Date((val - 25569) * 86400 * 1000);
    if (!isNaN(date.getTime())) return date;
    return new Date();
  }

  const str = String(val).trim();
  if (!str) return new Date();

  // Try parsing ISO format or standard formats
  let date = new Date(str);
  if (!isNaN(date.getTime())) return date;

  // Handle DD/MM/YYYY or DD-MM-YYYY format
  const dmyMatch = str.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10) - 1; // 0-indexed month
    const year = parseInt(dmyMatch[3], 10);
    date = new Date(year, month, day);
    if (!isNaN(date.getTime())) return date;
  }

  // Handle YYYY/MM/DD or YYYY-MM-DD format
  const ymdMatch = str.match(/^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})$/);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const month = parseInt(ymdMatch[2], 10) - 1;
    const day = parseInt(ymdMatch[3], 10);
    date = new Date(year, month, day);
    if (!isNaN(date.getTime())) return date;
  }

  return new Date();
};

module.exports = {
  parseOptionalDateRange,
  parseMonthlyDateRange,
  parseImportedDate,
};
