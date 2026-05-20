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
- GST rate ("gst" field in items) MUST be extracted as a percentage number between 0 and 100 (e.g., 5, 12, 18, or 28), NOT a decimal fraction (like 0.18) and NOT the calculated tax amount (like 180).
- If separate CGST (e.g., 9%) and SGST (e.g., 9%) rates are listed, combine/sum them to get the total total GST rate (e.g., 18) for the "gst" field.
- Dates should be YYYY-MM-DD when confidently known.
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
- Read the images carefully and use OCR-style reasoning to recover invoice fields and line items.
- GST rate ("gst" field in items) MUST be extracted as a percentage number between 0 and 100 (e.g., 5, 12, 18, or 28), NOT a decimal fraction (like 0.18) and NOT the calculated tax amount (like 180).
- If separate CGST (e.g., 9%) and SGST (e.g., 9%) rates are listed, combine/sum them to get the total total GST rate (e.g., 18) for the "gst" field.
- Dates should be YYYY-MM-DD when confidently known.
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
- Convert prose, markdown, bullets, or OCR notes into the JSON fields.
- GST rate ("gst" field in items) MUST be extracted as a percentage number between 0 and 100 (e.g., 5, 12, 18, or 28), NOT a decimal fraction (like 0.18) and NOT the calculated tax amount (like 180).
- If separate CGST (e.g., 9%) and SGST (e.g., 9%) rates are listed, combine/sum them to get the total total GST rate (e.g., 18) for the "gst" field.
- Dates should be YYYY-MM-DD when confidently known.
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

  return {
    invoiceNumber: String(parsed?.invoiceNumber || '').trim() || null,
    invoiceDate: String(parsed?.invoiceDate || '').trim() || null,
    dueDate: String(parsed?.dueDate || '').trim() || null,
    vendorName: String(parsed?.vendorName || '').trim() || null,
    vendorGST: String(parsed?.vendorGST || '').trim() || null,
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
    clientGST: String(parsed?.clientGST || '').trim() || null,
    placeOfSupply: String(parsed?.placeOfSupply || '').trim() || null,
    items,
    subTotal: Number(parsed?.subTotal) || (items.length > 0 ? Math.round(items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0) * 100) / 100 : null),
    taxAmount: Number(parsed?.taxAmount) || 0,
    roundOff: Number(parsed?.roundOff) || 0,
    totalAmount: Number(parsed?.totalAmount) || 0,
    paymentMode: String(parsed?.paymentMode || '').trim() || null,
    poNumber: String(parsed?.poNumber || '').trim() || null,
    poDate: String(parsed?.poDate || '').trim() || null,
    confidence: Math.max(0, Math.min(100, Number(parsed?.confidence) || 0)),
    status: ['auto-approved', 'needs-review', 'low-confidence', 'rejected'].includes(parsed?.status)
      ? parsed.status
      : 'needs-review',
    errors: Array.isArray(parsed?.errors) ? parsed.errors.map(err => String(err || '').trim()).filter(Boolean) : [],
    warnings: [
      ...(Array.isArray(parsed?.warnings) ? parsed.warnings.map(warn => String(warn || '').trim()).filter(Boolean) : []),
      ...extraWarnings,
    ],
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
