const axios = require('axios');
const { parseInvoice } = require('../utils/invoiceParser');
const { renderPdfPagesToImages } = require('./pdfVisionRenderer');

const NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const NVIDIA_MODEL = process.env.NVIDIA_INVOICE_MODEL || process.env.NVIDIA_MODEL || 'meta/llama-3.1-8b-instruct';
const NVIDIA_VISION_MODEL = process.env.NVIDIA_INVOICE_VISION_MODEL || 'meta/llama-3.2-11b-vision-instruct';

function buildInvoiceJsonSchema(fileName = 'unknown.pdf') {
  return `{
  "invoiceNumber": "",
  "invoiceDate": "",
  "dueDate": "",
  "vendorName": "",
  "vendorGST": "",
  "vendorAddress": "",
  "vendorAddressObject": {
    "line1": "",
    "line2": "",
    "city": "",
    "state": "",
    "zip": "",
    "country": "India"
  },
  "vendorPhone": "",
  "vendorEmail": "",
  "vendorPAN": "",
  "clientName": "",
  "clientGST": "",
  "placeOfSupply": "",
  "items": [
    {
      "name": "",
      "quantity": 0,
      "unit": "",
      "price": 0,
      "gst": 0,
      "discount": 0,
      "amount": 0,
      "hsnCode": ""
    }
  ],
  "subTotal": 0,
  "taxAmount": 0,
  "roundOff": 0,
  "totalAmount": 0,
  "paymentMode": "",
  "poNumber": "",
  "poDate": "",
  "confidence": 0,
  "status": "needs-review",
  "errors": [],
  "warnings": [],
  "metadata": {
    "fileName": "${fileName}",
    "itemsCount": 0,
    "processingTime": "",
    "totalLines": 0
  }
}`;
}

function buildDocumentPerspectiveRules(documentType = 'invoice') {
  if (documentType === 'expense') {
    return `- Treat this as an expense/purchase bill being recorded by the user.
- vendorName is the seller, supplier, or bill issuer.
- clientName is the buyer, bill-to party, or recipient if visible.
- invoiceNumber is the supplier's bill/invoice/receipt number.`;
  }

  if (documentType === 'income') {
    return `- Treat this as an income/sales record being recorded by the user.
- clientName is the customer, payer, bill-to party, or recipient.
- vendorName is the seller, supplier, or issuer if visible.
- invoiceNumber is the income invoice/receipt/reference number.`;
  }

  return `- vendorName is the seller, supplier, or invoice issuer if visible.
- clientName is the buyer, customer, bill-to party, or recipient.
- invoiceNumber is the invoice/bill/reference number.`;
}

function buildInvoicePrompt(rawText, fileName = 'unknown.pdf', options = {}) {
  const documentType = options.documentType || 'invoice';
  return `You are an expert invoice parser.
Extract structured invoice data from the PDF text below.
The text may contain OCR/PDF extraction mistakes, so infer conservatively and never invent line items or totals.

Return ONLY a valid JSON object with this exact structure:
${buildInvoiceJsonSchema(fileName)}

Rules:
${buildDocumentPerspectiveRules(documentType)}
- "totalAmount" must represent the specific invoice's Grand Total (the total amount of this transaction, including subtotal, taxes, and round-offs). Do NOT confuse this with customer ledger balances, outstanding balances, overall outstanding amounts, or previous balances (e.g. "Total Outstanding as on..."). These are separate ledger balances and must NOT be used as the invoice totalAmount.
- "subTotal" must represent the taxable value / base total before taxes and additional round-offs. Do NOT map the invoice's final grand total (including tax) to subTotal.
- GST rate ("gst" field in items) MUST be extracted as a percentage number between 0 and 100 (e.g., 5, 12, 18, or 28), NOT a decimal fraction (like 0.18) and NOT the calculated tax amount (like 180).
- If separate CGST (e.g., 9%) and SGST (e.g., 9%) rates are listed, combine/sum them to get the total total GST rate (e.g., 18) for the "gst" field.
- Dates (including invoiceDate, dueDate, poDate) MUST be formatted as YYYY-MM-DD.
- If there is no explicit 'Due Date' or 'Payment Due Date' visible, search for payment terms or credit terms (e.g., 'Net 30', '30 Days', 'Due in 15 Days'). If found, calculate the dueDate relative to the invoiceDate (e.g. invoiceDate + 30 days) and set the 'dueDate' field to that calculated date. If not found or unable to calculate, leave it as an empty string.
- confidence must be a number from 0 to 100.
- status must be one of: auto-approved, needs-review, low-confidence, rejected.
- Use empty strings, zero, or empty arrays when information is missing.
- Preserve invoice item names as closely as possible.
- Do not wrap the JSON in markdown.

Invoice text:
${rawText}`;
}

