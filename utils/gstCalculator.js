const MAX_GST_RATE = 28;

const STATE_NAME_TO_CODE = {
  'jammu and kashmir': '01',
  'jammu & kashmir': '01',
  'himachal pradesh': '02',
  'punjab': '03',
  'chandigarh': '04',
  'uttarakhand': '05',
  'uttaranchal': '05',
  'haryana': '06',
  'delhi': '07',
  'new delhi': '07',
  'nct of delhi': '07',
  'rajasthan': '08',
  'uttar pradesh': '09',
  'bihar': '10',
  'sikkim': '11',
  'arunachal pradesh': '12',
  'nagaland': '13',
  'manipur': '14',
  'mizoram': '15',
  'tripura': '16',
  'meghalaya': '17',
  'assam': '18',
  'west bengal': '19',
  'jharkhand': '20',
  'odisha': '21',
  'orissa': '21',
  'chhattisgarh': '22',
  'madhya pradesh': '23',
  'gujarat': '24',
  'daman and diu': '25',
  'daman & diu': '25',
  'dadra and nagar haveli': '26',
  'dadra & nagar haveli': '26',
  'maharashtra': '27',
  'andhra pradesh': '37',
  'karnataka': '29',
  'goa': '30',
  'lakshadweep': '31',
  'kerala': '32',
  'tamil nadu': '33',
  'tamilnadu': '33',
  'puducherry': '34',
  'pondicherry': '34',
  'andaman and nicobar islands': '35',
  'andaman & nicobar': '35',
  'telangana': '36',
  'ladakh': '38',
  'other territory': '97',
  'centre jurisdiction': '99',
};

function normalizeStateName(value = '') {
  return String(value || '')
    .replace(/^\d{2}\s*[-)]?\s*/, '')
    .split('(')[0]
    .trim()
    .toLowerCase();
}

function extractStateCode(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';

  if (/^\d{2}$/.test(text)) return text;

  const prefixMatch = text.match(/^(\d{2})\s*[-(]/);
  if (prefixMatch) return prefixMatch[1];

  const parenMatch = text.match(/\((\d{2})\)/);
  if (parenMatch) return parenMatch[1];

  const gstinMatch = text.match(/^(\d{2})[A-Z0-9]{13}$/i);
  if (gstinMatch) return gstinMatch[1];

  return '';
}

function resolveStateCode(value = '') {
  const directCode = extractStateCode(value);
  if (directCode) return directCode;

  const normalized = normalizeStateName(value);
  if (normalized && STATE_NAME_TO_CODE[normalized]) {
    return STATE_NAME_TO_CODE[normalized];
  }

  return '';
}

function isInterStateSupply(placeOfSupply, companyState, companyGstin) {
  const supply = String(placeOfSupply || '').trim();
  if (!supply) return false;

  const supplyStateCode = resolveStateCode(supply);
  const companyStateCode = resolveStateCode(companyGstin) || resolveStateCode(companyState);

  if (supplyStateCode && companyStateCode) {
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
  const roundTwo = (value) => Math.round((Number(value) || 0) * 100) / 100;
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
    const discountPct = Math.min(100, Math.max(0, Number(item.discount) || 0));
    const exRate = Number(item.exRate) > 0 ? Number(item.exRate) : 1;
    const foreignRate = Number(item.foreignRate) || 0;
    const effectiveRate = foreignRate > 0 && exRate !== 1 ? roundTwo(foreignRate * exRate) : rate;

    const baseAmount = roundTwo(qty * effectiveRate * (1 - discountPct / 100));
    const isTaxExempt = Boolean(item.isTaxExempt) || (item.taxableAmount === 0 && Number(item.taxRate) === 0);

    const hasExplicitTaxable = item.taxableAmount !== undefined &&
      item.taxableAmount !== null &&
      String(item.taxableAmount).trim() !== '' &&
      !isNaN(Number(item.taxableAmount)) &&
      Number(item.taxableAmount) >= 0;

    const taxableValue = isTaxExempt ? 0 : (hasExplicitTaxable ? roundTwo(Number(item.taxableAmount)) : baseAmount);
    const taxRate = (hasTax && !isTaxExempt) ? sanitizeGstRate(item.taxRate) : 0;

    let cgst = 0;
    let sgst = 0;
    let igst = 0;
    let itemTax = 0;

    if (hasTax && !isTaxExempt && taxRate > 0) {
      if (isIntraState) {
        cgst = roundTwo(taxableValue * ((taxRate / 2) / 100));
        sgst = roundTwo(taxableValue * ((taxRate / 2) / 100));
        itemTax = roundTwo(cgst + sgst);
      } else {
        igst = roundTwo(taxableValue * (taxRate / 100));
        itemTax = igst;
      }
    }

    let exciseAmount = 0;
    if (hasExcise) {
      const bed = roundTwo(taxableValue * (Number(item.bedPercent) / 100 || 0));
      const sed = roundTwo(taxableValue * (Number(item.sedPercent) / 100 || 0));
      const cess = roundTwo((bed + sed) * (Number(item.cessPercent) / 100 || 0));
      exciseAmount = roundTwo(bed + sed + cess);
    }

    const total = roundTwo(baseAmount + itemTax + exciseAmount);
    subTotal = roundTwo(subTotal + baseAmount);
    taxTotal = roundTwo(taxTotal + itemTax);
    totalCGST = roundTwo(totalCGST + cgst);
    totalSGST = roundTwo(totalSGST + sgst);
    totalIGST = roundTwo(totalIGST + igst);
    totalExcise = roundTwo(totalExcise + exciseAmount);

    processedItems.push({
      itemRef: item.itemRef,
      name: item.name,
      description: item.description,
      hsnCode: item.hsnCode,
      qty,
      unit: item.unit,
      rate: effectiveRate,
      currency: item.currency || 'INR',
      exRate,
      foreignRate,
      taxableAmount: item.taxableAmount !== undefined ? Number(item.taxableAmount) : taxableValue,
      isTaxExempt,
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
  extractStateCode,
  resolveStateCode,
  normalizeStateName,
  STATE_NAME_TO_CODE,
};
