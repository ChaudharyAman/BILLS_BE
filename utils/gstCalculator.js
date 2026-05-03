const MAX_GST_RATE = 28;

function extractStateCode(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';

  const prefixMatch = text.match(/^(\d{2})\s*[-(]/);
  if (prefixMatch) return prefixMatch[1];

  const parenMatch = text.match(/\((\d{2})\)/);
  if (parenMatch) return parenMatch[1];

  return '';
}

function normalizeStateName(value = '') {
  return String(value || '')
    .replace(/^\d{2}\s*[-)]?\s*/, '')
    .split('(')[0]
    .trim()
    .toLowerCase();
}

function isInterStateSupply(placeOfSupply, companyState, companyGstin) {
  const supply = String(placeOfSupply || '').trim();
  if (!supply) return false;

  const supplyStateCode = extractStateCode(supply);
  const companyStateCode = String(companyGstin || '').trim().slice(0, 2);

  if (supplyStateCode && /^\d{2}$/.test(companyStateCode)) {
    return supplyStateCode !== companyStateCode;
  }

  const normalizedSupply = normalizeStateName(supply);
  const normalizedCompanyState = normalizeStateName(companyState);

  if (normalizedSupply && normalizedCompanyState) {
    return normalizedSupply !== normalizedCompanyState;
  }

  return false;
}

function sanitizeGstRate(value = '') {
  const numeric = Number.parseFloat(String(value ?? '').replace('%', '').trim());
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > MAX_GST_RATE) {
    return 0;
  }
  return numeric;
}

function processDocumentItems(items = [], { invoiceType = 'Tax Invoice', isIntraState = true, includeExcise = false } = {}) {
  const hasTax = invoiceType === 'Tax Invoice' || invoiceType === 'Excise Invoice';
  const hasExcise = includeExcise && invoiceType === 'Excise Invoice';

  let subTotal = 0;
  let taxTotal = 0;
  let totalCGST = 0;
  let totalSGST = 0;
  let totalIGST = 0;
  let totalExcise = 0;
  const processedItems = [];

  for (const item of items) {
    const qty = Number(item.qty) || 0;
    const rate = Number(item.rate) || 0;
    const discountPct = Number(item.discount) || 0;
    const taxableValue = qty * rate * (1 - discountPct / 100);
    const taxRate = hasTax ? sanitizeGstRate(item.taxRate) : 0;

    let cgst = 0;
    let sgst = 0;
    let igst = 0;
    const itemTax = taxableValue * (taxRate / 100);

    if (hasTax) {
      if (isIntraState) {
        cgst = itemTax / 2;
        sgst = itemTax / 2;
      } else {
        igst = itemTax;
      }
    }

    let exciseAmount = 0;
    if (hasExcise) {
      const bed = taxableValue * (Number(item.bedPercent) / 100 || 0);
      const sed = taxableValue * (Number(item.sedPercent) / 100 || 0);
      const cess = (bed + sed) * (Number(item.cessPercent) / 100 || 0);
      exciseAmount = bed + sed + cess;
    }

    const total = taxableValue + itemTax + exciseAmount;
    subTotal += taxableValue;
    taxTotal += itemTax;
    totalCGST += cgst;
    totalSGST += sgst;
    totalIGST += igst;
    totalExcise += exciseAmount;

    processedItems.push({
      itemRef: item.itemRef,
      name: item.name,
      description: item.description,
      hsnCode: item.hsnCode,
      qty,
      unit: item.unit,
      rate,
      discount: discountPct,
      taxRate,
      taxAmount: itemTax,
      cgst,
      sgst,
      igst,
      bedPercent: Number(item.bedPercent) || 0,
      sedPercent: Number(item.sedPercent) || 0,
      cessPercent: Number(item.cessPercent) || 0,
      exciseAmount,
      amount: total,
    });
  }

  return { processedItems, subTotal, taxTotal, totalCGST, totalSGST, totalIGST, totalExcise };
}

module.exports = {
  isInterStateSupply,
  processDocumentItems,
  sanitizeGstRate,
};