function buildScannedInvoicePrompt(fileName = 'unknown.pdf', options = {}) {
  const documentType = options.documentType || 'invoice';
  return `You are an expert invoice parser reading invoice pages from images rendered from a scanned PDF.
Extract the invoice data from the provided images.

Return ONLY a valid JSON object with this exact structure:
${buildInvoiceJsonSchema(fileName)}

Rules:
${buildDocumentPerspectiveRules(documentType)}
- "totalAmount" must represent the specific invoice's Grand Total (the total amount of this transaction, including subtotal, taxes, and round-offs). Do NOT confuse this with customer ledger balances, outstanding balances, overall outstanding amounts, or previous balances (e.g. "Total Outstanding as on..."). These are separate ledger balances and must NOT be used as the invoice totalAmount.
- "subTotal" must represent the taxable value / base total before taxes and additional round-offs. Do NOT map the invoice's final grand total (including tax) to subTotal.
- Read the images carefully and use OCR-style reasoning to recover invoice fields and line items.
- GST rate ("gst" field in items) MUST be extracted as a percentage number between 0 and 100 (e.g., 5, 12, 18, or 28), NOT a decimal fraction (like 0.18) and NOT the calculated tax amount (like 180).
- If separate CGST (e.g., 9%) and SGST (e.g., 9%) rates are listed, combine/sum them to get the total total GST rate (e.g., 18) for the "gst" field.
- Dates (including invoiceDate, dueDate, poDate) MUST be formatted as YYYY-MM-DD.
- If there is no explicit 'Due Date' or 'Payment Due Date' visible, search for payment terms or credit terms (e.g., 'Net 30', '30 Days', 'Due in 15 Days'). If found, calculate the dueDate relative to the invoiceDate (e.g. invoiceDate + 30 days) and set the 'dueDate' field to that calculated date. If not found or unable to calculate, leave it as an empty string.
- confidence must be a number from 0 to 100.
- status must be one of: auto-approved, needs-review, low-confidence, rejected.
- Use empty strings, zero, or empty arrays when information is missing.
- Preserve invoice item names as closely as possible.
- If multiple pages are shown, combine them into one invoice.
- Do not wrap the JSON in markdown.`;
}

function buildInvoiceStructuringPrompt(rawContent, fileName = 'unknown.pdf', options = {}) {
  const documentType = options.documentType || 'invoice';
  return `Convert the following invoice extraction notes into a strict JSON invoice object.
Return ONLY a valid JSON object with this exact structure:
${buildInvoiceJsonSchema(fileName)}

Rules:
${buildDocumentPerspectiveRules(documentType)}
- "totalAmount" must represent the specific invoice's Grand Total (the total amount of this transaction, including subtotal, taxes, and round-offs). Do NOT confuse this with customer ledger balances, outstanding balances, overall outstanding amounts, or previous balances (e.g. "Total Outstanding as on..."). These are separate ledger balances and must NOT be used as the invoice totalAmount.
- "subTotal" must represent the taxable value / base total before taxes and additional round-offs. Do NOT map the invoice's final grand total (including tax) to subTotal.
- Convert prose, markdown, bullets, or OCR notes into the JSON fields.
- GST rate ("gst" field in items) MUST be extracted as a percentage number between 0 and 100 (e.g., 5, 12, 18, or 28), NOT a decimal fraction (like 0.18) and NOT the calculated tax amount (like 180).
- If separate CGST (e.g., 9%) and SGST (e.g., 9%) rates are listed, combine/sum them to get the total total GST rate (e.g., 18) for the "gst" field.
- Dates (including invoiceDate, dueDate, poDate) MUST be formatted as YYYY-MM-DD.
- If there is no explicit 'Due Date' or 'Payment Due Date' visible, search for payment terms or credit terms (e.g., 'Net 30', '30 Days', 'Due in 15 Days'). If found, calculate the dueDate relative to the invoiceDate (e.g. invoiceDate + 30 days) and set the 'dueDate' field to that calculated date. If not found or unable to calculate, leave it as an empty string.
- confidence must be a number from 0 to 100.
- status must be one of: auto-approved, needs-review, low-confidence, rejected.
- Use empty strings, zero, or empty arrays when information is missing.
- Do not wrap the JSON in markdown.

Input:
${rawContent}`;
}

