/**
 * Invoice Parser - Advanced PDF Text Extraction Engine
 * Implements a 9-step hybrid parsing pipeline:
 *   1. Text Preprocessing
 *   2. Section Boundary Detection
 *   3. Field Extraction (Multi-Pattern)
 *   4. Item Table Extraction
 *   5. Data Validation
 *   6. Confidence Scoring
 *   7. Status Determination
 *   8. Output Formatting
 *   9. Error Handling
 */

// ─── STEP 1: TEXT PREPROCESSING ──────────────────────────────────────────────

function preprocessText(rawText) {
  let text = rawText;

  // Remove noise
  text = text.replace(/Page\s+\d+\s+(of|\/)\s+\d+/gi, '');
  text = text.replace(/\b(COPY|DUPLICATE|ORIGINAL)\b/gi, '');
  text = text.replace(/--\s*\d+\s+of\s+\d+\s*--/gi, '');

  // Normalize currency symbols
  text = text.replace(/Rs\.?\s*/gi, '₹');
  text = text.replace(/INR\s*/gi, '₹');
  text = text.replace(/R\s+s\s+/gi, '₹');

  // Normalize quotes
  text = text.replace(/[\u2018\u2019]/g, "'");
  text = text.replace(/[\u201C\u201D]/g, '"');

  // Split into lines, number them
  const lines = text.split('\n').map((line, i) => ({
    num: i + 1,
    text: line.replace(/\r/, '').replace(/\s+/g, ' ').trim(),
  }));

  return lines.filter(l => l.text.length > 0);
}

// ─── STEP 2: SECTION BOUNDARY DETECTION ─────────────────────────────────────

function detectSections(lines) {
  const sections = {
    headerSection: null,
    billingSection: null,
    itemsSection: null,
    totalsSection: null,
  };

  let sectionsMissing = 0;

  // --- Header Section ---
  const headerKeywords = /invoice|tax invoice|bill|invoice no|date/i;
  const headerStart = lines.findIndex(l => headerKeywords.test(l.text));
  if (headerStart !== -1) {
    const billingKeyword = /bill\s*to|billed\s*to|customer|buyer/i;
    let headerEnd = lines.findIndex((l, i) => i > headerStart && billingKeyword.test(l.text));
    if (headerEnd === -1) headerEnd = Math.min(headerStart + 20, lines.length - 1);
    sections.headerSection = { start: headerStart, end: headerEnd };
  } else {
    sections.headerSection = { start: 0, end: Math.min(20, lines.length - 1) };
    sectionsMissing++;
  }

  // --- Billing Section ---
  const billingKeyword = /bill\s*to|billed\s*to|customer\s*:|buyer\s*:/i;
  const billingStart = lines.findIndex(l => billingKeyword.test(l.text));
  if (billingStart !== -1) {
    const tableHeaderPattern = /(?=.*(?:s\.?\s*no|sr\.?\s*no|item|description|particular))(?=.*(?:qty|quantity|qnty))(?=.*(?:rate|price|amount))/i;
    // Simpler fallback: look for lines with multiple column headers
    const simpleTableHeader = /(?:item|description|particular|product)/i;
    let billingEnd = lines.findIndex((l, i) => i > billingStart && (tableHeaderPattern.test(l.text) || (simpleTableHeader.test(l.text) && /(?:qty|quantity|rate|price|amount)/i.test(l.text))));
    if (billingEnd === -1) billingEnd = Math.min(billingStart + 15, lines.length - 1);
    sections.billingSection = { start: billingStart, end: billingEnd };
  } else {
    sectionsMissing++;
  }

  // --- Items Section ---
  const tableHeaderPattern = /(?=.*(?:s\.?\s*no|sr\.?\s*no|item|description|particular))(?=.*(?:qty|quantity|qnty|rate|price|amount))/i;
  const itemsStart = lines.findIndex(l => tableHeaderPattern.test(l.text));
  if (itemsStart !== -1) {
    const totalsPattern = /(?:sub\s*total|total\s*amount|taxable\s*amount|grand\s*total|net\s*amount)/i;
    let itemsEnd = lines.findIndex((l, i) => i > itemsStart + 1 && totalsPattern.test(l.text));
    if (itemsEnd === -1) itemsEnd = Math.min(itemsStart + 40, lines.length - 1);
    sections.itemsSection = { start: itemsStart, end: itemsEnd };
  } else {
    // Fallback: estimate items section as 30-70% of document
    const start30 = Math.floor(lines.length * 0.3);
    const end70 = Math.floor(lines.length * 0.7);
    sections.itemsSection = { start: start30, end: end70 };
    sectionsMissing++;
  }

  // --- Totals Section ---
  const totalsPattern = /(?:sub\s*total|total\s*amount|taxable\s*amount|grand\s*total|net\s*amount|amount\s*payable)/i;
  const totalsStart = lines.findIndex((l, i) => {
    if (sections.itemsSection && i <= sections.itemsSection.start) return false;
    return totalsPattern.test(l.text);
  });
  if (totalsStart !== -1) {
    const grandTotalPattern = /(?:grand\s*total|amount\s*payable|net\s*amount|balance\s*due)/i;
    let totalsEnd = lines.length - 1;
    for (let i = totalsStart; i < lines.length; i++) {
      if (grandTotalPattern.test(lines[i].text)) {
        totalsEnd = i;
        // Don't break; take the last occurrence
      }
    }
    sections.totalsSection = { start: totalsStart, end: totalsEnd };
  } else {
    // Fallback: last 20% of document
    sections.totalsSection = { start: Math.floor(lines.length * 0.8), end: lines.length - 1 };
    sectionsMissing++;
  }

  return { sections, sectionsMissing };
}

