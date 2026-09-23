function numberToWords(num) {
  if (!num && num !== 0) return '';
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const inWords = (n) => {
    if (n < 20) return a[n];
    if (n < 100) return b[Math.floor(n / 10)] + (n % 10 ? ' ' + a[n % 10] : '');
    if (n < 1000) return a[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + inWords(n % 100) : '');
    if (n < 100000) return inWords(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + inWords(n % 1000) : '');
    if (n < 10000000) return inWords(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 ? ' ' + inWords(n % 100000) : '');
    return inWords(Math.floor(n / 10000000)) + ' Crore' + (n % 10000000 ? ' ' + inWords(n % 10000000) : '');
  };
  return (inWords(Math.floor(num)) + ' Only').trim();
}

function fmt(num) {
  return (Number(num) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '—';
  return `${String(dt.getDate()).padStart(2, '0')}-${dt.toLocaleString('en-IN', { month: 'short' })}-${dt.getFullYear()}`;
}

const fmtDate = formatDate;

function addrStr(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  return [a.line1, a.line2, [a.city, a.state ? `(${a.state})` : null, a.zip].filter(Boolean).join(' '), a.country]
    .filter(Boolean)
    .join(', ');
}

/**
 * Builds responsive, email-client-friendly HTML for an invoice notification.
 */
function buildInvoiceEmailHtml({ invoice, settings, customMessage = '' }) {
  const company = settings || {};
  const client = invoice.client || {};
  const companyName = company.companyName || 'Flance';
  const clientName = client.name || invoice.clientName || 'Valued Customer';
  const invoiceNo = invoice.invoiceNo || 'INV';
  const invType = invoice.invoiceType || 'Tax Invoice';
  const grandTotal = Number(invoice.grandTotal) || 0;
  const balanceDue = Number(invoice.balanceDue) || 0;
  const advancePaid = Number(invoice.advancePaid) || 0;
  const amountDue = advancePaid > 0 ? Math.max(0, grandTotal - advancePaid) : (balanceDue > 0 ? balanceDue : grandTotal);
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const bank = invoice.bankDetails || company.bankDetails || {};
  const logoUrl = (company.showLogoOnDocuments !== false && (company.logoUrl || company.logo)) ? (company.logoUrl || company.logo) : null;

  const itemsRows = items.map((it, idx) => `
    <tr style="border-bottom: 1px solid #f1f5f9;">
      <td style="padding: 10px 12px; font-size: 13px; color: #1e293b;">
        <strong>${it.name || it.description || `Item ${idx + 1}`}</strong>
        ${it.description && it.name && it.description !== it.name ? `<div style="font-size: 11px; color: #64748b; margin-top: 2px;">${it.description}</div>` : ''}
      </td>
      <td style="padding: 10px 8px; font-size: 13px; color: #475569; text-align: center;">${it.quantity || 1} ${it.unit || ''}</td>
      <td style="padding: 10px 8px; font-size: 13px; color: #475569; text-align: right; font-family: monospace;">₹${fmt(it.price || it.rate)}</td>
      <td style="padding: 10px 12px; font-size: 13px; color: #0f172a; text-align: right; font-weight: 600; font-family: monospace;">₹${fmt(it.total || ((it.quantity || 1) * (it.price || it.rate)))}</td>
    </tr>
  `).join('');

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>${invType} #${invoiceNo}</title>
    </head>
    <body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; color: #1e293b;">
      <table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #f8fafc; padding: 32px 16px;">
        <tr>
          <td align="center">
            <table width="100%" border="0" cellpadding="0" cellspacing="0" style="max-width: 620px; background-color: #ffffff; border-radius: 20px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.05);">
              
              <!-- Header -->
              <tr>
                <td style="padding: 28px 32px; border-bottom: 1px solid #f1f5f9; background: #ffffff;">
                  <table width="100%" border="0" cellpadding="0" cellspacing="0">
                    <tr>
                      <td valign="middle">
                        ${logoUrl ? `<img src="${logoUrl}" alt="${companyName}" style="max-height: 44px; max-width: 160px; object-fit: contain; display: block; margin-bottom: 8px;">` : ''}
                        <h2 style="margin: 0; font-size: 20px; font-weight: 700; color: #0f172a; letter-spacing: -0.3px;">${companyName}</h2>
                        ${company.phone ? `<div style="font-size: 12px; color: #64748b; margin-top: 3px;">📞 ${company.phone}</div>` : ''}
                        ${company.email ? `<div style="font-size: 12px; color: #64748b;">✉️ ${company.email}</div>` : ''}
                      </td>
                      <td valign="middle" align="right">
                        <div style="display: inline-block; background-color: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">
                          ${invType}
                        </div>
                        <div style="font-size: 18px; font-weight: 800; color: #0f172a; font-family: monospace;">#${invoiceNo}</div>
                        <div style="font-size: 12px; color: #64748b; margin-top: 2px;">Date: ${formatDate(invoice.date)}</div>
                        ${invoice.dueDate ? `<div style="font-size: 12px; color: #e11d48; font-weight: 600;">Due: ${formatDate(invoice.dueDate)}</div>` : ''}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Greeting & Note -->
              <tr>
                <td style="padding: 24px 32px 16px;">
                  <p style="margin: 0 0 12px; font-size: 14px; color: #334155; line-height: 1.5;">
                    Dear <strong>${clientName}</strong>,
                  </p>
                  <p style="margin: 0; font-size: 14px; color: #475569; line-height: 1.6;">
                    Please find attached your invoice <strong>#${invoiceNo}</strong> for recent services/products. A breakdown of the charges and payment instructions is provided below.
                  </p>
                  ${customMessage ? `
                    <div style="margin-top: 16px; padding: 14px 18px; background-color: #f8fafc; border-left: 4px solid #0d9488; border-radius: 8px; font-size: 13px; color: #334155; line-height: 1.5;">
                      ${customMessage.replace(/\n/g, '<br/>')}
                    </div>
                  ` : ''}
                </td>
              </tr>

              <!-- Amount Due Banner -->
              <tr>
                <td style="padding: 0 32px 20px;">
                  <div style="background: linear-gradient(135deg, #0f766e 0%, #0d9488 100%); border-radius: 14px; padding: 18px 24px; color: #ffffff;">
                    <table width="100%" border="0" cellpadding="0" cellspacing="0">
                      <tr>
                        <td>
                          <div style="font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.9;">Total Amount Due</div>
                          <div style="font-size: 26px; font-weight: 800; font-family: monospace; margin-top: 4px;">₹${fmt(amountDue)}</div>
                        </td>
                        <td align="right" valign="middle">
                          <div style="font-size: 12px; opacity: 0.85;">Invoice Status</div>
                          <div style="font-size: 14px; font-weight: 700; background: rgba(255,255,255,0.2); padding: 4px 12px; border-radius: 9999px; display: inline-block; margin-top: 4px;">
                            ${invoice.status || 'SENT'}
                          </div>
                        </td>
                      </tr>
                    </table>
                  </div>
                </td>
              </tr>

              <!-- Items Table -->
              <tr>
                <td style="padding: 0 32px 16px;">
                  <table width="100%" border="0" cellpadding="0" cellspacing="0" style="border-collapse: collapse; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                    <thead>
                      <tr style="background-color: #f8fafc; border-bottom: 1px solid #e2e8f0;">
                        <th align="left" style="padding: 10px 12px; font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Item</th>
                        <th align="center" style="padding: 10px 8px; font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; width: 60px;">Qty</th>
                        <th align="right" style="padding: 10px 8px; font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; width: 90px;">Rate</th>
                        <th align="right" style="padding: 10px 12px; font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; width: 100px;">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${itemsRows || '<tr><td colspan="4" style="padding: 12px; text-align: center; color: #94a3b8; font-size: 13px;">No items listed</td></tr>'}
                    </tbody>
                    <tfoot>
                      <tr style="background-color: #f8fafc; border-top: 2px solid #e2e8f0;">
                        <td colspan="3" align="right" style="padding: 8px 12px; font-size: 12px; color: #64748b; font-weight: 600;">Subtotal:</td>
                        <td align="right" style="padding: 8px 12px; font-size: 12px; font-weight: 700; font-family: monospace; color: #1e293b;">₹${fmt(invoice.subTotal || grandTotal)}</td>
                      </tr>
                      ${Number(invoice.totalCGST) > 0 ? `
                        <tr style="background-color: #f8fafc;">
                          <td colspan="3" align="right" style="padding: 4px 12px; font-size: 11px; color: #64748b;">CGST:</td>
                          <td align="right" style="padding: 4px 12px; font-size: 11px; font-family: monospace; color: #334155;">₹${fmt(invoice.totalCGST)}</td>
                        </tr>
                      ` : ''}
                      ${Number(invoice.totalSGST) > 0 ? `
                        <tr style="background-color: #f8fafc;">
                          <td colspan="3" align="right" style="padding: 4px 12px; font-size: 11px; color: #64748b;">SGST:</td>
                          <td align="right" style="padding: 4px 12px; font-size: 11px; font-family: monospace; color: #334155;">₹${fmt(invoice.totalSGST)}</td>
                        </tr>
                      ` : ''}
                      ${Number(invoice.totalIGST) > 0 ? `
                        <tr style="background-color: #f8fafc;">
                          <td colspan="3" align="right" style="padding: 4px 12px; font-size: 11px; color: #64748b;">IGST:</td>
                          <td align="right" style="padding: 4px 12px; font-size: 11px; font-family: monospace; color: #334155;">₹${fmt(invoice.totalIGST)}</td>
                        </tr>
                      ` : ''}
                      ${Number(invoice.shippingCharges) > 0 ? `
                        <tr style="background-color: #f8fafc;">
                          <td colspan="3" align="right" style="padding: 4px 12px; font-size: 11px; color: #64748b;">Shipping:</td>
                          <td align="right" style="padding: 4px 12px; font-size: 11px; font-family: monospace; color: #334155;">₹${fmt(invoice.shippingCharges)}</td>
                        </tr>
                      ` : ''}
                      ${Number(invoice.discountTotal) > 0 ? `
                        <tr style="background-color: #f8fafc;">
                          <td colspan="3" align="right" style="padding: 4px 12px; font-size: 11px; color: #059669;">Discount:</td>
                          <td align="right" style="padding: 4px 12px; font-size: 11px; font-family: monospace; color: #059669;">- ₹${fmt(invoice.discountTotal)}</td>
                        </tr>
                      ` : ''}
                      <tr style="background-color: #f1f5f9; border-top: 1px solid #cbd5e1;">
                        <td colspan="3" align="right" style="padding: 10px 12px; font-size: 13px; font-weight: 800; color: #0f172a;">Grand Total:</td>
                        <td align="right" style="padding: 10px 12px; font-size: 14px; font-weight: 800; font-family: monospace; color: #0f172a;">₹${fmt(grandTotal)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </td>
              </tr>

              <!-- Bank Details for Remittance -->
              ${(bank.accountNumber || bank.bankName) ? `
                <tr>
                  <td style="padding: 0 32px 20px;">
                    <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px 18px;">
                      <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;">
                        🏦 Bank Details for Remittance
                      </div>
                      <table width="100%" border="0" cellpadding="0" cellspacing="0" style="font-size: 12px; color: #334155;">
                        ${bank.accountName ? `<tr><td style="padding: 2px 0; color: #64748b; width: 35%;">Account Holder:</td><td style="padding: 2px 0; font-weight: 600;">${bank.accountName}</td></tr>` : ''}
                        ${bank.bankName ? `<tr><td style="padding: 2px 0; color: #64748b;">Bank Name:</td><td style="padding: 2px 0; font-weight: 600;">${bank.bankName}</td></tr>` : ''}
                        ${bank.accountNumber ? `<tr><td style="padding: 2px 0; color: #64748b;">Account Number:</td><td style="padding: 2px 0; font-weight: 700; font-family: monospace;">${bank.accountNumber}</td></tr>` : ''}
                        ${bank.ifscCode ? `<tr><td style="padding: 2px 0; color: #64748b;">IFSC Code:</td><td style="padding: 2px 0; font-weight: 700; font-family: monospace;">${bank.ifscCode}</td></tr>` : ''}
                        ${bank.branch ? `<tr><td style="padding: 2px 0; color: #64748b;">Branch:</td><td style="padding: 2px 0;">${bank.branch}</td></tr>` : ''}
                      </table>
                    </div>
                  </td>
                </tr>
              ` : ''}

              <!-- Terms & Attachment Notice -->
              <tr>
                <td style="padding: 0 32px 28px; font-size: 12px; color: #64748b; line-height: 1.5;">
                  <div style="padding-top: 14px; border-top: 1px solid #f1f5f9;">
                    📎 <em>A PDF copy of this invoice has been attached to this email for your accounting records.</em>
                  </div>
                  ${invoice.terms ? `
                    <div style="margin-top: 10px;">
                      <strong>Terms & Conditions:</strong><br/>
                      <span style="font-size: 11px;">${invoice.terms.replace(/\n/g, '<br/>')}</span>
                    </div>
                  ` : ''}
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="padding: 16px 32px; background-color: #f8fafc; border-top: 1px solid #e2e8f0; text-align: center;">
                  <p style="margin: 0; font-size: 11px; color: #94a3b8;">
                    This is an automated invoice communication sent via <strong>${companyName}</strong> through Flance Workspace.
                  </p>
                </td>
              </tr>

            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}

/**
 * Builds A4 print layout HTML matching the official Indian GST print template (ClassicTemplate).
 */
function buildClassicInvoicePdfHtml({ invoice, settings }) {
  const company = settings || {};
  const client = invoice.client || {};
  const companyName = company.companyName || 'Flance';
  const companyPAN = (company.pan || (company.gstin && company.gstin.length >= 12 ? company.gstin.substring(2, 12) : '') || '').toUpperCase();
  const companyAddr = addrStr(company.address);
  const clientAddr = addrStr(client.address || invoice.billingAddress);
  const shipAddr = invoice.shippingAddress?.line1
    ? addrStr(invoice.shippingAddress)
    : (client.shippingAddress?.line1 ? addrStr(client.shippingAddress) : clientAddr);
  const invoiceNo = invoice.invoiceNo || 'INV';
  const invType = invoice.invoiceType || 'Tax Invoice';
  const grandTotal = Number(invoice.grandTotal) || 0;
  const bank = invoice.bankDetails || company.bankDetails || {};
  const hasTax = invType === 'Tax Invoice' || invType === 'Excise Invoice' || (Number(invoice.totalCGST) > 0 || Number(invoice.totalIGST) > 0);
  const isIntra = (Number(invoice.totalIGST) || 0) === 0;

  const safeItems = (Array.isArray(invoice.items) && invoice.items.length)
    ? invoice.items.map(it => {
        const qty = Number(it.quantity ?? it.qty ?? 0);
        const rate = Number(it.price ?? it.rate ?? 0);
        const discount = Number(it.discount ?? it.discountPercent ?? 0);
        const listPrice = Number(it.listPrice ?? it.mrp ?? it.listRate ?? it.listAmount ?? 0) || 0;
        const taxable = qty * rate * (1 - discount / 100);
        const amount = Number(it.total ?? it.amount ?? taxable);
        const taxRate = Number(it.taxRate ?? it.gstRate ?? it.tax ?? 0);
        const cgst = Number(it.cgst ?? (taxRate ? (taxable * (taxRate / 2) / 100) : 0));
        const sgst = Number(it.sgst ?? (taxRate ? (taxable * (taxRate / 2) / 100) : 0));
        const igst = Number(it.igst ?? 0);
        return {
          name: it.name || it.description || '',
          description: it.description || '',
          hsnCode: it.hsnCode || it.sacCode || '',
          qty,
          unit: it.unit || '',
          listPrice,
          discount,
          rate,
          amount,
          taxRate,
          cgst,
          sgst,
          igst,
        };
      })
    : [{ name: '', description: '', hsnCode: '', qty: 0, unit: '', listPrice: 0, discount: 0, rate: 0, amount: 0, taxRate: 0, cgst: 0, sgst: 0, igst: 0 }];

  const totalQty = safeItems.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
  const summaryUnit = safeItems.find((item) => item.unit)?.unit || 'Units';
  const distinctTaxRates = [...new Set(safeItems.map((item) => Number(item.taxRate) || 0).filter((rate) => rate > 0))];
  const uniformTaxRate = distinctTaxRates.length === 1 ? distinctTaxRates[0] : null;
  const fillerHeight = Math.max(60, Math.min(300, 320 - safeItems.length * 46));

  const taxSummaryRows = Object.values(safeItems.reduce((acc, item) => {
    const rate = Number(item.taxRate) || 0;
    const qty = Number(item.qty) || 0;
    const unitRate = Number(item.rate) || 0;
    const discountPct = Number(item.discount) || 0;
    const taxable = qty * unitRate * (1 - discountPct / 100);
    const key = `${item.hsnCode || '-'}__${rate}`;
    if (!acc[key]) {
      acc[key] = {
        hsnCode: item.hsnCode || '-',
        taxRate: rate,
        taxable: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
      };
    }
    acc[key].taxable += taxable;
    acc[key].cgst += Number(item.cgst) || 0;
    acc[key].sgst += Number(item.sgst) || 0;
    acc[key].igst += Number(item.igst) || 0;
    return acc;
  }, {}));

  const adjustmentRows = [
    ...(hasTax && isIntra ? [
      { label: 'Add', name: 'CGST', rate: uniformTaxRate ? `${fmt(uniformTaxRate / 2)} %` : '', amount: Number(invoice.totalCGST) || 0 },
      { label: 'Add', name: 'SGST', rate: uniformTaxRate ? `${fmt(uniformTaxRate / 2)} %` : '', amount: Number(invoice.totalSGST) || 0 },
    ] : []),
    ...(hasTax && !isIntra ? [
      { label: 'Add', name: 'IGST', rate: uniformTaxRate ? `${fmt(uniformTaxRate)} %` : '', amount: Number(invoice.totalIGST) || 0 },
    ] : []),
    ...(Number(invoice.shippingCharges) > 0 ? [
      { label: 'Add', name: 'Shipping', rate: '', amount: Number(invoice.shippingCharges) || 0 },
    ] : []),
    ...(Number(invoice.packagingCharges) > 0 ? [
      { label: 'Add', name: invoice.customChargeLabel || 'Custom Charge', rate: '', amount: Number(invoice.packagingCharges) || 0 },
    ] : []),
    ...(Number(invoice.discountTotal) > 0 ? [
      { label: 'Less', name: 'Discount', rate: '', amount: Number(invoice.discountTotal) || 0 },
    ] : []),
  ];

  const signatureUrl = (company.signatureEnabled !== false && company.showSignatureOnInvoices !== false && (company.signatureUrl || company.signature))
    ? (company.signatureUrl || company.signature)
    : null;

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>${invType} #${invoiceNo}</title>
      <style>
        @page {
          size: A4;
          margin: 6mm 8mm;
        }
        * {
          box-sizing: border-box;
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }
        body {
          margin: 0;
          padding: 0;
          background: #fff;
          font-family: Arial, Helvetica, sans-serif;
          font-size: 11px;
          color: #111;
          -webkit-font-smoothing: antialiased;
        }
        .classic-container {
          width: 100%;
          max-width: 790px;
          margin: 0 auto;
          border: 1px solid #000;
          background: #fff;
        }
        table {
          width: 100%;
          border-collapse: collapse;
        }
        .th-cell {
          border-right: 1px solid #000;
          border-bottom: 1px solid #000;
          padding: 6px 4px;
          font-weight: 700;
          font-size: 11px;
          vertical-align: top;
        }
        .td-cell {
          border-right: 1px solid #000;
          padding: 6px 4px;
          vertical-align: top;
          font-size: 11px;
        }
        .no-border-r {
          border-right: none !important;
        }
      </style>
    </head>
    <body>
      <div class="classic-container">
        <!-- Top GSTIN & Original Copy Header -->
        <div style="display: flex; justify-content: space-between; padding: 8px 12px 6px; font-size: 13px; font-weight: 700;">
          <div>GSTIN&nbsp; :&nbsp; ${company.gstin || ''}</div>
          <div style="font-weight: 400; font-style: italic;">Original Copy</div>
        </div>

        <!-- Centered Company Header -->
        <div style="text-align: center; padding: 0 20px 8px;">
          <div style="display: inline-block; font-size: 12px; font-weight: 700; text-decoration: underline; text-underline-offset: 3px; margin-bottom: 3px;">
            ${invType.toUpperCase()}
          </div>
          <div style="font-size: 22px; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; line-height: 1.15;">
            ${companyName}
          </div>
          ${companyAddr ? `<div style="font-size: 12px; margin-top: 2px;">${companyAddr}</div>` : ''}
          ${company.phone ? `<div style="font-size: 12px;">${company.phone}</div>` : ''}
          ${companyPAN ? `<div style="font-size: 12px;">PAN : ${companyPAN}</div>` : ''}
        </div>

        <!-- Two-column: Invoice No & Date / Place of Supply & Reverse Charge -->
        <table style="border-top: 1px solid #000; border-bottom: 1px solid #000;">
          <tr>
            <td style="width: 50%; border-right: 1px solid #000; padding: 8px 12px; vertical-align: top; font-size: 13px;">
              <table style="width: 100%;">
                <tr>
                  <td style="width: 120px;">Invoice No.</td>
                  <td style="width: 15px;">:</td>
                  <td><strong>${invoiceNo}</strong></td>
                </tr>
                <tr>
                  <td>Dated</td>
                  <td>:</td>
                  <td>${fmtDate(invoice.date)}</td>
                </tr>
              </table>
            </td>
            <td style="width: 50%; padding: 8px 12px; vertical-align: top; font-size: 13px;">
              <table style="width: 100%;">
                <tr>
                  <td style="width: 130px;">Place of Supply</td>
                  <td style="width: 15px;">:</td>
                  <td>${invoice.placeOfSupply || client.address?.state || ''}</td>
                </tr>
                <tr>
                  <td>Reverse Charge</td>
                  <td>:</td>
                  <td>${invoice.reverseCharge ? 'Y' : 'N'}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Two-column: Billed to / Shipped to -->
        <table style="border-bottom: 1px solid #000;">
          <tr>
            <td style="width: 50%; border-right: 1px solid #000; padding: 8px 12px; vertical-align: top; min-height: 125px;">
              <div style="font-size: 14px; font-weight: 700; font-style: italic; margin-bottom: 2px;">Billed to&nbsp;&nbsp;&nbsp; :</div>
              <div style="font-size: 13px; font-weight: 600; line-height: 1.25;">${client.name || invoice.clientName || ''}</div>
              <div style="font-size: 12px; line-height: 1.35; white-space: pre-wrap; margin-top: 2px;">${clientAddr}</div>
              <div style="font-size: 12px; margin-top: 28px;">
                <span style="display: inline-block; width: 110px;">GSTIN / UIN</span>&nbsp;:&nbsp; <span>${client.gstin || ''}</span>
              </div>
            </td>
            <td style="width: 50%; padding: 8px 12px; vertical-align: top; min-height: 125px;">
              <div style="font-size: 14px; font-weight: 700; font-style: italic; margin-bottom: 2px;">Shipped to&nbsp;&nbsp; :</div>
              <div style="font-size: 13px; font-weight: 600; line-height: 1.25;">${client.name || invoice.clientName || ''}</div>
              <div style="font-size: 12px; line-height: 1.35; white-space: pre-wrap; margin-top: 2px;">${shipAddr}</div>
              <div style="font-size: 12px; margin-top: 28px;">
                <span style="display: inline-block; width: 110px;">GSTIN / UIN</span>&nbsp;:&nbsp; <span>${client.gstin || ''}</span>
              </div>
            </td>
          </tr>
        </table>

        <!-- Items Table -->
        <table style="table-layout: fixed;">
          <thead>
            <tr>
              <th class="th-cell" style="width: 4.5%; text-align: center;">S.N.</th>
              <th class="th-cell" style="width: 27%; text-align: left;">Description of Goods</th>
              <th class="th-cell" style="width: 9.5%; text-align: left;">HSN/SAC<br/>Code</th>
              <th class="th-cell" style="width: 7%; text-align: right;">Qty.</th>
              <th class="th-cell" style="width: 6%; text-align: left;">Unit</th>
              <th class="th-cell" style="width: 11%; text-align: right;">List Price</th>
              <th class="th-cell" style="width: 9%; text-align: left;">Discount</th>
              <th class="th-cell" style="width: 11%; text-align: right;">Price</th>
              <th class="th-cell no-border-r" style="width: 15%; text-align: right;">Amount(₹)</th>
            </tr>
          </thead>
          <tbody>
            ${safeItems.map((item, index) => `
              <tr>
                <td class="td-cell" style="text-align: right;">${item.name ? `${index + 1}.` : ''}</td>
                <td class="td-cell">
                  <div style="font-weight: 600; font-size: 11.5px; line-height: 1.25;">${item.name}</div>
                  ${item.description ? `<div style="font-size: 10px; line-height: 1.3; color: #444; margin-top: 2px; padding-left: 10px; white-space: pre-wrap;">${item.description}</div>` : ''}
                </td>
                <td class="td-cell">${item.hsnCode || ''}</td>
                <td class="td-cell" style="text-align: right;">${item.name ? item.qty.toFixed(2) : ''}</td>
                <td class="td-cell">${item.unit || ''}</td>
                <td class="td-cell" style="text-align: right;">${item.name ? fmt(item.listPrice) : ''}</td>
                <td class="td-cell">${item.name ? `${fmt(item.discount)}%` : ''}</td>
                <td class="td-cell" style="text-align: right;">${item.name ? fmt(item.rate) : ''}</td>
                <td class="td-cell no-border-r" style="text-align: right;">${item.name ? fmt(item.amount) : ''}</td>
              </tr>
            `).join('')}
            ${fillerHeight > 0 ? `
              <tr>
                <td class="td-cell" style="height: ${fillerHeight}px; padding: 0;"></td>
                <td class="td-cell" style="height: ${fillerHeight}px; padding: 0;"></td>
                <td class="td-cell" style="height: ${fillerHeight}px; padding: 0;"></td>
                <td class="td-cell" style="height: ${fillerHeight}px; padding: 0;"></td>
                <td class="td-cell" style="height: ${fillerHeight}px; padding: 0;"></td>
                <td class="td-cell" style="height: ${fillerHeight}px; padding: 0;"></td>
                <td class="td-cell" style="height: ${fillerHeight}px; padding: 0;"></td>
                <td class="td-cell" style="height: ${fillerHeight}px; padding: 0;"></td>
                <td class="td-cell no-border-r" style="height: ${fillerHeight}px; padding: 0;"></td>
              </tr>
            ` : ''}
          </tbody>
        </table>

        <!-- Subtotal and Adjustments Box -->
        <table style="border-top: 1px solid #000; border-bottom: 1px solid #000;">
          <tr>
            <td style="width: 85%; padding: 6px 12px; vertical-align: top;">
              <table style="width: 100%;">
                <tr style="height: 18px;">
                  <td colspan="3">&nbsp;</td>
                </tr>
                ${adjustmentRows.map((row) => `
                  <tr>
                    <td style="text-align: right; font-size: 12px; padding: 2px 8px; width: 60%;">${row.label}</td>
                    <td style="text-align: left; font-size: 12px; padding: 2px 8px; width: 20%;">&nbsp;:&nbsp; ${row.name}</td>
                    <td style="text-align: right; font-size: 12px; padding: 2px 8px; width: 20%;">${row.rate ? `@ ${row.rate}` : fmt(Math.abs(row.amount))}</td>
                  </tr>
                `).join('')}
              </table>
            </td>
            <td style="width: 15%; border-left: 1px solid #000; padding: 6px 6px; text-align: right; vertical-align: top; font-size: 13px; font-weight: 700;">
              <div style="line-height: 18px;">${fmt(Number(invoice.subTotal) || grandTotal)}</div>
              ${adjustmentRows.map((row) => `
                <div style="font-size: 12px; font-weight: 400; line-height: 18px; padding: 2px 0;">
                  ${row.label === 'Less' ? '-' : ''}${fmt(Math.abs(row.amount))}
                </div>
              `).join('')}
            </td>
          </tr>
        </table>

        <!-- Grand Total Row -->
        <table style="border-bottom: 1px solid #000;">
          <tr>
            <td style="width: 85%; padding: 8px 16px; font-size: 13px; font-weight: 700; text-align: center;">
              Grand Total &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; ${fmt(totalQty)} ${summaryUnit}
            </td>
            <td style="width: 15%; border-left: 1px solid #000; padding: 8px 6px; text-align: right; font-size: 14px; font-weight: 700;">
              ${fmt(grandTotal)}
            </td>
          </tr>
        </table>

        <!-- HSN/SAC Breakdown Table -->
        ${hasTax ? `
          <div style="padding: 8px 12px 8px; border-bottom: 1px solid #000;">
            <table style="width: auto; min-width: 460px; font-size: 10px;">
              <thead>
                <tr>
                  <th style="padding: 3px 5px; text-align: left; font-weight: 700;"><span style="border-bottom: 1px solid #000; padding-bottom: 1px;">HSN/SAC</span></th>
                  <th style="padding: 3px 5px; text-align: left; font-weight: 700;"><span style="border-bottom: 1px solid #000; padding-bottom: 1px;">Tax Rate</span></th>
                  <th style="padding: 3px 5px; text-align: right; font-weight: 700;"><span style="border-bottom: 1px solid #000; padding-bottom: 1px;">Taxable Amt.</span></th>
                  ${isIntra ? `
                    <th style="padding: 3px 5px; text-align: right; font-weight: 700;"><span style="border-bottom: 1px solid #000; padding-bottom: 1px;">CGST Amt.</span></th>
                    <th style="padding: 3px 5px; text-align: right; font-weight: 700;"><span style="border-bottom: 1px solid #000; padding-bottom: 1px;">SGST Amt.</span></th>
                  ` : `
                    <th style="padding: 3px 5px; text-align: right; font-weight: 700;"><span style="border-bottom: 1px solid #000; padding-bottom: 1px;">IGST Amt.</span></th>
                  `}
                  <th style="padding: 3px 5px; text-align: right; font-weight: 700;"><span style="border-bottom: 1px solid #000; padding-bottom: 1px;">Total Tax</span></th>
                </tr>
              </thead>
              <tbody>
                ${(taxSummaryRows.length ? taxSummaryRows : [{
                  hsnCode: '-',
                  taxRate: uniformTaxRate || 0,
                  taxable: Number(invoice.subTotal) || 0,
                  cgst: Number(invoice.totalCGST) || 0,
                  sgst: Number(invoice.totalSGST) || 0,
                  igst: Number(invoice.totalIGST) || 0,
                }]).map(row => `
                  <tr>
                    <td style="padding: 3px 5px; text-align: left;">${row.hsnCode}</td>
                    <td style="padding: 3px 5px; text-align: left;">${row.taxRate ? `${row.taxRate}%` : '-'}</td>
                    <td style="padding: 3px 5px; text-align: right;">${fmt(row.taxable)}</td>
                    ${isIntra ? `
                      <td style="padding: 3px 5px; text-align: right;">${fmt(row.cgst)}</td>
                      <td style="padding: 3px 5px; text-align: right;">${fmt(row.sgst)}</td>
                    ` : `
                      <td style="padding: 3px 5px; text-align: right;">${fmt(row.igst)}</td>
                    `}
                    <td style="padding: 3px 5px; text-align: right;">${fmt((row.cgst || 0) + (row.sgst || 0) + (row.igst || 0))}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : ''}

        <!-- Amount in Words -->
        <div style="padding: 8px 12px; font-size: 13px; font-weight: 700; border-bottom: 1px solid #000;">
          Rupees ${numberToWords(Math.round(grandTotal))}
        </div>

        <!-- Bottom Terms, Bank & Signatory Box -->
        <table>
          <tr>
            <td style="width: 48%; border-right: 1px solid #000; padding: 8px 12px; vertical-align: top; min-height: 120px;">
              <div style="font-size: 11px; font-weight: 700; text-decoration: underline; text-underline-offset: 3px; margin-bottom: 3px;">
                Terms & Conditions
              </div>
              ${invoice.terms ? `
                <div style="font-size: 10.5px; line-height: 1.35; white-space: pre-wrap; margin-bottom: 8px; color: #333;">
                  ${invoice.terms}
                </div>
              ` : ''}
              ${(bank.bankName || bank.accountNumber) ? `
                <div style="margin-top: 4px;">
                  <div style="font-size: 11px; font-weight: 700; text-decoration: underline; text-underline-offset: 3px; margin-bottom: 3px;">
                    Bank Details
                  </div>
                  <div style="font-size: 10.5px; line-height: 1.4; color: #222;">
                    ${bank.accountName ? `<div><b>Account Holder:</b> ${bank.accountName.toUpperCase()}</div>` : ''}
                    ${bank.bankName ? `<div><b>Bank Name:</b> ${bank.bankName.toUpperCase()}</div>` : ''}
                    ${bank.accountNumber ? `<div><b>Account Number:</b> ${bank.accountNumber}</div>` : ''}
                    ${bank.branch ? `<div><b>Branch Name:</b> ${bank.branch.toUpperCase()}</div>` : ''}
                    ${bank.ifscCode ? `<div><b>IFSC Code:</b> ${bank.ifscCode}</div>` : ''}
                  </div>
                </div>
              ` : ''}
            </td>
            <td style="width: 52%; vertical-align: top; padding: 0;">
              <div style="border-bottom: 1px solid #000; padding: 8px 12px 28px; font-size: 12px; font-weight: 700;">
                Receiver's Signature&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;:
              </div>
              <div style="padding: 10px 14px 8px; min-height: 70px; display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between;">
                <div style="font-size: 12px; font-weight: 700;">for ${companyName}</div>
                ${signatureUrl ? `
                  <div style="margin: 4px 0; text-align: right;">
                    <img src="${signatureUrl}" alt="Signature" style="max-height: 44px; max-width: 140px; object-fit: contain; display: inline-block;" />
                    <div style="font-size: 9px; color: #666;">Digitally Signed</div>
                  </div>
                ` : `
                  <div style="margin: 6px 0; border: 1px dashed #000; padding: 6px 10px; background: #fafafa; font-size: 8.5px; text-align: center; line-height: 1.35; color: #333; max-width: 200px;">
                    <b>Digitally Signed Document</b><br />
                    This is a computer generated ${invType.toLowerCase()}, digitally signed, and does not require a physical signature.
                  </div>
                `}
                <div style="font-size: 12px; font-weight: 700; margin-top: 2px;">Authorised Signatory</div>
              </div>
            </td>
          </tr>
        </table>
      </div>
    </body>
    </html>
  `;
}

/**
 * Builds A4 print layout HTML matching ModernTemplate.
 */
function buildModernInvoicePdfHtml({ invoice, settings }) {
  const company = settings || {};
  const client = invoice.client || {};
  const companyName = company.companyName || 'Flance';
  const companyAddr = addrStr(company.address);
  const clientAddr = addrStr(client.address || invoice.billingAddress);
  const invoiceNo = invoice.invoiceNo || 'INV';
  const invType = invoice.invoiceType || 'Tax Invoice';
  const grandTotal = Number(invoice.grandTotal) || 0;
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const bank = invoice.bankDetails || company.bankDetails || {};
  const logoUrl = (company.showLogoOnDocuments !== false && (company.logoUrl || company.logo)) ? (company.logoUrl || company.logo) : null;

  const itemRowsHtml = items.map((it, idx) => `
    <tr>
      <td style="border: 1px solid #cbd5e1; padding: 6px 8px; text-align: center;">${idx + 1}</td>
      <td style="border: 1px solid #cbd5e1; padding: 6px 8px;">
        <strong>${it.name || it.description || ''}</strong>
        ${it.description && it.name && it.description !== it.name ? `<div style="font-size: 9px; color: #64748b;">${it.description}</div>` : ''}
      </td>
      <td style="border: 1px solid #cbd5e1; padding: 6px 8px; text-align: center;">${it.hsnCode || it.sacCode || '-'}</td>
      <td style="border: 1px solid #cbd5e1; padding: 6px 8px; text-align: center;">${it.quantity || 1} ${it.unit || ''}</td>
      <td style="border: 1px solid #cbd5e1; padding: 6px 8px; text-align: right; font-family: monospace;">₹${fmt(it.price || it.rate)}</td>
      <td style="border: 1px solid #cbd5e1; padding: 6px 8px; text-align: right; font-family: monospace;">₹${fmt(it.total || ((it.quantity || 1) * (it.price || it.rate)))}</td>
    </tr>
  `).join('');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        @page { size: A4; margin: 8mm; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11px; color: #1e293b; margin: 0; padding: 12px; line-height: 1.4; }
        table { width: 100%; border-collapse: collapse; }
        .header-table td { vertical-align: top; }
        .title { font-size: 22px; font-weight: bold; color: #0d9488; text-transform: uppercase; }
        .inv-num { font-size: 16px; font-weight: bold; }
        .box { border: 1px solid #cbd5e1; padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; }
      </style>
    </head>
    <body>
      <table class="header-table" style="margin-bottom: 16px;">
        <tr>
          <td style="width: 60%;">
            ${logoUrl ? `<img src="${logoUrl}" style="max-height: 48px; max-width: 180px; margin-bottom: 8px;">` : ''}
            <div style="font-size: 16px; font-weight: bold; color: #0f172a;">${companyName}</div>
            ${companyAddr ? `<div>${companyAddr}</div>` : ''}
            ${company.phone ? `<div>Phone: ${company.phone}</div>` : ''}
            ${company.email ? `<div>Email: ${company.email}</div>` : ''}
            ${company.gstin ? `<div><strong>GSTIN:</strong> ${company.gstin}</div>` : ''}
            ${company.pan ? `<div><strong>PAN:</strong> ${company.pan}</div>` : ''}
          </td>
          <td style="width: 40%; text-align: right;">
            <div class="title">${invType}</div>
            <div class="inv-num">#${invoiceNo}</div>
            <div style="margin-top: 6px;"><strong>Date:</strong> ${formatDate(invoice.date)}</div>
            ${invoice.dueDate ? `<div><strong>Due Date:</strong> ${formatDate(invoice.dueDate)}</div>` : ''}
            <div style="margin-top: 4px; display: inline-block; padding: 2px 8px; background: #f1f5f9; border-radius: 4px; font-weight: bold;">Status: ${invoice.status || 'SENT'}</div>
          </td>
        </tr>
      </table>

      <div class="box" style="margin-bottom: 16px;">
        <table style="width: 100%;">
          <tr>
            <td style="width: 50%; vertical-align: top;">
              <strong style="color: #64748b; font-size: 10px; text-transform: uppercase;">Billed To:</strong>
              <div style="font-size: 13px; font-weight: bold; margin-top: 2px;">${client.name || invoice.clientName || 'Client'}</div>
              ${clientAddr ? `<div>${clientAddr}</div>` : ''}
              ${client.email || invoice.clientEmail ? `<div>Email: ${client.email || invoice.clientEmail}</div>` : ''}
              ${client.phone ? `<div>Phone: ${client.phone}</div>` : ''}
              ${client.gstin ? `<div><strong>GSTIN:</strong> ${client.gstin}</div>` : ''}
            </td>
            <td style="width: 50%; vertical-align: top; text-align: right;">
              ${invoice.orderNumber ? `<div><strong>PO/Order No:</strong> ${invoice.orderNumber}</div>` : ''}
            </td>
          </tr>
        </table>
      </div>

      <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
        <thead>
          <tr style="background-color: #0f766e; color: #ffffff;">
            <th style="border: 1px solid #0f766e; padding: 6px 8px; width: 30px;">#</th>
            <th style="border: 1px solid #0f766e; padding: 6px 8px; text-align: left;">Item & Description</th>
            <th style="border: 1px solid #0f766e; padding: 6px 8px; width: 60px;">HSN/SAC</th>
            <th style="border: 1px solid #0f766e; padding: 6px 8px; width: 50px;">Qty</th>
            <th style="border: 1px solid #0f766e; padding: 6px 8px; width: 80px; text-align: right;">Rate</th>
            <th style="border: 1px solid #0f766e; padding: 6px 8px; width: 90px; text-align: right;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${itemRowsHtml}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="5" style="border: 1px solid #cbd5e1; padding: 6px 8px; text-align: right; font-weight: bold;">Subtotal:</td>
            <td style="border: 1px solid #cbd5e1; padding: 6px 8px; text-align: right; font-family: monospace;">₹${fmt(invoice.subTotal || grandTotal)}</td>
          </tr>
          ${Number(invoice.totalCGST) > 0 ? `
            <tr>
              <td colspan="5" style="border: 1px solid #cbd5e1; padding: 4px 8px; text-align: right;">CGST:</td>
              <td style="border: 1px solid #cbd5e1; padding: 4px 8px; text-align: right; font-family: monospace;">₹${fmt(invoice.totalCGST)}</td>
            </tr>
          ` : ''}
          ${Number(invoice.totalSGST) > 0 ? `
            <tr>
              <td colspan="5" style="border: 1px solid #cbd5e1; padding: 4px 8px; text-align: right;">SGST:</td>
              <td style="border: 1px solid #cbd5e1; padding: 4px 8px; text-align: right; font-family: monospace;">₹${fmt(invoice.totalSGST)}</td>
            </tr>
          ` : ''}
          ${Number(invoice.totalIGST) > 0 ? `
            <tr>
              <td colspan="5" style="border: 1px solid #cbd5e1; padding: 4px 8px; text-align: right;">IGST:</td>
              <td style="border: 1px solid #cbd5e1; padding: 4px 8px; text-align: right; font-family: monospace;">₹${fmt(invoice.totalIGST)}</td>
            </tr>
          ` : ''}
          ${Number(invoice.shippingCharges) > 0 ? `
            <tr>
              <td colspan="5" style="border: 1px solid #cbd5e1; padding: 4px 8px; text-align: right;">Shipping:</td>
              <td style="border: 1px solid #cbd5e1; padding: 4px 8px; text-align: right; font-family: monospace;">₹${fmt(invoice.shippingCharges)}</td>
            </tr>
          ` : ''}
          ${Number(invoice.discountTotal) > 0 ? `
            <tr>
              <td colspan="5" style="border: 1px solid #cbd5e1; padding: 4px 8px; text-align: right; color: #059669;">Discount:</td>
              <td style="border: 1px solid #cbd5e1; padding: 4px 8px; text-align: right; font-family: monospace; color: #059669;">- ₹${fmt(invoice.discountTotal)}</td>
            </tr>
          ` : ''}
          <tr style="background-color: #f1f5f9; font-size: 13px; font-weight: bold;">
            <td colspan="5" style="border: 1px solid #94a3b8; padding: 8px; text-align: right;">Grand Total:</td>
            <td style="border: 1px solid #94a3b8; padding: 8px; text-align: right; font-family: monospace;">₹${fmt(grandTotal)}</td>
          </tr>
        </tfoot>
      </table>

      ${(bank.accountNumber || bank.bankName) ? `
        <div class="box" style="margin-top: 12px;">
          <strong style="color: #64748b; font-size: 10px; text-transform: uppercase;">Bank Remittance Details:</strong>
          <table style="width: 100%; margin-top: 4px;">
            <tr>
              <td style="width: 50%;">
                ${bank.accountName ? `<div>Account Holder: <strong>${bank.accountName}</strong></div>` : ''}
                ${bank.bankName ? `<div>Bank: <strong>${bank.bankName}</strong></div>` : ''}
              </td>
              <td style="width: 50%;">
                ${bank.accountNumber ? `<div>Account No: <strong>${bank.accountNumber}</strong></div>` : ''}
                ${bank.ifscCode ? `<div>IFSC: <strong>${bank.ifscCode}</strong></div>` : ''}
              </td>
            </tr>
          </table>
        </div>
      ` : ''}

      ${invoice.terms ? `
        <div style="margin-top: 14px; font-size: 10px; color: #64748b;">
          <strong>Terms & Conditions:</strong><br/>
          ${invoice.terms.replace(/\n/g, '<br/>')}
        </div>
      ` : ''}
    </body>
    </html>
  `;
}

/**
 * Builds A4 print layout HTML for Puppeteer PDF generation.
 * Supports 'classic' (official GST print template) and 'modern'. Defaults to 'classic'.
 */
function buildInvoicePdfHtml({ invoice, settings, template = 'classic' }) {
  if (template === 'modern') {
    return buildModernInvoicePdfHtml({ invoice, settings });
  }
  return buildClassicInvoicePdfHtml({ invoice, settings });
}

module.exports = {
  buildInvoiceEmailHtml,
  buildInvoicePdfHtml,
  buildClassicInvoicePdfHtml,
  buildModernInvoicePdfHtml,
  numberToWords,
};