function parseJsonObject(content = '') {
  const text = String(content || '').trim();
  if (!text) return {};

  const cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  const match = cleaned.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : cleaned);
}

async function parsePossiblyLooseInvoiceJson(content, fileName, options = {}) {
  try {
    return parseJsonObject(content);
  } catch (error) {
    const structuredContent = await callNvidiaChat({
      model: NVIDIA_MODEL,
      messages: [{ role: 'user', content: buildInvoiceStructuringPrompt(content, fileName, options) }],
      maxTokens: 2200,
      timeoutMs: Number(process.env.NVIDIA_INVOICE_TIMEOUT_MS || 30000),
    });
    return parseJsonObject(structuredContent);
  }
}

function formatToStandardDate(dateStr, preferUSFormat = false) {
  if (!dateStr) return null;
  let cleaned = String(dateStr)
    .trim()
    .replace(/(?:st|nd|rd|th)\b/gi, '') // Remove ordinals
    .replace(/\s+/g, ' ');

  const months = {
    jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03',
    apr: '04', april: '04', may: '05', jun: '06', june: '06',
    jul: '07', july: '07', aug: '08', august: '08', sep: '09', september: '09',
    oct: '10', october: '10', nov: '11', november: '11', dec: '12', december: '12',
  };

  // 1. YYYY-MM-DD
  let match = cleaned.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) {
    return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  }

  // 2. DD-MM-YYYY or MM-DD-YYYY
  match = cleaned.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) {
    const p1 = parseInt(match[1], 10);
    const p2 = parseInt(match[2], 10);
    if (p2 > 12) {
      // MM-DD-YYYY
      return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
    } else if (p1 > 12) {
      // DD-MM-YYYY
      return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
    } else {
      if (preferUSFormat) {
        // MM-DD-YYYY
        return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
      } else {
        // Default to DD-MM-YYYY (most common in India)
        return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
      }
    }
  }

  // 3. DD-MM-YY (two digit year)
  match = cleaned.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/);
  if (match) {
    const year = parseInt(match[3], 10) > 50 ? `19${match[3]}` : `20${match[3]}`;
    const p1 = parseInt(match[1], 10);
    const p2 = parseInt(match[2], 10);
    if (p2 > 12) {
      return `${year}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
    } else if (p1 > 12) {
      return `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
    } else {
      if (preferUSFormat) {
        return `${year}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
      } else {
        return `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
      }
    }
  }

  // 4. DD Month YYYY (e.g. 20 May 2026 or 20-May-2026)
  match = cleaned.match(/^(\d{1,2})[-/.\s]([A-Za-z]+)[-/.\s](\d{4})$/);
  if (match) {
    const m = months[match[2].toLowerCase()];
    if (m) {
      return `${match[3]}-${m}-${match[1].padStart(2, '0')}`;
    }
  }

  // 5. Month DD, YYYY (e.g. May 20, 2026 or May-20-2026)
  match = cleaned.match(/^([A-Za-z]+)[-/.\s](\d{1,2})(?:,)?[-/.\s](\d{4})$/);
  if (match) {
    const m = months[match[1].toLowerCase()];
    if (m) {
      return `${match[3]}-${m}-${match[2].padStart(2, '0')}`;
    }
  }

  // 6. Native JS Date parse fallback
  const d = new Date(cleaned);
  if (!isNaN(d.getTime())) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    if (yyyy >= 1990 && yyyy <= 2100) {
      return `${yyyy}-${mm}-${dd}`;
    }
  }

  return null;
}

