/**
 * Invoice Parser - Advanced PDF Text Extraction Engine
 * Implements a 9-step hybrid parsing pipeline:
 *   1. Text Preprocessing
 *   2. Section Boundary Detection
 *   3. Field Extraction
 *   4. Item Table Extraction
 *   5. Data Validation
 *   6. Confidence Scoring
 *   7. Status Determination
 *   8. Output Formatting
 *   9. Error Handling
 */

const BUYER_LABEL_PATTERNS = [
  /^buyer(?:\s*:)?$/i,
  /^bill\s*to(?:\s*:)?$/i,
  /^billed\s*to(?:\s*:)?$/i,
  /^customer(?:\s*:)?$/i,
];

function preprocessText(rawText) {
  let text = String(rawText || '');

  text = text.replace(/Page\s+\d+\s+(of|\/)\s+\d+/gi, '');
  text = text.replace(/\b(COPY|DUPLICATE|ORIGINAL)\b/gi, '');
  text = text.replace(/--\s*\d+\s+of\s+\d+\s*--/gi, '');

  text = text.replace(/Rs\.?\s*/gi, 'Rs ');
  text = text.replace(/INR\s*/gi, 'Rs ');
  text = text.replace(/R\s+s\s+/gi, 'Rs ');
  text = text.replace(/₹\s*/g, 'Rs ');
  text = text.replace(/â‚¹\s*/g, 'Rs ');
  text = text.replace(/ī\s*(?=\d)/g, 'Rs ');

  text = text.replace(/[\u2018\u2019]/g, "'");
  text = text.replace(/[\u201C\u201D]/g, '"');

  const lines = text.split('\n').map((line, index) => ({
    num: index + 1,
    text: line.replace(/\r/g, '').replace(/\s+/g, ' ').trim(),
  }));

  return lines.filter(line => line.text.length > 0);
}

function parseAmount(value) {
  if (value === null || value === undefined) return null;
  const parsed = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function sanitizeInvoiceNumber(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').replace(/[.,:]+$/, '');
}

function isLikelyMetadataLine(text) {
  return /^(GST|GSTIN|UIN|PAN|State Name|State|Place of Supply|Contact|Phone|Mobile|E-Mail|Email|Invoice No|Challan No|Supplier'?s Ref|Order No|Dated|Despatch|Dispatch|Destination|Terms of Delivery)/i.test(text);
}

function findLineIndex(lines, patterns) {
  return lines.findIndex(line => patterns.some(pattern => pattern.test(line.text)));
}

function findFirstMatchingValue(lines, patterns) {
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.text.match(pattern);
      if (match && match[1]) return match[1].trim();
    }
  }
  return null;
}

