/**
 * Helper to delete a dotted path from an object, supporting wildcard '*' segments.
 * e.g. path 'employees.*.monthlyCTC' or 'settings.bankDetails' or 'gstin'
 */
function removeDottedPath(target, pathSegments) {
  if (!target || typeof target !== 'object') return;

  if (Array.isArray(target)) {
    for (const item of target) {
      removeDottedPath(item, pathSegments);
    }
    return;
  }

  const [current, ...rest] = pathSegments;

  if (current === '*') {
    for (const key of Object.keys(target)) {
      removeDottedPath(target[key], rest);
    }
    return;
  }

  if (rest.length === 0) {
    delete target[current];
  } else if (target[current] && typeof target[current] === 'object') {
    removeDottedPath(target[current], rest);
  }
}

function removeFieldRecursively(target, fieldName) {
  if (!target || typeof target !== 'object') return;
  if (Array.isArray(target)) {
    for (const item of target) removeFieldRecursively(item, fieldName);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(target, fieldName)) {
    delete target[fieldName];
  }
  for (const key of Object.keys(target)) {
    if (target[key] && typeof target[key] === 'object') {
      removeFieldRecursively(target[key], fieldName);
    }
  }
}

function removeField(target, fieldPath) {
  if (!target || typeof target !== 'object' || !fieldPath) return;
  if (fieldPath.includes('.')) {
    const segments = fieldPath.split('.');
    removeDottedPath(target, segments);
    if (target.data) {
      removeDottedPath(target.data, segments);
    }
  } else {
    removeFieldRecursively(target, fieldPath);
  }
}

/**
 * Filter an array of items based on dateRange (from, to).
 * Checks fields like 'date', 'invoiceDate', 'paymentDate', 'createdAt'.
 */
function filterByDateRange(items, from, to) {
  if (!Array.isArray(items)) return items;
  const fromTime = from ? new Date(from).getTime() : null;
  const toTime = to ? new Date(to).getTime() : null;

  if (!fromTime && !toTime) return items;

  return items.filter((item) => {
    if (!item || typeof item !== 'object') return true;
    const rawDate = item.date || item.invoiceDate || item.paymentDate || item.createdAt;
    if (!rawDate) return true;

    const itemTime = new Date(rawDate).getTime();
    if (!Number.isFinite(itemTime)) return true;

    if (fromTime && itemTime < fromTime) return false;
    if (toTime && itemTime > toTime) return false;
    return true;
  });
}

/**
 * Middleware that intercepts res.json for view-only share sessions to redact hidden fields,
 * enforce date ranges, and inject the watermark header.
 */
const shareRuleFilter = (req, res, next) => {
  if (!req.isSharedViewOnly || !req.shareRules) {
    return next();
  }

  // Inject watermark header if configured
  if (req.shareRules.watermarkLabel) {
    res.setHeader('X-Share-Watermark', req.shareRules.watermarkLabel);
  }

  const originalJson = res.json.bind(res);

  res.json = function (body) {
    try {
      if (body && typeof body === 'object') {
        // Deep clone or sanitize plain object
        let data = JSON.parse(JSON.stringify(body));

        // 1. Redact hidden fields
        const hiddenFields = Array.isArray(req.shareRules.hiddenFields) ? req.shareRules.hiddenFields : [];
        for (const fieldPath of hiddenFields) {
          if (fieldPath && typeof fieldPath === 'string') {
            removeField(data, fieldPath);
          }
        }

        // 2. Filter date ranges if present
        const { from, to } = req.shareRules.dateRange || {};
        if (from || to) {
          if (Array.isArray(data)) {
            data = filterByDateRange(data, from, to);
          } else if (data && Array.isArray(data.data)) {
            data.data = filterByDateRange(data.data, from, to);
            if (typeof data.total === 'number') {
              data.total = data.data.length;
            }
          }
        }

        return originalJson(data);
      }
    } catch (err) {
      console.error('shareRuleFilter error:', err);
    }

    return originalJson(body);
  };

  next();
};

module.exports = {
  shareRuleFilter,
  removeDottedPath,
  filterByDateRange,
};