function normalizeItem(item) {
  let rawGst = item?.gst;
  let gst = 0;
  if (typeof rawGst === 'number') {
    gst = rawGst;
  } else if (rawGst) {
    const cleanStr = String(rawGst).replace('%', '').trim();
    gst = parseFloat(cleanStr) || 0;
  }

  // If the model returned it as a fraction (e.g. 0.18 or 0.05 instead of 18 or 5), convert to percentage
  if (gst > 0 && gst <= 1) {
    gst = Math.round(gst * 100);
  }

  return {
    name: String(item?.name || '').trim(),
    quantity: Number(item?.quantity) || 0,
    unit: String(item?.unit || '').trim(),
    price: Number(item?.price) || 0,
    gst: gst,
    discount: Number(item?.discount) || 0,
    amount: Number(item?.amount) || 0,
    hsnCode: String(item?.hsnCode || '').trim(),
  };
}

function normalizeInvoiceResult(parsed, fileName, rawText, options = {}) {
  const {
    model = NVIDIA_MODEL,
    provider = 'nvidia-openai-compatible',
    parsedWithAI = true,
    extraWarnings = [],
  } = options;

  const items = Array.isArray(parsed?.items)
    ? parsed.items.map(normalizeItem).filter(item => item.name)
    : [];

  const parsedInvoiceNo = String(parsed?.invoiceNumber || '').trim() || null;
  let parsedInvoiceDate = formatToStandardDate(parsed?.invoiceDate, false) || String(parsed?.invoiceDate || '').trim() || null;
  let parsedDueDate = formatToStandardDate(parsed?.dueDate, false) || String(parsed?.dueDate || '').trim() || null;
  let parsedPoDate = formatToStandardDate(parsed?.poDate, false) || String(parsed?.poDate || '').trim() || null;

  // Self-heal date format ambiguity if it results in chronology error
  if (parsedInvoiceDate && parsedDueDate) {
    const iDate = new Date(parsedInvoiceDate);
    const dDate = new Date(parsedDueDate);
    if (!isNaN(iDate.getTime()) && !isNaN(dDate.getTime()) && dDate < iDate) {
      // Chronology error! Try parsing both as US format (MM-DD-YYYY) to see if it fixes the chronology
      const usInvoiceDate = formatToStandardDate(parsed?.invoiceDate, true);
      const usDueDate = formatToStandardDate(parsed?.dueDate, true);
      if (usInvoiceDate && usDueDate) {
        const iDateUS = new Date(usInvoiceDate);
        const dDateUS = new Date(usDueDate);
        if (!isNaN(iDateUS.getTime()) && !isNaN(dDateUS.getTime()) && dDateUS >= iDateUS) {
          parsedInvoiceDate = usInvoiceDate;
          parsedDueDate = usDueDate;
          if (parsed?.poDate) {
            const usPoDate = formatToStandardDate(parsed?.poDate, true);
            if (usPoDate) parsedPoDate = usPoDate;
          }
        }
      }
    }
  }

  let vendorGST = String(parsed?.vendorGST || '').trim() || null;
  let clientGST = String(parsed?.clientGST || '').trim() || null;

  const parsedSubTotal = parsed?.subTotal !== undefined && parsed?.subTotal !== null ? Number(parsed.subTotal) : null;
  const parsedTaxAmount = parsed?.taxAmount !== undefined && parsed?.taxAmount !== null ? Number(parsed.taxAmount) : 0;
  const roundOff = parsed?.roundOff !== undefined && parsed?.roundOff !== null ? Number(parsed.roundOff) : 0;
  const parsedTotalAmount = parsed?.totalAmount !== undefined && parsed?.totalAmount !== null ? Number(parsed.totalAmount) : null;

  let confidence = Math.max(0, Math.min(100, Number(parsed?.confidence) || 0));
  let status = ['auto-approved', 'needs-review', 'low-confidence', 'rejected'].includes(parsed?.status)
    ? parsed.status
    : 'needs-review';
  const errors = Array.isArray(parsed?.errors) ? parsed.errors.map(err => String(err || '').trim()).filter(Boolean) : [];
  const warnings = [
    ...(Array.isArray(parsed?.warnings) ? parsed.warnings.map(warn => String(warn || '').trim()).filter(Boolean) : []),
    ...extraWarnings,
  ];

  // 1. Mandatory Document Number Check
  if (!parsedInvoiceNo) {
    warnings.push("Missing document number (e.g. invoice or bill reference).");
    status = 'needs-review';
    confidence = Math.max(0, confidence - 10);
  }

  // 2. Date Chronology Validation
  if (parsedInvoiceDate && parsedDueDate) {
    const iDate = new Date(parsedInvoiceDate);
    const dDate = new Date(parsedDueDate);
    if (!isNaN(iDate.getTime()) && !isNaN(dDate.getTime()) && dDate < iDate) {
      warnings.push(`Extracted due date (${parsedDueDate}) is chronologically before the invoice date (${parsedInvoiceDate}).`);
      status = 'needs-review';
      confidence = Math.max(0, confidence - 15);
    }
  }

  // 3. Indian GSTIN structural validation (15-character alphanumeric format check) and self-cleaning
  const gstRegex = /^\d{2}[A-Z0-9]{13}$/i;
  if (vendorGST && !gstRegex.test(vendorGST)) {
    warnings.push(`Extracted vendor GSTIN "${vendorGST}" is structurally invalid (must be 15 alphanumeric characters).`);
    status = 'needs-review';
    confidence = Math.max(0, confidence - 5);
    vendorGST = null; // Clean up invalid vendor GSTIN
  }
  if (clientGST && !gstRegex.test(clientGST)) {
    warnings.push(`Extracted client GSTIN "${clientGST}" is structurally invalid (must be 15 alphanumeric characters).`);
    status = 'needs-review';
    confidence = Math.max(0, confidence - 5);
    clientGST = null; // Clean up invalid client GSTIN
  }

  // 3.5. Payment Mode credit term validation and self-cleaning
  let paymentMode = String(parsed?.paymentMode || '').trim() || null;
  if (paymentMode) {
    const isCreditTerm = /\b\d+\s*days?\b/i.test(paymentMode) ||
                         /net\s*\d+/i.test(paymentMode) ||
                         /due\s*on\s*receipt/i.test(paymentMode) ||
                         /immediate/i.test(paymentMode) ||
                         /payment\s*terms?/i.test(paymentMode);
    if (isCreditTerm) {
      paymentMode = null; // Clean up terms leaking into payment mode
    }
  }

  // 4. Line Items & Totals Mathematical Audit
  let calculatedSubTotal = 0;
  let calculatedTaxAmount = 0;

  items.forEach((item) => {
    const qty = Number(item.quantity) || 0;
    const price = Number(item.price) || 0;
    const discount = Number(item.discount) || 0;
    let gstRate = Number(item.gst) || 0;

    // Self-heal GST Rate from item amount and price (for CGST/SGST split representation, e.g. 9% SGST + 9% CGST = 18% total)
    const reportedAmount = Number(item.amount) || 0;
    const itemTaxable = qty * price * (1 - discount / 100);
    if (itemTaxable > 0 && reportedAmount > itemTaxable) {
      const calculatedTax = reportedAmount - itemTaxable;
      const impliedGstRate = (calculatedTax / itemTaxable) * 100;
      
      const standardRates = [5, 12, 18, 28];
      for (const r of standardRates) {
        if (Math.abs(impliedGstRate - r) < 0.5) {
          if (Math.abs(gstRate * 2 - r) < 0.5 || gstRate === 0 || Math.abs(gstRate - r) > 0.5) {
            gstRate = r;
            item.gst = r;
          }
          break;
        }
      }
    }

    calculatedSubTotal += itemTaxable;

    // Calculate tax: itemTaxable * gstRate / 100
    const itemTax = (itemTaxable * gstRate) / 100;
    calculatedTaxAmount += itemTax;

    // Recalculate item.amount if parsed amount deviates drastically
    const calculatedItemTotal = Math.round((itemTaxable + itemTax) * 100) / 100;
    const reportedItemAmount = Number(item.amount) || 0;
    if (reportedItemAmount > 0 && Math.abs(reportedItemAmount - calculatedItemTotal) > 2) {
      item.amount = calculatedItemTotal; // self-heal item total
    }
  });

  calculatedSubTotal = Math.round(calculatedSubTotal * 100) / 100;
  calculatedTaxAmount = Math.round(calculatedTaxAmount * 100) / 100;
  const calculatedGrandTotal = Math.round((calculatedSubTotal + calculatedTaxAmount + roundOff) * 100) / 100;

  // Resolve Subtotal
  const finalSubTotal = parsedSubTotal !== null && parsedSubTotal > 0 ? parsedSubTotal : calculatedSubTotal;
  if (parsedSubTotal !== null && Math.abs(parsedSubTotal - calculatedSubTotal) > 2) {
    warnings.push(`Reported subtotal (₹${parsedSubTotal}) differs from sum of line items (₹${calculatedSubTotal.toFixed(2)}).`);
    status = 'needs-review';
    confidence = Math.max(0, confidence - 10);
  }

  // Resolve Tax Amount
  let resolvedTaxAmount = parsedTaxAmount;
  if (resolvedTaxAmount !== null && calculatedTaxAmount > 0) {
    const ratio = resolvedTaxAmount / calculatedTaxAmount;
    // Case 1: parsedTaxAmount is roughly half of calculatedTaxAmount (CGST/SGST split, e.g. 0.4 to 0.6 to capture OCR errors like 11185.74 misread as 11815.74)
    if (ratio >= 0.4 && ratio <= 0.6) {
      resolvedTaxAmount = calculatedTaxAmount;
    }
    // Case 2: parsedTaxAmount is close to calculatedTaxAmount (minor rounding/OCR mismatch, within 10%)
    else if (Math.abs(resolvedTaxAmount - calculatedTaxAmount) <= calculatedTaxAmount * 0.1) {
      resolvedTaxAmount = calculatedTaxAmount;
    }
  }

  const finalTaxAmount = resolvedTaxAmount !== null ? resolvedTaxAmount : calculatedTaxAmount;
  if (resolvedTaxAmount !== null && Math.abs(resolvedTaxAmount - calculatedTaxAmount) > 2) {
    warnings.push(`Reported tax total (₹${resolvedTaxAmount}) differs from calculated item taxes (₹${calculatedTaxAmount.toFixed(2)}).`);
    status = 'needs-review';
    confidence = Math.max(0, confidence - 10);
  }

  // Resolve Grand Total
  const finalTotalAmount = parsedTotalAmount !== null && parsedTotalAmount > 0 ? parsedTotalAmount : calculatedGrandTotal;
  if (parsedTotalAmount !== null && Math.abs(parsedTotalAmount - calculatedGrandTotal) > 2) {
    warnings.push(`Financial discrepancy: parsed grand total is ₹${parsedTotalAmount}, but mathematical sum (Subtotal + Tax + Roundoff) is ₹${calculatedGrandTotal.toFixed(2)}.`);
    status = 'needs-review';
    confidence = Math.max(0, confidence - 20);
  }

  return {
    invoiceNumber: parsedInvoiceNo,
    invoiceDate: parsedInvoiceDate,
    dueDate: parsedDueDate,
    vendorName: String(parsed?.vendorName || '').trim() || null,
    vendorGST: vendorGST,
    vendorAddress: String(parsed?.vendorAddress || '').trim() || null,
    vendorAddressObject: {
      line1: String(parsed?.vendorAddressObject?.line1 || '').trim() || null,
      line2: String(parsed?.vendorAddressObject?.line2 || '').trim() || null,
      city: String(parsed?.vendorAddressObject?.city || '').trim() || null,
      state: String(parsed?.vendorAddressObject?.state || '').trim() || null,
      zip: String(parsed?.vendorAddressObject?.zip || '').trim() || null,
      country: String(parsed?.vendorAddressObject?.country || 'India').trim() || 'India'
    },
    vendorPhone: String(parsed?.vendorPhone || '').trim() || null,
    vendorEmail: String(parsed?.vendorEmail || '').trim() || null,
    vendorPAN: String(parsed?.vendorPAN || '').trim() || null,
    clientName: String(parsed?.clientName || '').trim() || null,
    clientGST: clientGST,
    placeOfSupply: String(parsed?.placeOfSupply || '').trim() || null,
    items,
    subTotal: finalSubTotal,
    taxAmount: finalTaxAmount,
    roundOff,
    totalAmount: finalTotalAmount,
    paymentMode: paymentMode,
    poNumber: String(parsed?.poNumber || '').trim() || null,
    poDate: parsedPoDate,
    confidence,
    status,
    errors,
    warnings,
    metadata: {
      fileName,
      itemsCount: items.length,
      processingTime: String(parsed?.metadata?.processingTime || ''),
      totalLines: Number(parsed?.metadata?.totalLines) || String(rawText || '').split('\n').filter(Boolean).length,
      model,
      provider,
      parsedWithAI,
    },
  };
}