function detectSections(lines) {
  const sections = {
    headerSection: null,
    billingSection: null,
    itemsSection: null,
    totalsSection: null,
  };

  let sectionsMissing = 0;

  const headerKeywords = /invoice|tax invoice|bill|invoice no|date/i;
  const headerStart = lines.findIndex(line => headerKeywords.test(line.text));
  if (headerStart !== -1) {
    const billingKeyword = /bill\s*to|billed\s*to|customer(?:\s*:)?|buyer(?:\s*:)?|consignee(?:\s*:)?/i;
    let headerEnd = lines.findIndex((line, index) => index > headerStart && billingKeyword.test(line.text));
    if (headerEnd === -1) headerEnd = Math.min(headerStart + 20, lines.length - 1);
    sections.headerSection = { start: headerStart, end: headerEnd };
  } else {
    sections.headerSection = { start: 0, end: Math.min(20, lines.length - 1) };
    sectionsMissing++;
  }

  const billingKeyword = /bill\s*to|billed\s*to|customer(?:\s*:)?|buyer(?:\s*:)?|consignee(?:\s*:)?/i;
  const billingStart = lines.findIndex(line => billingKeyword.test(line.text));
  if (billingStart !== -1) {
    const tableHeaderPattern = /(?=.*(?:s\.?\s*no|sr\.?\s*no|item|description|particular|goods))(?=.*(?:qty|quantity|qnty|rate|price|amount))/i;
    let billingEnd = lines.findIndex((line, index) => index > billingStart && tableHeaderPattern.test(line.text));
    if (billingEnd === -1) billingEnd = Math.min(billingStart + 15, lines.length - 1);
    sections.billingSection = { start: billingStart, end: billingEnd };
  } else {
    sectionsMissing++;
  }

  const itemsHeaderPattern = /(?=.*(?:s\.?\s*no|sr\.?\s*no|description|particular|goods|product))(?=.*(?:qty|quantity|qnty|rate|price|amount))/i;
  const itemsStart = lines.findIndex(line => itemsHeaderPattern.test(line.text));
  if (itemsStart !== -1) {
    const totalsPattern = /(?:sub\s*total|total\s*amount|taxable\s*amount|grand\s*total|net\s*amount|amount\s*payable|amount\s*chargeable|^igst\b|^cgst\b|^sgst\b|^round\s*off\b|^total\b|^bill\s+details\b|continued\s+to\s+page)/i;
    let itemsEnd = lines.findIndex((line, index) => index > itemsStart + 1 && totalsPattern.test(line.text));
    if (itemsEnd === -1) itemsEnd = Math.min(itemsStart + 60, lines.length - 1);
    sections.itemsSection = { start: itemsStart, end: itemsEnd };
  } else {
    sections.itemsSection = { start: Math.floor(lines.length * 0.3), end: Math.floor(lines.length * 0.7) };
    sectionsMissing++;
  }

  const totalsPattern = /(?:sub\s*total|total\s*amount|taxable\s*amount|grand\s*total|net\s*amount|amount\s*payable|amount\s*chargeable|^igst\b|^cgst\b|^sgst\b|^round\s*off\b|^total\b)/i;
  const totalsStart = lines.findIndex((line, index) => {
    if (sections.itemsSection && index <= sections.itemsSection.start) return false;
    return totalsPattern.test(line.text);
  });
  if (totalsStart !== -1) {
    let totalsEnd = lines.length - 1;
    for (let i = totalsStart; i < lines.length; i++) {
      if (/(?:grand\s*total|amount\s*payable|net\s*amount|balance\s*due|total\s+inv\s+amt|current\s+balance)/i.test(lines[i].text)) {
        totalsEnd = i;
      }
    }
    sections.totalsSection = { start: totalsStart, end: totalsEnd };
  } else {
    sections.totalsSection = { start: Math.floor(lines.length * 0.8), end: lines.length - 1 };
    sectionsMissing++;
  }

  return { sections, sectionsMissing };
}