// ─── STEP 3: FIELD EXTRACTION ───────────────────────────────────────────────

function extractInvoiceNumber(lines, section) {
  const patterns = [
    { pattern: /Invoice\s+No\.?\s*:?\s*([A-Z0-9\/_#-]+(?:\s*[A-Z0-9\/_#-]+)*)/i, weight: 10 },
    { pattern: /Bill\s+No\.?\s*:?\s*([A-Z0-9\/_#-]+(?:\s*[A-Z0-9\/_#-]+)*)/i, weight: 9 },
    { pattern: /Ref(?:erence)?\s+No\.?\s*:?\s*([A-Z0-9\/_#-]+(?:\s*[A-Z0-9\/_#-]+)*)/i, weight: 8 },
    { pattern: /Invoice\s*#\s*([A-Z0-9\/_#-]+)/i, weight: 7 },
    { pattern: /\b(INV-?\d{4,})\b/i, weight: 5 },
  ];

  const searchPools = [];
  if (section) searchPools.push(lines.slice(section.start, section.end + 1));
  searchPools.push(lines.slice(0, Math.min(35, lines.length)));
  searchPools.push(lines);

  for (const searchLines of searchPools) {
    for (const { pattern } of patterns) {
      for (const line of searchLines) {
        const match = line.text.match(pattern);
        if (match && match[1]) {
          const value = match[1].trim();
          if (value.length >= 2 && value.length <= 30) {
            return value;
          }
        }
      }
    }
  }
  return null;
}

function extractInvoiceDate(lines, section) {
  const patterns = [
    { pattern: /(?:Invoice\s+)?Date\s*:?\s*(\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4})/i, weight: 10 },
    { pattern: /(?:Invoice\s+)?Date\s*:?\s*(\d{4}[-\/\.]\d{2}[-\/\.]\d{2})/i, weight: 10 },
    { pattern: /(?:Invoice\s+)?Date\s*:?\s*(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i, weight: 10 },
    { pattern: /(?:Invoice\s+)?Date\s*:?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i, weight: 9 },
    { pattern: /\b(\d{2}[-\/\.]\d{2}[-\/\.]\d{4})\b/, weight: 5 },
  ];

  const monthMap = {
    jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03',
    apr: '04', april: '04', may: '05', jun: '06', june: '06',
    jul: '07', july: '07', aug: '08', august: '08', sep: '09', september: '09',
    oct: '10', october: '10', nov: '11', november: '11', dec: '12', december: '12',
  };

  const searchPools = [];
  if (section) searchPools.push(lines.slice(section.start, section.end + 1));
  searchPools.push(lines.slice(0, Math.min(35, lines.length)));
  searchPools.push(lines);

  for (const searchLines of searchPools) {
    for (const { pattern } of patterns) {
      for (const line of searchLines) {
        const match = line.text.match(pattern);
        if (match && match[1]) {
          const raw = match[1].trim();
          const normalized = normalizeDate(raw, monthMap);
          if (normalized && isValidDate(normalized)) {
            return normalized;
          }
        }
      }
    }
  }
  return null;
}

function normalizeDate(raw, monthMap) {
  // YYYY-MM-DD (already correct)
  let m = raw.match(/^(\d{4})[-\/\.](\d{2})[-\/\.](\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // DD-MM-YYYY or DD/MM/YYYY
  m = raw.match(/^(\d{1,2})[-\/\.](\d{1,2})[-\/\.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;

  // DD-MM-YY
  m = raw.match(/^(\d{1,2})[-\/\.](\d{1,2})[-\/\.](\d{2})$/);
  if (m) {
    const year = parseInt(m[3]) > 50 ? `19${m[3]}` : `20${m[3]}`;
    return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }

  // 13 Feb 2026 or 13 February 2026
  m = raw.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const mon = monthMap[m[2].toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[1].padStart(2, '0')}`;
  }

  // Feb 13, 2026 or February 13, 2026
  m = raw.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mon = monthMap[m[1].toLowerCase()];
    if (mon) return `${m[3]}-${mon}-${m[2].padStart(2, '0')}`;
  }

  return null;
}

function isValidDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  const minDate = new Date('2000-01-01');
  const maxDate = new Date();
  maxDate.setFullYear(maxDate.getFullYear() + 1);
  return d >= minDate && d <= maxDate;
}

function extractDueDate(lines, section) {
  const searchLines = section
    ? lines.slice(section.start, Math.min(section.end + 20, lines.length))
    : lines;

  const monthMap = {
    jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03',
    apr: '04', april: '04', may: '05', jun: '06', june: '06',
    jul: '07', july: '07', aug: '08', august: '08', sep: '09', september: '09',
    oct: '10', october: '10', nov: '11', november: '11', dec: '12', december: '12',
  };

  const patterns = [
    /Due\s+Date\s*:?\s*(\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4})/i,
    /Due\s+Date\s*:?\s*(\d{4}[-\/\.]\d{2}[-\/\.]\d{2})/i,
    /Due\s+Date\s*:?\s*(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i,
    /Due\s+Date\s*:?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i,
    /Payment\s+Due\s*:?\s*(\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4})/i,
  ];

  for (const pattern of patterns) {
    for (const line of searchLines) {
      const match = line.text.match(pattern);
      if (match && match[1]) {
        const normalized = normalizeDate(match[1].trim(), monthMap);
        if (normalized && isValidDate(normalized)) return normalized;
      }
    }
  }
  return null;
}

function extractClientName(lines, section) {
  const searchLines = section
    ? lines.slice(section.start, section.end + 1)
    : lines;

  // Strategy 1: Bill To : <name on same line>
  const sameLinePatterns = [
    /Bill\s+To\s*:?\s*([A-Z][A-Za-z\s&.,()]+)/i,
    /Customer\s*:?\s*([A-Z][A-Za-z\s&.,()]+)/i,
    /Buyer\s*:?\s*([A-Z][A-Za-z\s&.,()]+)/i,
    /Billed\s+To\s*:?\s*([A-Z][A-Za-z\s&.,()]+)/i,
  ];

  for (const pattern of sameLinePatterns) {
    for (const line of searchLines) {
      const match = line.text.match(pattern);
      if (match && match[1]) {
        const name = match[1].trim().replace(/[.,]+$/, '');
        if (name.length >= 3 && name.length <= 100) return name;
      }
    }
  }

  // Strategy 2: "Bill To" on its own line, name on the next non-empty line
  const billToIndex = searchLines.findIndex(l => /^(?:Bill\s*To|Billed\s*To|Customer|Buyer)\s*:?\s*$/i.test(l.text));
  if (billToIndex !== -1) {
    for (let i = billToIndex + 1; i < Math.min(billToIndex + 4, searchLines.length); i++) {
      const candidate = searchLines[i].text.trim();
      if (candidate.length < 3) continue;
      if (/^(GST|GSTIN|Phone|Email|Address|State|PAN)/i.test(candidate)) continue;
      if (/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z]\d$/.test(candidate)) continue;
      return candidate.replace(/[.,]+$/, '');
    }
  }

  return null;
}

function extractClientGST(lines, section) {
  const gstPattern = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9])\b/;
  const searchPools = [];
  if (section) searchPools.push(lines.slice(section.start, section.end + 1));
  searchPools.push(lines);

  for (const searchLines of searchPools) {
    for (const line of searchLines) {
      const match = line.text.match(gstPattern);
      if (match && match[1]) {
        const gst = match[1];
        const stateCode = parseInt(gst.substring(0, 2), 10);
        if (stateCode >= 1 && stateCode <= 37) return gst;
      }
    }
  }
  return null;
}

function extractPlaceOfSupply(lines) {
  const patterns = [
    /Place\s+of\s+Supply\s*:?\s*(.+)/i,
    /State\s*:?\s*([A-Za-z\s]+)/i,
  ];
  for (const pattern of patterns) {
    for (const line of lines) {
      const match = line.text.match(pattern);
      if (match && match[1]) {
        const val = match[1].trim().replace(/[.,]+$/, '');
        if (val.length >= 2 && val.length <= 50) return val;
      }
    }
  }
  return null;
}

function extractTotalAmount(lines, section) {
  const searchLines = section
    ? lines.slice(section.start, section.end + 1)
    : lines.slice(Math.floor(lines.length * 0.5));

  const patterns = [
    { pattern: /(?:Grand\s+)?Total\s*(?:Amount)?\s*:?\s*₹?\s*([\d,]+\.?\d*)/i, weight: 10 },
    { pattern: /Amount\s+Payable\s*:?\s*₹?\s*([\d,]+\.?\d*)/i, weight: 10 },
    { pattern: /Net\s+(?:Amount|Total)\s*:?\s*₹?\s*([\d,]+\.?\d*)/i, weight: 9 },
    { pattern: /Balance\s+Due\s*:?\s*₹?\s*([\d,]+\.?\d*)/i, weight: 8 },
    { pattern: /Total\s*:?\s*₹?\s*([\d,]+\.?\d*)/i, weight: 6 },
  ];

  let lastMatch = null;

  for (const { pattern } of patterns) {
    for (const line of searchLines) {
      const match = line.text.match(pattern);
      if (match && match[1]) {
        const value = parseFloat(match[1].replace(/,/g, ''));
        if (value > 0) {
          lastMatch = Math.round(value * 100) / 100;
        }
      }
    }
    if (lastMatch !== null) return lastMatch;
  }

  return lastMatch;
}

function extractSubTotal(lines, section) {
  const searchLines = section
    ? lines.slice(section.start, section.end + 1)
    : lines.slice(Math.floor(lines.length * 0.5));

  const patterns = [
    /Sub\s*Total\s*:?\s*₹?\s*([\d,]+\.?\d*)/i,
    /Taxable\s*(?:Value|Amount)\s*:?\s*₹?\s*([\d,]+\.?\d*)/i,
    /Total\s+Before\s+Tax\s*:?\s*₹?\s*([\d,]+\.?\d*)/i,
  ];

  for (const pattern of patterns) {
    for (const line of searchLines) {
      const match = line.text.match(pattern);
      if (match && match[1]) {
        const value = parseFloat(match[1].replace(/,/g, ''));
        if (value > 0) return Math.round(value * 100) / 100;
      }
    }
  }
  return null;
}

function extractTaxAmount(lines, section) {
  const searchLines = section
    ? lines.slice(section.start, section.end + 1)
    : lines.slice(Math.floor(lines.length * 0.5));

  let totalTax = 0;

  // Try to find explicit total tax first
  const totalTaxPattern = /(?:Total\s+)?(?:Tax|GST)\s*(?:Amount)?\s*:?\s*₹?\s*([\d,]+\.?\d*)/i;
  for (const line of searchLines) {
    const match = line.text.match(totalTaxPattern);
    if (match && match[1]) {
      return Math.round(parseFloat(match[1].replace(/,/g, '')) * 100) / 100;
    }
  }

  // Otherwise sum CGST + SGST or IGST
  const componentPattern = /(?:CGST|SGST|IGST)\s*(?:[@(]?\s*\d+\.?\d*%?\)?)?\s*:?\s*₹?\s*([\d,]+\.?\d*)/gi;
  for (const line of searchLines) {
    let match;
    while ((match = componentPattern.exec(line.text)) !== null) {
      totalTax += parseFloat(match[1].replace(/,/g, '')) || 0;
    }
  }

  return totalTax > 0 ? Math.round(totalTax * 100) / 100 : null;
}

function extractRoundOff(lines, section) {
  const searchLines = section
    ? lines.slice(section.start, section.end + 1)
    : lines.slice(Math.floor(lines.length * 0.5));

  for (const line of searchLines) {
    if (!/round\s*off/i.test(line.text)) continue;

    const sign = line.text.includes('-') ? -1 : 1;
    const amountMatch = line.text.match(/₹?\s*([\d,]+\.?\d*)/);
    if (!amountMatch || !amountMatch[1]) continue;

    const value = parseFloat(amountMatch[1].replace(/,/g, ''));
    if (!Number.isNaN(value)) {
      return Math.round(sign * value * 100) / 100;
    }
  }

  return 0;
}

function extractPaymentMode(lines) {
  const patterns = [
    /Payment\s+(?:Mode|Method|Type)\s*:?\s*(.+)/i,
    /Mode\s+of\s+Payment\s*:?\s*(.+)/i,
    /Paid\s+(?:via|by|through)\s+(.+)/i,
  ];

  for (const pattern of patterns) {
    for (const line of lines) {
      const match = line.text.match(pattern);
      if (match && match[1]) {
        return match[1].trim().replace(/[.,]+$/, '');
      }
    }
  }
  return null;
}

function extractPONumber(lines) {
  const patterns = [
    /P\.?O\.?\s*(?:No\.?|Number)\s*:?\s*([A-Z0-9\/_#-]+)/i,
    /Purchase\s+Order\s*(?:No\.?|Number|#)\s*:?\s*([A-Z0-9\/_#-]+)/i,
  ];

  for (const pattern of patterns) {
    for (const line of lines) {
      const match = line.text.match(pattern);
      if (match && match[1]) return match[1].trim();
    }
  }
  return null;
}

function extractPODate(lines) {
  const monthMap = {
    jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03',
    apr: '04', april: '04', may: '05', jun: '06', june: '06',
    jul: '07', july: '07', aug: '08', august: '08', sep: '09', september: '09',
    oct: '10', october: '10', nov: '11', november: '11', dec: '12', december: '12',
  };

  const patterns = [
    /P\.?O\.?\s*Date\s*:?\s*(\d{1,2}[-\/\.]\d{1,2}[-\/\.]\d{2,4})/i,
    /P\.?O\.?\s*Date\s*:?\s*(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i,
  ];

  for (const pattern of patterns) {
    for (const line of lines) {
      const match = line.text.match(pattern);
      if (match && match[1]) {
        const normalized = normalizeDate(match[1].trim(), monthMap);
        if (normalized && isValidDate(normalized)) return normalized;
      }
    }
  }
  return null;
}

// ─── STEP 4: ITEM TABLE EXTRACTION ──────────────────────────────────────────

function extractItems(lines, section) {
  const items = [];

  if (!section) return items;

  const startIdx = section.start;
  const endIdx = section.end;

  if (startIdx >= endIdx) return items;

  // 4.1 - Detect header line
  const headerLine = lines[startIdx];
  if (!headerLine) return items;

  // 4.2 - Detect separator type
  let separator;
  const sampleLine = lines[startIdx + 1]?.text || '';
  if (sampleLine.includes('|')) separator = '|';
  else if (sampleLine.includes('\t')) separator = '\t';
  else separator = 'multispaces';

  // 4.3 - Column mapping via header text
  const headerText = headerLine.text.toLowerCase();
  const headerCols = separator === 'multispaces'
    ? headerText.split(/\s{2,}/).map(c => c.trim())
    : headerText.split(separator === '|' ? '|' : '\t').map(c => c.trim());

  const descIdx = headerCols.findIndex(c => /item|description|particular|product|service/i.test(c));
  const qtyIdx = headerCols.findIndex(c => /qty|quantity|qnty/i.test(c));
  const rateIdx = headerCols.findIndex(c => /rate|price|unit\s*price/i.test(c));
  const amountIdx = headerCols.findIndex(c => /amount|total|value/i.test(c));
  const gstIdx = headerCols.findIndex(c => /gst|tax|igst|cgst/i.test(c));
  const discIdx = headerCols.findIndex(c => /disc|discount/i.test(c));

  // 4.4 - Parse rows
  for (let i = startIdx + 1; i < endIdx; i++) {
    const line = lines[i];
    if (!line || line.text.trim().length < 5) continue;
    if (/^(?:total|sub\s*total|taxable|grand|note|terms)/i.test(line.text.trim())) break;

    const pricedRowMatch = line.text.match(
      /^(\d+)\s+(.+?)\s+(\d+(?:\.\d+)?)\s+([A-Za-z-]+)\s+₹\s*([\d,]+(?:\.\d+)?)\s+₹\s*([\d,]+(?:\.\d+)?)\s*\(([\d.]+)%\)\s+₹\s*([\d,]+(?:\.\d+)?)$/i
    );

    if (pricedRowMatch) {
      const item = {
        name: pricedRowMatch[2].trim().replace(/^[^A-Za-z0-9(]+/, ''),
        quantity: parseFloat(pricedRowMatch[3]) || 1,
        unit: pricedRowMatch[4] || 'pcs',
        price: parseFloat(pricedRowMatch[5].replace(/,/g, '')) || 0,
        gst: parseFloat(pricedRowMatch[7]) || 0,
        discount: 0,
        amount: parseFloat(pricedRowMatch[8].replace(/,/g, '')) || 0,
      };

      if (item.name.length > 1 && item.amount > 0) {
        items.push(item);
        continue;
      }
    }

    let cols;
    if (separator === 'multispaces') {
      cols = line.text.split(/\s{2,}/).map(c => c.trim());
    } else {
      cols = line.text.split(separator === '|' ? '|' : '\t').map(c => c.trim());
    }

    // Try structured extraction
    if (cols.length >= 3) {
      const item = {
        name: descIdx !== -1 && cols[descIdx] ? cols[descIdx].replace(/^[^A-Za-z0-9(]+/, '') : null,
        quantity: qtyIdx !== -1 ? parseFloat(cols[qtyIdx]) || 1 : 1,
        unit: null,
        price: rateIdx !== -1 ? parseFloat((cols[rateIdx] || '').replace(/,/g, '')) || 0 : 0,
        gst: gstIdx !== -1 ? parseFloat(cols[gstIdx]) || 0 : 0,
        discount: discIdx !== -1 ? parseFloat((cols[discIdx] || '').replace(/,/g, '')) || 0 : 0,
        amount: amountIdx !== -1 ? parseFloat((cols[amountIdx] || '').replace(/,/g, '')) || 0 : 0,
      };

      // Skip S.No column if first col is a number
      if (!item.name && cols.length > 1) {
        const firstCol = cols[0];
        if (/^\d+$/.test(firstCol) && cols.length > 2) {
          item.name = cols[1];
          // Re-map based on offset
          if (!item.quantity || item.quantity === 1) item.quantity = parseFloat(cols[2]) || 1;
          if (!item.price) item.price = parseFloat((cols[3] || '').replace(/,/g, '')) || 0;
          if (!item.amount) item.amount = parseFloat((cols[cols.length - 1] || '').replace(/,/g, '')) || 0;
        }
      }

      // Calculate amount if missing
      if (item.amount === 0 && item.quantity > 0 && item.price > 0) {
        item.amount = item.quantity * item.price;
      }

      if (item.name && item.name.length > 1 && item.amount > 0) {
        items.push(item);
        continue;
      }
    }

    // Fallback: regex-based extraction
    const regexMatch = line.text.match(/^(?:\d+\.?\s+)?(.+?)\s+(\d+(?:\.\d+)?)\s+([\d,.]+)\s+([\d,.]+)$/);
    if (regexMatch) {
      const item = {
        name: regexMatch[1].trim().replace(/^[^A-Za-z0-9(]+/, ''),
        quantity: parseFloat(regexMatch[2]) || 1,
        unit: null,
        price: parseFloat(regexMatch[3].replace(/,/g, '')) || 0,
        gst: 0,
        discount: 0,
        amount: parseFloat(regexMatch[4].replace(/,/g, '')) || 0,
      };
      if (item.name.length > 1 && item.amount > 0) {
        items.push(item);
      }
    }
  }

  return items;
}

// ─── STEP 5-7: VALIDATION, SCORING, STATUS ──────────────────────────────────

function validateAndScore(result) {
  let confidence = 0;
  const errors = [];
  const warnings = [];

  // --- Confidence Scoring ---
  if (result.invoiceNumber) confidence += 15;
  else { errors.push('Missing invoice number'); confidence -= 5; }

  if (result.invoiceDate) confidence += 10;
  else { errors.push('Missing date'); confidence -= 5; }

  if (result.clientName) confidence += 10;
  else { errors.push('Missing client name'); confidence -= 5; }

  if (result.clientGST) confidence += 5;

  if (result.items.length > 0) {
    confidence += 15;
    const allComplete = result.items.every(item => item.name && item.quantity > 0 && item.amount > 0);
    if (allComplete) confidence += 20;
  } else {
    errors.push('No items found');
  }

  if (result.totalAmount) {
    confidence += 10;

    // Validate total against items sum
    if (result.items.length > 0) {
      const itemsTotal = result.items.reduce((sum, item) => sum + (item.amount || 0), 0);
      const difference = Math.abs(result.totalAmount - itemsTotal);
      const tolerance = result.totalAmount * 0.05; // 5% tolerance (accounting for taxes/discounts)

      if (difference <= tolerance) {
        confidence += 15;
      } else {
        warnings.push(`Total mismatch: Invoice=₹${result.totalAmount}, Items Sum=₹${itemsTotal.toFixed(2)}`);
        // Don't reduce confidence too much - taxes and charges often explain the difference
        if (difference > result.totalAmount * 0.20) {
          confidence -= 10;
        }
      }
    }
  } else {
    errors.push('Missing total amount');
    confidence -= 10;
  }

  if (result._sectionsDetected >= 4) confidence += 5;
  if (result._sectionsMissing > 0) confidence -= result._sectionsMissing * 5;

  // Clamp confidence
  confidence = Math.max(0, Math.min(100, confidence));

  // --- Status Determination ---
  let status;
  if (confidence >= 90) status = 'auto-approved';
  else if (confidence >= 75) status = 'needs-review';
  else if (confidence >= 50) status = 'low-confidence';
  else status = 'rejected';

  // Override: Force review if total mismatch
  if (warnings.some(w => w.includes('Total mismatch'))) {
    if (status === 'auto-approved') status = 'needs-review';
  }

  return { confidence, status, errors, warnings };
}

// ─── STEP 8-9: MAIN PIPELINE ────────────────────────────────────────────────

function parseInvoice(rawText, fileName) {
  const startTime = Date.now();

  try {
    // Step 1: Preprocess
    const lines = preprocessText(rawText);

    if (lines.length < 3) {
      return {
        invoiceNumber: null, invoiceDate: null, dueDate: null,
        clientName: null, clientGST: null, placeOfSupply: null,
        items: [], subTotal: null, taxAmount: null, roundOff: 0, totalAmount: null,
        paymentMode: null, poNumber: null, poDate: null,
        confidence: 0, status: 'rejected',
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

    // Step 2: Detect sections
    const { sections, sectionsMissing } = detectSections(lines);

    const sectionsDetected = [];
    if (sections.headerSection) sectionsDetected.push('header');
    if (sections.billingSection) sectionsDetected.push('billing');
    if (sections.itemsSection) sectionsDetected.push('items');
    if (sections.totalsSection) sectionsDetected.push('totals');

    // Step 3: Extract fields
    const invoiceNumber = extractInvoiceNumber(lines, sections.headerSection);
    const invoiceDate = extractInvoiceDate(lines, sections.headerSection);
    const dueDate = extractDueDate(lines, sections.headerSection);
    const clientName = extractClientName(lines, sections.billingSection);
    const clientGST = extractClientGST(lines, sections.billingSection);
    const placeOfSupply = extractPlaceOfSupply(lines);
    const paymentMode = extractPaymentMode(lines);
    const poNumber = extractPONumber(lines);
    const poDate = extractPODate(lines);

    // Step 4: Extract items
    const items = extractItems(lines, sections.itemsSection);

    // Step 3 (continued): Extract totals
    const totalAmount = extractTotalAmount(lines, sections.totalsSection);
    const subTotal = extractSubTotal(lines, sections.totalsSection);
    const taxAmount = extractTaxAmount(lines, sections.totalsSection);
    const roundOff = extractRoundOff(lines, sections.totalsSection);

    // Assemble result
    const result = {
      invoiceNumber,
      invoiceDate,
      dueDate,
      clientName,
      clientGST,
      placeOfSupply,
      items,
      subTotal: subTotal || (items.length > 0 ? Math.round(items.reduce((s, i) => s + (i.amount || 0), 0) * 100) / 100 : null),
      taxAmount,
      roundOff,
      totalAmount,
      paymentMode,
      poNumber,
      poDate,
      _sectionsDetected: sectionsDetected.length,
      _sectionsMissing: sectionsMissing,
    };

    // Step 5-7: Validate and score
    const { confidence, status, errors, warnings } = validateAndScore(result);

    // Step 8: Format output
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
  } catch (err) {
    // Step 9: Error handling
    return {
      invoiceNumber: null, invoiceDate: null, dueDate: null,
      clientName: null, clientGST: null, placeOfSupply: null,
      items: [], subTotal: null, taxAmount: null, roundOff: 0, totalAmount: null,
      paymentMode: null, poNumber: null, poDate: null,
      confidence: 0, status: 'rejected',
      errors: [
        'Failed to detect invoice structure',
        err.message || 'Unknown parsing error',
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