function buildBuiltInFallback(rawText, fileName, warningMessage) {
  const fallback = parseInvoice(rawText, fileName);
  return {
    ...fallback,
    warnings: [
      ...(fallback.warnings || []),
      warningMessage,
    ],
    metadata: {
      ...fallback.metadata,
      provider: 'built-in-parser',
      parsedWithAI: false,
    },
  };
}

function buildRejectedScannedResult(fileName, errorMessage, warningMessage = '') {
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
    errors: [errorMessage].filter(Boolean),
    warnings: [warningMessage].filter(Boolean),
    metadata: {
      fileName,
      itemsCount: 0,
      processingTime: '',
      totalLines: 0,
      model: NVIDIA_VISION_MODEL,
      provider: 'nvidia-vision',
      parsedWithAI: true,
    },
  };
}

async function callNvidiaChat({ model, messages, maxTokens = 2200, timeoutMs }) {
  const apiKey = process.env.NVIDIA_API_KEY;
  const response = await axios.post(
    `${NVIDIA_BASE_URL}/chat/completions`,
    {
      model,
      messages,
      temperature: 0.1,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      stream: false,
    },
    {
      timeout: timeoutMs,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return response?.data?.choices?.[0]?.message?.content || '{}';
}

async function parseInvoiceWithNvidia(rawText, fileName, options = {}) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    return buildBuiltInFallback(rawText, fileName, 'NVIDIA_API_KEY is missing. Used built-in parser instead.');
  }

  try {
    const content = await callNvidiaChat({
      model: NVIDIA_MODEL,
      messages: [{ role: 'user', content: buildInvoicePrompt(rawText, fileName, options) }],
      timeoutMs: Number(process.env.NVIDIA_INVOICE_TIMEOUT_MS || 30000),
    });
    const parsed = await parsePossiblyLooseInvoiceJson(content, fileName, options);
    return normalizeInvoiceResult(parsed, fileName, rawText, {
      model: NVIDIA_MODEL,
      provider: 'nvidia-openai-compatible',
      parsedWithAI: true,
    });
  } catch (error) {
    return buildBuiltInFallback(
      rawText,
      fileName,
      `AI parsing failed, used built-in parser instead: ${error.response?.data?.error?.message || error.message}`
    );
  }
}