function normalizeDate(raw, monthMap) {
  let match = raw.match(/^(\d{4})[-/.](\d{2})[-/.](\d{2})$/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;

  match = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;

  match = raw.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/);
  if (match) {
    const year = parseInt(match[3], 10) > 50 ? `19${match[3]}` : `20${match[3]}`;
    return `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  }

  match = raw.match(/^(\d{1,2})[-/.]([A-Za-z]+)[-/.](\d{2,4})$/);
  if (match) {
    const month = monthMap[match[2].toLowerCase()];
    if (month) {
      const year = match[3].length === 2
        ? (parseInt(match[3], 10) > 50 ? `19${match[3]}` : `20${match[3]}`)
        : match[3];
      return `${year}-${month}-${match[1].padStart(2, '0')}`;
    }
  }

  match = raw.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (match) {
    const month = monthMap[match[2].toLowerCase()];
    if (month) return `${match[3]}-${month}-${match[1].padStart(2, '0')}`;
  }

  match = raw.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (match) {
    const month = monthMap[match[1].toLowerCase()];
    if (month) return `${match[3]}-${month}-${match[2].padStart(2, '0')}`;
  }

  return null;
}

function isValidDate(dateStr) {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return false;
  const minDate = new Date('2000-01-01');
  const maxDate = new Date();
  maxDate.setFullYear(maxDate.getFullYear() + 1);
  return date >= minDate && date <= maxDate;
}

function extractInvoiceNumber(lines, section) {
  for (let i = 0; i < lines.length; i++) {
    if (!/invoice\s+no/i.test(lines[i].text)) continue;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const match = lines[j].text.match(/\b([A-Z0-9]+(?:\/[A-Z0-9-]+){1,})\b/);
      if (match && match[1]) return sanitizeInvoiceNumber(match[1]);
    }
  }

  const patterns = [
    /Invoice\s+No\.?\s*:?\s*([A-Z0-9/_#-]+(?:\s*[A-Z0-9/_#-]+)*)/i,
    /Bill\s+No\.?\s*:?\s*([A-Z0-9/_#-]+(?:\s*[A-Z0-9/_#-]+)*)/i,
    /Ref(?:erence)?\s+No\.?\s*:?\s*([A-Z0-9/_#-]+(?:\s*[A-Z0-9/_#-]+)*)/i,
    /Invoice\s*#\s*([A-Z0-9/_#-]+)/i,
    /\b(INV-?\d{4,})\b/i,
  ];

  const searchPools = [];
  if (section) searchPools.push(lines.slice(section.start, section.end + 1));
  searchPools.push(lines.slice(0, Math.min(40, lines.length)));
  searchPools.push(lines);

  for (const searchLines of searchPools) {
    for (const pattern of patterns) {
      for (const line of searchLines) {
        const match = line.text.match(pattern);
        if (!match || !match[1]) continue;
        const value = sanitizeInvoiceNumber(match[1]);
        if (value.length >= 2 && value.length <= 30 && !/e-?way\s+bill|mode\b/i.test(value)) {
          return value;
        }
      }
    }
  }

  return null;
}

function extractInvoiceDate(lines, section) {
  const monthMap = {
    jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03',
    apr: '04', april: '04', may: '05', jun: '06', june: '06',
    jul: '07', july: '07', aug: '08', august: '08', sep: '09', september: '09',
    oct: '10', october: '10', nov: '11', november: '11', dec: '12', december: '12',
  };

  const patterns = [
    /(?:Invoice\s+)?Date\s*:?\s*(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/i,
    /(?:Invoice\s+)?Date\s*:?\s*(\d{4}[-/.]\d{2}[-/.]\d{2})/i,
    /(?:Invoice\s+)?Date\s*:?\s*(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i,
    /(?:Invoice\s+)?Date\s*:?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i,
    /\bdt\.?\s*(\d{1,2}[-/.][A-Za-z]{3,9}[-/.]\d{2,4})/i,
    /Ack\s+Date\s*:?\s*(\d{1,2}[-/.][A-Za-z]{3,9}[-/.]\d{2,4})/i,
    /\b(\d{2}[-/.]\d{2}[-/.]\d{4})\b/,
  ];

  const searchPools = [];
  if (section) searchPools.push(lines.slice(section.start, section.end + 1));
  searchPools.push(lines.slice(0, Math.min(45, lines.length)));
  searchPools.push(lines);

  for (const searchLines of searchPools) {
    const raw = findFirstMatchingValue(searchLines, patterns);
    if (!raw) continue;
    const normalized = normalizeDate(raw, monthMap);
    if (normalized && isValidDate(normalized)) return normalized;
  }

  for (let i = 0; i < lines.length; i++) {
    if (!/^dated$/i.test(lines[i].text)) continue;
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      const normalized = normalizeDate(lines[j].text, monthMap);
      if (normalized && isValidDate(normalized)) return normalized;
    }
  }

  return null;
}

function extractDueDate(lines, section) {
  const monthMap = {
    jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03',
    apr: '04', april: '04', may: '05', jun: '06', june: '06',
    jul: '07', july: '07', aug: '08', august: '08', sep: '09', september: '09',
    oct: '10', october: '10', nov: '11', november: '11', dec: '12', december: '12',
  };

  const searchLines = section
    ? lines.slice(section.start, Math.min(section.end + 20, lines.length))
    : lines;

  const patterns = [
    /Due\s+Date\s*:?\s*(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/i,
    /Due\s+Date\s*:?\s*(\d{4}[-/.]\d{2}[-/.]\d{2})/i,
    /Due\s+Date\s*:?\s*(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i,
    /Due\s+Date\s*:?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i,
    /Payment\s+Due\s*:?\s*(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/i,
  ];

  const raw = findFirstMatchingValue(searchLines, patterns);
  if (!raw) return null;
  const normalized = normalizeDate(raw, monthMap);
  return normalized && isValidDate(normalized) ? normalized : null;
}

function extractPartyNameNearLabel(lines, labelPatterns) {
  const startIndex = findLineIndex(lines, labelPatterns);
  if (startIndex === -1) return null;

  for (let i = startIndex + 1; i < Math.min(startIndex + 6, lines.length); i++) {
    const candidate = lines[i].text.trim().replace(/[.,]+$/, '');
    if (candidate.length < 3) continue;
    if (isLikelyMetadataLine(candidate)) continue;
    if (/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(candidate)) continue;
    return candidate;
  }

  return null;
}

function extractClientName(lines, section) {
  const buyerName = extractPartyNameNearLabel(lines, BUYER_LABEL_PATTERNS);
  if (buyerName) return buyerName;

  const searchLines = section ? lines.slice(section.start, section.end + 1) : lines;
  const patterns = [
    /Bill\s+To\s*:?\s*([A-Z][A-Za-z0-9\s&.,()/-]+)/i,
    /Customer\s*:?\s*([A-Z][A-Za-z0-9\s&.,()/-]+)/i,
    /Buyer\s*:?\s*([A-Z][A-Za-z0-9\s&.,()/-]+)/i,
    /Billed\s+To\s*:?\s*([A-Z][A-Za-z0-9\s&.,()/-]+)/i,
  ];

  for (const pattern of patterns) {
    const raw = findFirstMatchingValue(searchLines, [pattern]);
    if (!raw) continue;
    const name = raw.replace(/[.,]+$/, '');
    if (name.length >= 3 && name.length <= 100) return name;
  }

  const billToIndex = searchLines.findIndex(line => /^(?:Bill\s*To|Billed\s*To|Customer|Buyer|Consignee)\s*:?\s*$/i.test(line.text));
  if (billToIndex !== -1) {
    for (let i = billToIndex + 1; i < Math.min(billToIndex + 4, searchLines.length); i++) {
      const candidate = searchLines[i].text.trim().replace(/[.,]+$/, '');
      if (candidate.length < 3) continue;
      if (/^(GST|GSTIN|Phone|Email|Address|State|PAN)/i.test(candidate)) continue;
      if (/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(candidate)) continue;
      return candidate;
    }
  }

  return null;
}

function extractClientGST(lines, section) {
  const gstPattern = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9])\b/;
  const buyerIndex = findLineIndex(lines, BUYER_LABEL_PATTERNS);
  if (buyerIndex !== -1) {
    for (let i = buyerIndex + 1; i < Math.min(buyerIndex + 14, lines.length); i++) {
      const match = lines[i].text.match(gstPattern);
      if (!match || !match[1]) continue;
      const stateCode = parseInt(match[1].substring(0, 2), 10);
      if (stateCode >= 1 && stateCode <= 37) return match[1];
    }
  }

  const searchPools = [];
  if (section) searchPools.push(lines.slice(section.start, section.end + 1));
  searchPools.push(lines);

  for (const searchLines of searchPools) {
    for (const line of searchLines) {
      const match = line.text.match(gstPattern);
      if (!match || !match[1]) continue;
      const stateCode = parseInt(match[1].substring(0, 2), 10);
      if (stateCode >= 1 && stateCode <= 37) return match[1];
    }
  }

  return null;
}

function extractPlaceOfSupply(lines) {
  const patterns = [
    /Place\s+of\s+Supply\s*:?\s*(.+)/i,
    /^State\s*:?\s*([A-Za-z][A-Za-z\s]+?)(?:,|$)/i,
  ];

  const raw = findFirstMatchingValue(lines, patterns);
  if (!raw) return null;
  const value = raw.replace(/[.,]+$/, '').trim();
  return value.length >= 2 && value.length <= 50 ? value : null;
}

function extractTotalAmount(lines, section) {
  const searchLines = section ? lines.slice(section.start, section.end + 1) : lines.slice(Math.floor(lines.length * 0.5));
  const patterns = [
    /(?:Grand\s+)?Total\s*(?:Amount)?\s*:?\s*(?:Rs\.?\s*)?([\d,]+(?:\.\d+)?)/i,
    /Amount\s+Payable\s*:?\s*(?:Rs\.?\s*)?([\d,]+(?:\.\d+)?)/i,
    /Net\s+(?:Amount|Total)\s*:?\s*(?:Rs\.?\s*)?([\d,]+(?:\.\d+)?)/i,
    /Balance\s+Due\s*:?\s*(?:Rs\.?\s*)?([\d,]+(?:\.\d+)?)/i,
    /Total\s+(?:Rs\.?\s*)?([\d,]+(?:\.\d+)?)(?:\s+\d+(?:\.\d+)?\s+\w+)?$/i,
    /([\d,]+(?:\.\d+)?)\s+Total\s+Inv\s+Amt\b/i,
    /Total\s+Inv\s+Amt\s*:?\s*(?:Rs\.?\s*)?([\d,]+(?:\.\d+)?)/i,
  ];

  for (const pattern of patterns) {
    const raw = findFirstMatchingValue(searchLines, [pattern]);
    const amount = parseAmount(raw);
    if (amount && amount > 0) return amount;
  }

  for (const line of searchLines) {
    if (!/total\s+inv\s+amt|grand\s+total|amount\s+payable/i.test(line.text)) continue;
    const amounts = [...line.text.matchAll(/([\d,]+(?:\.\d+)?)/g)]
      .map(match => parseAmount(match[1]))
      .filter(value => value && value > 0);
    if (amounts.length > 0) return Math.max(...amounts);
  }

  return null;
}

function extractSubTotal(lines, section) {
  const searchLines = section ? lines.slice(section.start, section.end + 1) : lines.slice(Math.floor(lines.length * 0.5));
  const patterns = [
    /Sub\s*Total\s*:?\s*(?:Rs\.?\s*)?([\d,]+(?:\.\d+)?)/i,
    /Taxable\s*(?:Value|Amount)\s*:?\s*(?:Rs\.?\s*)?([\d,]+(?:\.\d+)?)/i,
    /Total\s+Before\s+Tax\s*:?\s*(?:Rs\.?\s*)?([\d,]+(?:\.\d+)?)/i,
    /^\d{4,8}\s+[\d,]+(?:\.\d+)?\s+[\d,]+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+([\d,]+(?:\.\d+)?)$/i,
  ];

  for (const pattern of patterns) {
    const raw = findFirstMatchingValue(searchLines, [pattern]);
    const amount = parseAmount(raw);
    if (amount && amount > 0) return amount;
  }

  return null;
}

function extractTaxAmount(lines, section) {
  const searchLines = section ? lines.slice(section.start, section.end + 1) : lines;

  const explicitTax = findFirstMatchingValue(searchLines, [
    /(?:Total\s+)?(?:Tax|GST)\s*(?:Amount)?\s*:?\s*(?:Rs\.?\s*)?([\d,]+(?:\.\d+)?)/i,
  ]);
  const explicitTaxAmount = parseAmount(explicitTax);
  if (explicitTaxAmount !== null) return explicitTaxAmount;

  let totalTax = 0;
  const componentPattern = /(?:CGST|SGST|IGST)\s*(?:[@(]?\s*\d+\.?\d*%?\)?)?\s*:?\s*(?:Rs\.?\s*)?([\d,]+(?:\.\d+)?)/gi;
  for (const line of searchLines) {
    let match;
    while ((match = componentPattern.exec(line.text)) !== null) {
      totalTax += parseAmount(match[1]) || 0;
    }
  }
  if (totalTax > 0) return Math.round(totalTax * 100) / 100;

  for (const line of searchLines) {
    const tableMatch = line.text.match(/^\d{4,8}\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)\s+\d+(?:\.\d+)?%\s+[\d,]+(?:\.\d+)?$/i);
    if (tableMatch) {
      const amount = parseAmount(tableMatch[2] || tableMatch[1]);
      if (amount !== null) return amount;
    }
  }

  return null;
}

function extractRoundOff(lines, section) {
  const searchLines = section ? lines.slice(section.start, section.end + 1) : lines;

  for (const line of searchLines) {
    if (!/round\s*off/i.test(line.text)) continue;
    const sign = line.text.includes('-') ? -1 : 1;
    const match = line.text.match(/(?:Rs\.?\s*)?([\d,]+(?:\.\d+)?)/i);
    const amount = parseAmount(match && match[1]);
    if (amount !== null) return Math.round(sign * amount * 100) / 100;
  }

  return 0;
}

function extractPaymentMode(lines) {
  const raw = findFirstMatchingValue(lines, [
    /Payment\s+(?:Mode|Method|Type)\s*:?\s*(.+)/i,
    /Mode\s+of\s+Payment\s*:?\s*(.+)/i,
    /Paid\s+(?:via|by|through)\s+(.+)/i,
  ]);
  return raw ? raw.replace(/[.,]+$/, '') : null;
}

function extractPONumber(lines) {
  const raw = findFirstMatchingValue(lines, [
    /P\.?O\.?\s*(?:No\.?|Number)\s*:?\s*([A-Z0-9/_#-]+)/i,
    /Purchase\s+Order\s*(?:No\.?|Number|#)\s*:?\s*([A-Z0-9/_#-]+)/i,
  ]);
  return raw || null;
}

function extractPODate(lines) {
  const monthMap = {
    jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03',
    apr: '04', april: '04', may: '05', jun: '06', june: '06',
    jul: '07', july: '07', aug: '08', august: '08', sep: '09', september: '09',
    oct: '10', october: '10', nov: '11', november: '11', dec: '12', december: '12',
  };

  const raw = findFirstMatchingValue(lines, [
    /P\.?O\.?\s*Date\s*:?\s*(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/i,
    /P\.?O\.?\s*Date\s*:?\s*(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i,
  ]);
  if (!raw) return null;
  const normalized = normalizeDate(raw, monthMap);
  return normalized && isValidDate(normalized) ? normalized : null;
}

function extractDefaultTaxRate(lines) {
  const patterns = [
    /\b(?:CGST|SGST|IGST)\b[^\n%]*?(\d+(?:\.\d+)?)%/i,
    /^\d{4,8}\s+[\d,]+(?:\.\d+)?\s+[\d,]+(?:\.\d+)?\s+(\d+(?:\.\d+)?)%\s+[\d,]+(?:\.\d+)?$/i,
  ];

  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.text.match(pattern);
      if (!match || !match[1]) continue;
      const rate = parseFloat(match[1]);
      if (Number.isFinite(rate) && rate >= 0 && rate <= 100) return rate;
    }
  }

  return 0;
}

function extractItems(lines, section) {
  const items = [];
  if (!section) return items;

  const startIdx = section.start;
  const endIdx = section.end;
  if (startIdx >= endIdx) return items;

  const headerLine = lines[startIdx];
  if (!headerLine) return items;

  const defaultTaxRate = extractDefaultTaxRate(lines);
  let separator = 'multispaces';
  const sampleLine = lines[startIdx + 1]?.text || '';
  if (sampleLine.includes('|')) separator = '|';
  else if (sampleLine.includes('\t')) separator = '\t';

  const headerText = headerLine.text.toLowerCase();
  const headerCols = separator === 'multispaces'
    ? headerText.split(/\s{2,}/).map(col => col.trim())
    : headerText.split(separator === '|' ? '|' : '\t').map(col => col.trim());

  const descIdx = headerCols.findIndex(col => /item|description|particular|product|service|goods/i.test(col));
  const qtyIdx = headerCols.findIndex(col => /qty|quantity|qnty/i.test(col));
  const rateIdx = headerCols.findIndex(col => /rate|price|unit\s*price/i.test(col));
  const amountIdx = headerCols.findIndex(col => /amount|total|value/i.test(col));
  const gstIdx = headerCols.findIndex(col => /gst|tax|igst|cgst/i.test(col));
  const discIdx = headerCols.findIndex(col => /disc|discount/i.test(col));

  for (let i = startIdx + 1; i < endIdx; i++) {
    const line = lines[i];
    if (!line || line.text.length < 5) continue;
    if (/^(?:total|sub\s*total|taxable|grand|note|terms|bill\s+details|amount\s+chargeable|continued\s+to\s+page)/i.test(line.text)) break;

    const amountFirstMatch = line.text.match(
      /^(\d+)\s+(.+?)\s+([\d,]+(?:\.\d+)?)\s+([A-Za-z]+)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)\s+([A-Za-z]+)\s+(\d{4,8})$/i
    );
    if (amountFirstMatch) {
      const item = {
        name: amountFirstMatch[2].trim().replace(/^[^A-Za-z0-9(]+/, ''),
        quantity: parseFloat(amountFirstMatch[6]) || 1,
        unit: amountFirstMatch[7] || amountFirstMatch[4] || 'pcs',
        price: parseAmount(amountFirstMatch[5]) || 0,
        gst: defaultTaxRate || 0,
        discount: 0,
        amount: parseAmount(amountFirstMatch[3]) || 0,
        hsnCode: amountFirstMatch[8] || '',
      };
      if (item.name.length > 1 && item.amount > 0) {
        items.push(item);
        continue;
      }
    }

    const pricedRowMatch = line.text.match(
      /^(\d+)\s+(.+?)\s+(\d+(?:\.\d+)?)\s+([A-Za-z-]+)\s+(?:Rs\.?\s*)?([\d,]+(?:\.\d+)?)\s+(?:Rs\.?\s*)?([\d,]+(?:\.\d+)?)\s*\(([\d.]+)%\)\s+(?:Rs\.?\s*)?([\d,]+(?:\.\d+)?)$/i
    );
    if (pricedRowMatch) {
      const item = {
        name: pricedRowMatch[2].trim().replace(/^[^A-Za-z0-9(]+/, ''),
        quantity: parseFloat(pricedRowMatch[3]) || 1,
        unit: pricedRowMatch[4] || 'pcs',
        price: parseAmount(pricedRowMatch[5]) || 0,
        gst: parseFloat(pricedRowMatch[7]) || 0,
        discount: 0,
        amount: parseAmount(pricedRowMatch[8]) || 0,
      };
      if (item.name.length > 1 && item.amount > 0) {
        items.push(item);
        continue;
      }
    }

    let cols;
    if (separator === 'multispaces') cols = line.text.split(/\s{2,}/).map(col => col.trim());
    else cols = line.text.split(separator === '|' ? '|' : '\t').map(col => col.trim());

    if (cols.length >= 3) {
      const item = {
        name: descIdx !== -1 && cols[descIdx] ? cols[descIdx].replace(/^[^A-Za-z0-9(]+/, '') : null,
        quantity: qtyIdx !== -1 ? parseFloat(cols[qtyIdx]) || 1 : 1,
        unit: null,
        price: rateIdx !== -1 ? parseAmount(cols[rateIdx]) || 0 : 0,
        gst: gstIdx !== -1 ? parseFloat(cols[gstIdx]) || defaultTaxRate || 0 : defaultTaxRate || 0,
        discount: discIdx !== -1 ? parseAmount(cols[discIdx]) || 0 : 0,
        amount: amountIdx !== -1 ? parseAmount(cols[amountIdx]) || 0 : 0,
      };

      if (!item.name && cols.length > 2 && /^\d+$/.test(cols[0])) {
        item.name = cols[1];
        if (!item.quantity || item.quantity === 1) item.quantity = parseFloat(cols[2]) || 1;
        if (!item.price) item.price = parseAmount(cols[3]) || 0;
        if (!item.amount) item.amount = parseAmount(cols[cols.length - 1]) || 0;
      }

      if (item.amount === 0 && item.quantity > 0 && item.price > 0) {
        item.amount = Math.round(item.quantity * item.price * 100) / 100;
      }

      if (item.name && item.name.length > 1 && item.amount > 0) {
        items.push(item);
        continue;
      }
    }

    const regexMatch = line.text.match(/^(?:\d+\.?\s+)?(.+?)\s+(\d+(?:\.\d+)?)\s+([\d,.]+)\s+([\d,.]+)$/);
    if (regexMatch) {
      const item = {
        name: regexMatch[1].trim().replace(/^[^A-Za-z0-9(]+/, ''),
        quantity: parseFloat(regexMatch[2]) || 1,
        unit: null,
        price: parseAmount(regexMatch[3]) || 0,
        gst: defaultTaxRate || 0,
        discount: 0,
        amount: parseAmount(regexMatch[4]) || 0,
      };
      if (item.name.length > 1 && item.amount > 0) items.push(item);
    }
  }

  const seen = new Set();
  return items.filter(item => {
    const key = `${item.name}|${item.quantity}|${item.price}|${item.amount}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validateAndScore(result) {
  let confidence = 0;
  const errors = [];
  const warnings = [];

  if (result.invoiceNumber) confidence += 15;
  else {
    errors.push('Missing invoice number');
    confidence -= 5;
  }

  if (result.invoiceDate) confidence += 10;
  else {
    errors.push('Missing date');
    confidence -= 5;
  }

  if (result.clientName) confidence += 10;
  else {
    errors.push('Missing client name');
    confidence -= 5;
  }

  if (result.clientGST) confidence += 5;

  if (result.items.length > 0) {
    confidence += 15;
    if (result.items.every(item => item.name && item.quantity > 0 && item.amount > 0)) confidence += 20;
  } else {
    errors.push('No items found');
  }

  if (result.totalAmount) {
    confidence += 10;
    if (result.items.length > 0) {
      const itemsTotal = result.items.reduce((sum, item) => sum + (item.amount || 0), 0);
      const difference = Math.abs(result.totalAmount - itemsTotal);
      const tolerance = result.totalAmount * 0.05;
      if (difference <= tolerance) confidence += 15;
      else {
        warnings.push(`Total mismatch: Invoice=Rs ${result.totalAmount}, Items Sum=Rs ${itemsTotal.toFixed(2)}`);
        if (difference > result.totalAmount * 0.2) confidence -= 10;
      }
    }
  } else {
    errors.push('Missing total amount');
    confidence -= 10;
  }

  if (result._sectionsDetected >= 4) confidence += 5;
  if (result._sectionsMissing > 0) confidence -= result._sectionsMissing * 5;

  confidence = Math.max(0, Math.min(100, confidence));

  let status = 'rejected';
  if (confidence >= 90) status = 'auto-approved';
  else if (confidence >= 75) status = 'needs-review';
  else if (confidence >= 50) status = 'low-confidence';

  if (warnings.some(warning => warning.includes('Total mismatch')) && status === 'auto-approved') {
    status = 'needs-review';
  }

  return { confidence, status, errors, warnings };
}

function parseInvoice(rawText, fileName) {
  const startTime = Date.now();

  try {
    const lines = preprocessText(rawText);
    if (lines.length < 3) {
      return {
        invoiceNumber: null,
        invoiceDate: null,
        dueDate: null,
        clientName: null,
        clientGST: null,
        placeOfSupply: null,
        items: [],
        subTotal: null,
        taxAmount: null,
        roundOff: 0,
        totalAmount: null,
        paymentMode: null,
        poNumber: null,
        poDate: null,
        confidence: 0,
        status: 'rejected',
        errors: ['Insufficient text content. PDF may be image-based (requires OCR).'],
        warnings: [],
        metadata: {
          sectionsDetected: [],
          itemsCount: 0,
          processingTime: `${Date.now() - startTime}ms`,
          fileName,
        },
      };
    }

    const { sections, sectionsMissing } = detectSections(lines);
    const sectionsDetected = [];
    if (sections.headerSection) sectionsDetected.push('header');
    if (sections.billingSection) sectionsDetected.push('billing');
    if (sections.itemsSection) sectionsDetected.push('items');
    if (sections.totalsSection) sectionsDetected.push('totals');

    const invoiceNumber = extractInvoiceNumber(lines, sections.headerSection);
    const invoiceDate = extractInvoiceDate(lines, sections.headerSection);
    const dueDate = extractDueDate(lines, sections.headerSection);
    const clientName = extractClientName(lines, sections.billingSection);
    const clientGST = extractClientGST(lines, sections.billingSection);
    const placeOfSupply = extractPlaceOfSupply(lines);
    const paymentMode = extractPaymentMode(lines);
    const poNumber = extractPONumber(lines);
    const poDate = extractPODate(lines);
    const items = extractItems(lines, sections.itemsSection);

    const subTotal = extractSubTotal(lines, sections.totalsSection)
      || (items.length > 0 ? Math.round(items.reduce((sum, item) => sum + (item.amount || 0), 0) * 100) / 100 : null);
    const taxAmount = extractTaxAmount(lines, sections.totalsSection);
    const roundOff = extractRoundOff(lines, sections.totalsSection);
    const totalAmount = extractTotalAmount(lines, sections.totalsSection)
      || ((subTotal || 0) + (taxAmount || 0) + (roundOff || 0) || null);

    const result = {
      invoiceNumber,
      invoiceDate,
      dueDate,
      clientName,
      clientGST,
      placeOfSupply,
      items,
      subTotal,
      taxAmount,
      roundOff,
      totalAmount,
      paymentMode,
      poNumber,
      poDate,
      _sectionsDetected: sectionsDetected.length,
      _sectionsMissing: sectionsMissing,
    };

    const { confidence, status, errors, warnings } = validateAndScore(result);

    delete result._sectionsDetected;
    delete result._sectionsMissing;

    return {
      ...result,
      confidence,
      status,
      errors,
      warnings,
      metadata: {
        sectionsDetected,
        itemsCount: items.length,
        processingTime: `${Date.now() - startTime}ms`,
        fileName,
        totalLines: lines.length,
      },
    };
  } catch (error) {
    return {
      invoiceNumber: null,
      invoiceDate: null,
      dueDate: null,
      clientName: null,
      clientGST: null,
      placeOfSupply: null,
      items: [],
      subTotal: null,
      taxAmount: null,
      roundOff: 0,
      totalAmount: null,
      paymentMode: null,
      poNumber: null,
      poDate: null,
      confidence: 0,
      status: 'rejected',
      errors: [
        'Failed to detect invoice structure',
        error.message || 'Unknown parsing error',
        'Please check PDF quality or try manual entry',
      ],
      warnings: [],
      metadata: {
        sectionsDetected: [],
        itemsCount: 0,
        processingTime: `${Date.now() - startTime}ms`,
        fileName,
      },
    };
  }
}

module.exports = { parseInvoice };