async function parseScannedInvoicePdfWithNvidia(pdfBuffer, fileName, options = {}) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    return buildRejectedScannedResult(
      fileName,
      'No readable text found in the PDF and NVIDIA_API_KEY is missing, so OCR fallback is unavailable.'
    );
  }

  try {
    const rendered = await renderPdfPagesToImages(pdfBuffer, {
      maxPages: Number(process.env.NVIDIA_INVOICE_OCR_MAX_PAGES || 3),
      scale: Number(process.env.NVIDIA_INVOICE_OCR_SCALE || 1.4),
      maxDimension: Number(process.env.NVIDIA_INVOICE_OCR_MAX_DIMENSION || 1600),
    });

    if (!rendered.images.length) {
      return buildRejectedScannedResult(
        fileName,
        'No readable text found in the PDF and OCR fallback could not render any pages.'
      );
    }

    const content = await callNvidiaChat({
      model: NVIDIA_VISION_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: buildScannedInvoicePrompt(fileName, options) },
            ...rendered.images.map((image) => ({
              type: 'image_url',
              image_url: { url: image.dataUrl },
            })),
          ],
        },
      ],
      maxTokens: 2200,
      timeoutMs: Number(process.env.NVIDIA_INVOICE_VISION_TIMEOUT_MS || 45000),
    });

    const parsed = await parsePossiblyLooseInvoiceJson(content, fileName, options);
    const result = normalizeInvoiceResult(parsed, fileName, '', {
      model: NVIDIA_VISION_MODEL,
      provider: 'nvidia-vision',
      parsedWithAI: true,
      extraWarnings: [
        'The PDF had no readable embedded text, so OCR/vision parsing was used.',
        'Vision output was normalized into strict invoice JSON.',
      ],
    });

    result.metadata.renderedPages = rendered.renderedPages;
    result.metadata.totalPages = rendered.totalPages;
    return result;
  } catch (error) {
    return buildRejectedScannedResult(
      fileName,
      'No readable text found in the PDF and OCR fallback failed.',
      `Vision OCR failed: ${error.response?.data?.error?.message || error.message}`
    );
  }
}

module.exports = {
  parseInvoiceWithNvidia,
  parseScannedInvoicePdfWithNvidia,
};
