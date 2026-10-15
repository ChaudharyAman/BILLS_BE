'use strict';

/**
 * Logistics Industry PDF Template (Backend)
 * Matches the official Indian Freight Forwarding & Cargo Tax Invoice layout.
 */

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

function addrStr(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  const parts = [a.line1, a.line2, a.city, a.state, a.zip, a.country].filter(Boolean);
  return parts.join(', ');
}

/**
 * Builds A4 print layout HTML for Logistics & Freight Forwarding invoices.
 * Matches the reference Indian Cargo & Logistics tax invoice format.
 */
function buildLogisticsInvoicePdfHtml({ invoice, settings }) {
  const company = settings || {};
  const client = invoice.client || {};
  const companyName = company.companyName || 'COMPLETE CARGO SOLUTIONS PVT LTD';
  const companyPAN = (company.pan || (company.gstin && company.gstin.length >= 12 ? company.gstin.substring(2, 12) : '') || '').toUpperCase();
  const companyAddr = addrStr(company.address);
  const clientAddr = addrStr(client.address || invoice.billingAddress);
  const companyStateCode = company.gstin ? company.gstin.substring(0, 2) : '07';
  const clientStateCode = client.gstin ? client.gstin.substring(0, 2) : '';

  const logistics = invoice.logistics || invoice.transport || {};
  const invoiceNo = invoice.invoiceNo || 'INV-0001';
  const invType = invoice.invoiceType || 'Tax Invoice';
  const grandTotal = Number(invoice.grandTotal) || 0;
  const rounded = Math.round(grandTotal) - grandTotal;
  const bank = invoice.bankDetails || company.bankDetails || {};
  const isIntra = (Number(invoice.totalIGST) || 0) === 0;

  const rawItems = Array.isArray(invoice.items) && invoice.items.length ? invoice.items : [];
  const foreignItem = rawItems.find(it => it.currency && it.currency !== 'INR' && Number(it.exRate) > 1);
  const taxSummaryMap = {};

  const itemsRows = rawItems.map((it, idx) => {
    const qty = Number(it.quantity ?? it.qty ?? 1);
    const rate = Number(it.price ?? it.rate ?? 0);
    const foreignRate = Number(it.foreignRate) || 0;
    const exRate = Number(it.exRate) || 1;
    const currency = it.currency || 'INR';
    const rowAmount = (foreignRate > 0 && exRate > 0)
      ? Number((foreignRate * exRate * qty).toFixed(2))
      : Number((rate * qty).toFixed(2));
    const isExempt = Boolean(it.isTaxExempt) || (it.taxableAmount === 0 && Number(it.taxRate) === 0);
    const taxable = isExempt
      ? 0
      : (it.taxableAmount !== undefined && it.taxableAmount !== null && Number(it.taxableAmount) >= 0
          ? Number(it.taxableAmount)
          : rowAmount);
    const taxRate = isExempt ? 0 : Number(it.taxRate ?? it.gstRate ?? 0);
    const cgst = Number(it.cgst) || (isIntra && !isExempt ? Number((taxable * (taxRate / 2) / 100).toFixed(2)) : 0);
    const sgst = Number(it.sgst) || (isIntra && !isExempt ? Number((taxable * (taxRate / 2) / 100).toFixed(2)) : 0);
    const igst = Number(it.igst) || (!isIntra && !isExempt ? Number((taxable * taxRate / 100).toFixed(2)) : 0);
    const taxAmt = cgst + sgst + igst;

    const sac = it.hsnCode || '996531';
    const unit = it.unit || 'Kg';
    const key = `${sac}__${taxRate}`;
    if (!taxSummaryMap[key]) {
      taxSummaryMap[key] = { sac, rate: taxRate, taxable: 0, cgst: 0, sgst: 0, igst: 0, totalTax: 0 };
    }
    taxSummaryMap[key].taxable += taxable;
    taxSummaryMap[key].cgst += cgst;
    taxSummaryMap[key].sgst += sgst;
    taxSummaryMap[key].igst += igst;
    taxSummaryMap[key].totalTax += taxAmt;

    return `
      <tr style="border-bottom: ${idx === rawItems.length - 1 ? 'none' : '1px solid #cbd5e1'};">
        <td style="border-right: 1px solid #000; padding: 6px 4px; text-align: center; vertical-align: top; font-weight: 700;">
          ${idx + 1}
        </td>
        <td style="border-right: 1px solid #000; padding: 6px 8px; vertical-align: top;">
          <div style="font-weight: 800; text-transform: uppercase; color: #000;">
            ${it.name || 'Freight Service'}
          </div>
          ${it.description && it.description !== it.name ? `
            <div style="font-size: 9.5px; color: #444; margin-top: 1px;">
              ${it.description}
            </div>
          ` : ''}
          ${currency !== 'INR' && foreignRate > 0 ? `
            <div style="font-size: 9.5px; color: #0284c7; margin-top: 2px; font-weight: 600;">
              ${currency} ${fmt(foreignRate)} @ Ex. Rate ${exRate.toFixed(2)}
            </div>
          ` : ''}
          ${isExempt ? `
            <span style="display: inline-block; font-size: 8.5px; background: #fef3c7; color: #92400e; padding: 1px 4px; border-radius: 2px; font-weight: 700; margin-top: 2px;">
              GST Exempt (0%)
            </span>
          ` : ''}
        </td>
        <td style="border-right: 1px solid #000; padding: 6px 6px; text-align: center; vertical-align: top; font-weight: 800;">
          ${sac}
        </td>
        <td style="border-right: 1px solid #000; padding: 6px 6px; text-align: right; vertical-align: top; font-weight: 800;">
          ${qty}
        </td>
        <td style="border-right: 1px solid #000; padding: 6px 8px; text-align: right; vertical-align: top;">
          ${fmt(foreignRate > 0 ? foreignRate : rate)}
        </td>
        <td style="border-right: 1px solid #000; padding: 6px 6px; text-align: center; vertical-align: top; color: #333;">
          ${unit}
        </td>
        <td style="padding: 6px 8px; text-align: right; vertical-align: top; font-weight: 800;">
          ${fmt(rowAmount)}
        </td>
      </tr>
    `;
  }).join('');

  const taxSummaryRows = Object.values(taxSummaryMap);
  const totalTaxableBase = taxSummaryRows.reduce((sum, r) => sum + r.taxable, 0);

  const taxSummaryHtml = taxSummaryRows.map(r => `
    <tr style="border-bottom: 1px solid #cbd5e1;">
      <td style="padding: 3px 4px; font-weight: 600;">${r.sac}</td>
      <td style="padding: 3px 4px; text-align: center;">${r.rate}%</td>
      <td style="padding: 3px 4px; text-align: right;">${fmt(r.taxable)}</td>
      ${isIntra ? `
        <td style="padding: 3px 4px; text-align: right;">${fmt(r.cgst)}</td>
        <td style="padding: 3px 4px; text-align: right;">${fmt(r.sgst)}</td>
      ` : `
        <td style="padding: 3px 4px; text-align: right;">${fmt(r.igst)}</td>
      `}
      <td style="padding: 3px 4px; text-align: right; font-weight: 700;">${fmt(r.totalTax)}</td>
    </tr>
  `).join('');

  const otherRefs = [
    logistics.otherReferences,
    invoice.poNumber ? `PO: ${invoice.poNumber}${invoice.poDate ? ' (' + formatDate(invoice.poDate) + ')' : ''}` : '',
    logistics.exporterInvNo ? `Exp: ${logistics.exporterInvNo}${logistics.exporterInvDate ? ' (' + formatDate(logistics.exporterInvDate) + ')' : ''}` : '',
    logistics.jobRef ? `Job: ${logistics.jobRef}` : '',
  ].filter(Boolean).join(' / ');

  const mawnHblCombined = [logistics.mblNo, logistics.hblNo].filter(Boolean).join(' / ');
  const mawnHblDates = [
    logistics.mblDate ? formatDate(logistics.mblDate) : '',
    logistics.hblDate ? formatDate(logistics.hblDate) : '',
  ].filter(Boolean).join(' / ');

  const despatchedThru = [
    logistics.shippingLine ? `Carrier: ${logistics.shippingLine}` : '',
    logistics.despatchedThrough,
    [logistics.vesselName, logistics.flightNo ? `Voy/Flt: ${logistics.flightNo}` : ''].filter(Boolean).join(' '),
  ].filter(Boolean).join(' - ');

  const portDest = [logistics.portOfDischarge, logistics.finalDestination].filter(Boolean).join(' / ');

  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <title>${invType} #${invoiceNo}</title>
      <style>
        @page { size: A4; margin: 8mm; }
        body {
          font-family: Calibri, Arial, sans-serif;
          font-size: 11px;
          color: #000;
          margin: 0;
          padding: 0;
          line-height: 1.3;
          -webkit-print-color-adjust: exact;
        }
        table { border-collapse: collapse; }
        .bdr-box {
          border: 1px solid #000;
          background: #fff;
          box-sizing: border-box;
          max-width: 100%;
        }
      </style>
    </head>
    <body>
      <div class="bdr-box">
        <!-- ── Top Header Banner: TAX INVOICE ── -->
        <div style="text-align: center; font-weight: 900; font-size: 14px; text-transform: uppercase; padding: 4px; border-bottom: 1px solid #000; letter-spacing: 1px; background: #fff;">
          ${invType.toUpperCase() || 'TAX INVOICE'}
        </div>

        <!-- ── Section 1: Company Particulars (Left) & Transport Matrix Rows 1-7 (Right) ── -->
        <table style="width: 100%; border-collapse: collapse; border-bottom: 1px solid #000;">
          <tr>
            <!-- Left Column (44%): Logo + Company Particulars + Shipper -->
            <td style="width: 44%; vertical-align: top; border-right: 1px solid #000; padding: 0;">
              <!-- Company Particulars -->
              <div style="padding: 8px 12px;">
                ${company.logoUrl ? `
                  <div style="text-align: center; margin-bottom: 8px;">
                    <img src="${company.logoUrl}" alt="Company Logo" style="max-height: 60px; max-width: 90%; object-fit: contain;">
                  </div>
                ` : ''}
                <div style="font-weight: 800; font-size: 13px; text-transform: uppercase; margin-bottom: 3px;">
                  ${companyName}
                </div>
                <div style="font-size: 10.5px; color: #111; margin-bottom: 3px;">
                  ${companyAddr || '7/112, UGF, GEETA COLONY ROAD, EAST DELHI, NEW DELHI-110031'}
                </div>
                <div style="font-size: 10.5px; line-height: 1.45;">
                  <div><b>GSTIN :</b> ${company.gstin || '07AANCC8618C1ZL'}</div>
                  ${company.msme ? `<div><b>MSME :</b> ${company.msme}</div>` : ''}
                  ${company.cin ? `<div><b>CIN :</b> ${company.cin}</div>` : ''}
                  ${company.tan ? `<div><b>TAN NO :</b> ${company.tan}</div>` : ''}
                  ${companyPAN ? `<div><b>PAN :</b> ${companyPAN}</div>` : ''}
                  ${(company.phone || company.contactNo) ? `<div><b>Contact No :</b> ${company.phone || company.contactNo}</div>` : ''}
                  ${company.email ? `<div><b>E-mail :</b> ${company.email}</div>` : ''}
                </div>
              </div>

              <!-- Shipper Details (if present) -->
              ${logistics.shipperName ? `
                <div style="border-top: 1px solid #000; padding: 6px 12px; background: #fafbfc;">
                  <div style="font-size: 10px; color: #555; text-transform: uppercase; font-weight: 600;">
                    Shipper / Consignor Details :
                  </div>
                  <div style="font-weight: 800; font-size: 11px; text-transform: uppercase;">
                    ${logistics.shipperName}
                  </div>
                  <div style="font-size: 10px; color: #222;">
                    ${logistics.shipperAddress || '—'}
                  </div>
                  ${logistics.shipperCountry ? `<div style="font-size: 10px;"><b>Country :</b> ${logistics.shipperCountry}</div>` : ''}
                </div>
              ` : ''}
            </td>

            <!-- Right Column (56%): Key Transport Matrix Rows 1 to 7 -->
            <td style="width: 56%; vertical-align: top; padding: 0;">
              <table style="width: 100%; height: 100%; border-collapse: collapse; font-size: 10.5px;">
                <!-- Row 1: Invoice No. & Dated -->
                <tr style="border-bottom: 1px solid #000;">
                  <td style="width: 50%; padding: 4px 8px; border-right: 1px solid #000; vertical-align: top;">
                    <div style="font-size: 9.5px; color: #555;">Invoice No.</div>
                    <div style="font-weight: 800; font-size: 12px; margin-top: 1px;">${invoiceNo}</div>
                  </td>
                  <td style="width: 50%; padding: 4px 8px; vertical-align: top;">
                    <div style="font-size: 9.5px; color: #555;">Dated</div>
                    <div style="font-weight: 800; font-size: 12px; margin-top: 1px;">${formatDate(invoice.date)}</div>
                    ${invoice.dueDate ? `
                      <div style="font-size: 9.5px; color: #555; margin-top: 1px;">
                        <b>Due:</b> ${formatDate(invoice.dueDate)}
                      </div>
                    ` : ''}
                  </td>
                </tr>

                <!-- Row 2: Delivery Note & Mode/Terms of Payment -->
                <tr style="border-bottom: 1px solid #000;">
                  <td style="padding: 4px 8px; border-right: 1px solid #000; vertical-align: top;">
                    <div style="font-size: 9.5px; color: #555;">Delivery Note</div>
                    <div style="font-weight: 600; margin-top: 1px;">${logistics.deliveryNote || '---'}</div>
                  </td>
                  <td style="padding: 4px 8px; vertical-align: top;">
                    <div style="font-size: 9.5px; color: #000; font-weight: 700;">Mode/Terms of Payment</div>
                    <div style="font-weight: 600; margin-top: 1px;">
                      ${[invoice.paymentMode, invoice.paymentTerms || 'As per Contract'].filter(Boolean).join(' / ')}
                    </div>
                  </td>
                </tr>

                <!-- Row 3: SB No / BE No & Other Reference(s) -->
                <tr style="border-bottom: 1px solid #000;">
                  <td style="padding: 4px 8px; border-right: 1px solid #000; vertical-align: top;">
                    <div style="font-size: 9.5px; color: #000; font-weight: 700;">SB No / BE No</div>
                    <div style="font-weight: 600; margin-top: 1px;">
                      ${logistics.sbNo || '---'} ${logistics.sbDate ? `(${formatDate(logistics.sbDate)})` : ''}
                    </div>
                  </td>
                  <td style="padding: 4px 8px; vertical-align: top;">
                    <div style="font-size: 9.5px; color: #555;">Other Reference(s)</div>
                    <div style="font-weight: 600; margin-top: 1px;">
                      ${otherRefs || '---'}
                    </div>
                  </td>
                </tr>

                <!-- Row 4 & 5: MAWN / HBL No & Gross / Chargeable Weight -->
                <tr style="border-bottom: 1px solid #000;">
                  <td rowspan="2" style="padding: 4px 8px; border-right: 1px solid #000; vertical-align: top;">
                    <div style="font-size: 9.5px; color: #000; font-weight: 700;">MAWN /HBL No</div>
                    <div style="font-weight: 800; font-size: 11px; margin-top: 2px;">
                      ${mawnHblCombined || '---'}
                    </div>
                    ${mawnHblDates ? `<div style="font-size: 9px; color: #555; margin-top: 1px;">(${mawnHblDates})</div>` : ''}
                  </td>
                  <td style="padding: 3px 8px; border-bottom: 1px solid #cbd5e1;">
                    <table style="width: 100%; border-collapse: collapse;">
                      <tr>
                        <td style="font-weight: 700;">Gross Weight :</td>
                        <td style="text-align: right; font-weight: 600;">
                          ${logistics.grossWeight || '---'}
                          ${logistics.netWeight ? `<span style="font-size: 9px; color: #555; margin-left: 4px;">(Net: ${logistics.netWeight})</span>` : ''}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr style="border-bottom: 1px solid #000;">
                  <td style="padding: 3px 8px;">
                    <table style="width: 100%; border-collapse: collapse;">
                      <tr>
                        <td style="font-weight: 700;">Chargable Weight :</td>
                        <td style="text-align: right; font-weight: 800;">${logistics.chargeableWeight || logistics.grossWeight || '---'}</td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Row 6: No of Packages & Port of Loading -->
                <tr style="border-bottom: 1px solid #000;">
                  <td style="padding: 4px 8px; border-right: 1px solid #000;">
                    <span style="font-weight: 700;">No of Packages :</span>
                    <div style="font-weight: 600; margin-top: 1px;">${logistics.packages || '---'}</div>
                  </td>
                  <td style="padding: 3px 8px;">
                    <table style="width: 100%; border-collapse: collapse;">
                      <tr>
                        <td style="font-weight: 700;">Port of Loading :</td>
                        <td style="text-align: right; font-weight: 600;">${logistics.portOfLoading || '---'}</td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <!-- Row 7: Despatched through & Port of Destination -->
                <tr>
                  <td style="padding: 4px 8px; border-right: 1px solid #000;">
                    <span style="font-weight: 700;">Despatched through</span>
                    <div style="font-weight: 600; margin-top: 1px;">
                      ${despatchedThru || '---'}
                    </div>
                  </td>
                  <td style="padding: 3px 8px;">
                    <table style="width: 100%; border-collapse: collapse;">
                      <tr>
                        <td style="font-weight: 700;">Port of Destination :</td>
                        <td style="text-align: right; font-weight: 600;">${portDest || '---'}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- ── Section 2: Bill To (Left 44%) & Terms of Delivery / Description (Right 28% + 28%) ── -->
        <table style="width: 100%; border-collapse: collapse; border-bottom: 1px solid #000;">
          <tr>
            <!-- Bill To : Consignee (44%) -->
            <td style="width: 44%; vertical-align: top; border-right: 1px solid #000; padding: 8px 12px;">
              <div style="font-size: 10.5px; color: #444; margin-bottom: 2px;">
                Bill To :
              </div>
              <div style="font-weight: 800; font-size: 12px; text-transform: uppercase; color: #000;">
                ${client.name || 'SPEED MAX LOGISTICS'}
              </div>
              <div style="font-size: 10px; color: #222; margin-top: 2px;">
                ${clientAddr || 'KH NO 835, BLOCK K-2 , NEAR MATA CHOWK MAHIPALPUR EXTENTION'}
              </div>
              <div style="font-size: 10px; margin-top: 4px; line-height: 1.4;">
                <div><b>GSTIN:</b> ${client.gstin || 'Unregistered'}</div>
                ${client.address?.state ? `<div><b>State:</b> ${client.address.state} ${clientStateCode ? `(Code: ${clientStateCode})` : ''}</div>` : ''}
                ${invoice.placeOfSupply ? `<div><b>Place of Supply:</b> ${invoice.placeOfSupply}</div>` : ''}
                ${invoice.reverseCharge ? `<div><b>Reverse Charge:</b> Yes</div>` : ''}
              </div>
            </td>

            <!-- Terms of Delivery (28% = left half of right 56%) -->
            <td style="width: 28%; vertical-align: top; border-right: 1px solid #000; padding: 6px 8px;">
              <span style="font-size: 9.5px; color: #555;">Terms of Delivery</span>
              <div style="font-weight: 700; font-size: 11px; margin-top: 2px;">
                ${logistics.termsOfDelivery || '---'}
              </div>
            </td>

            <!-- Description & Cargo Details (28% = right half of right 56%) -->
            <td style="width: 28%; vertical-align: top; padding: 6px 8px;">
              <div style="display: flex; justify-content: space-between;">
                <span style="font-weight: 700;">Description :</span>
                <span style="font-weight: 600;">${logistics.cargoDescription || 'Other'}</span>
              </div>
              ${(logistics.containerNo || logistics.vehicleNo) ? `
                <div style="font-size: 9.5px; color: #333; margin-top: 2px;">
                  <b>Cont/Veh:</b> ${[logistics.containerNo, logistics.vehicleNo].filter(Boolean).join(' / ')}
                </div>
              ` : ''}
              ${logistics.cbm ? `
                <div style="font-size: 9.5px; color: #333; margin-top: 1px;">
                  <b>CBM:</b> ${logistics.cbm}
                </div>
              ` : ''}
              ${logistics.netWeight ? `
                <div style="font-size: 9.5px; color: #333; margin-top: 1px;">
                  <b>Net Wt:</b> ${logistics.netWeight}
                </div>
              ` : ''}
            </td>
          </tr>
        </table>

        <!-- ── Table of Goods / Services ── -->
        <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 11px; border-bottom: 1px solid #000;">
          <thead>
            <tr style="border-bottom: 1px solid #000; background: #fff;">
              <th style="border-right: 1px solid #000; padding: 5px 4px; width: 35px; text-align: center; font-weight: 800;">SI No.</th>
              <th style="border-right: 1px solid #000; padding: 5px 8px; text-align: left; font-weight: 800;">Description of Goods/Services</th>
              <th style="border-right: 1px solid #000; padding: 5px 6px; width: 75px; text-align: center; font-weight: 800;">HSN/SAC</th>
              <th style="border-right: 1px solid #000; padding: 5px 6px; width: 65px; text-align: right; font-weight: 800;">Quantity</th>
              <th style="border-right: 1px solid #000; padding: 5px 8px; width: 75px; text-align: right; font-weight: 800;">Rate</th>
              <th style="border-right: 1px solid #000; padding: 5px 6px; width: 45px; text-align: center; font-weight: 800;">per</th>
              <th style="padding: 5px 8px; width: 100px; text-align: right; font-weight: 800;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${itemsRows}
          </tbody>
        </table>

        <!-- ── Exchange Rate Notice (if foreign currency used) ── -->
        ${foreignItem ? `
          <div style="padding: 4px 10px; background: #f8fafc; border-bottom: 1px solid #000; font-style: italic; font-weight: 700; font-size: 10px;">
            Exchange Rate 1 ${foreignItem.currency} @ Rs ${Number(foreignItem.exRate).toFixed(2)}
          </div>
        ` : ''}

        <!-- ── GST Tax Slabs & Summary Breakdown ── -->
        <table style="width: 100%; border-collapse: collapse; border-bottom: 1px solid #000;">
          <tr>
            <!-- Left: GST Tax Slabs Summary -->
            <td style="width: 55%; vertical-align: top; border-right: 1px solid #000; padding: 6px 8px;">
              <div style="font-weight: 800; font-size: 10px; text-transform: uppercase; margin-bottom: 4px; color: #000;">
                GST Tax Slabs & Exemption Summary
              </div>
              <table style="width: 100%; border-collapse: collapse; font-size: 10px;">
                <thead>
                  <tr style="border-bottom: 1px solid #000; background: #f8fafc; font-weight: 800;">
                    <th style="padding: 3px 4px; text-align: left;">SAC</th>
                    <th style="padding: 3px 4px; text-align: center;">Rate</th>
                    <th style="padding: 3px 4px; text-align: right;">Taxable (₹)</th>
                    ${isIntra ? `
                      <th style="padding: 3px 4px; text-align: right;">CGST (₹)</th>
                      <th style="padding: 3px 4px; text-align: right;">SGST (₹)</th>
                    ` : `
                      <th style="padding: 3px 4px; text-align: right;">IGST (₹)</th>
                    `}
                    <th style="padding: 3px 4px; text-align: right;">Total Tax (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  ${taxSummaryHtml}
                </tbody>
              </table>
            </td>

            <!-- Right: Pre-Tax Subtotal, GST Totals, Grand Total -->
            <td style="width: 45%; vertical-align: top; padding: 6px 12px; font-size: 11px;">
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 2.5px 0; color: #444;">Pre-Tax Subtotal</td>
                  <td style="padding: 2.5px 0; text-align: right; font-weight: 700;">₹ ${fmt(invoice.subTotal)}</td>
                </tr>
                <tr>
                  <td style="padding: 2.5px 0; color: #444;">Total Taxable Value</td>
                  <td style="padding: 2.5px 0; text-align: right; font-weight: 600;">₹ ${fmt(totalTaxableBase)}</td>
                </tr>
                ${isIntra ? `
                  <tr>
                    <td style="padding: 2.5px 0; color: #444;">Total CGST</td>
                    <td style="padding: 2.5px 0; text-align: right;">₹ ${fmt(invoice.totalCGST)}</td>
                  </tr>
                  <tr>
                    <td style="padding: 2.5px 0; color: #444;">Total SGST</td>
                    <td style="padding: 2.5px 0; text-align: right;">₹ ${fmt(invoice.totalSGST)}</td>
                  </tr>
                ` : `
                  <tr>
                    <td style="padding: 2.5px 0; color: #444;">Total IGST</td>
                    <td style="padding: 2.5px 0; text-align: right;">₹ ${fmt(invoice.totalIGST)}</td>
                  </tr>
                `}
                ${Number(invoice.shippingCharges) > 0 ? `
                  <tr>
                    <td style="padding: 2.5px 0; color: #444;">Shipping / Delivery</td>
                    <td style="padding: 2.5px 0; text-align: right;">₹ ${fmt(invoice.shippingCharges)}</td>
                  </tr>
                ` : ''}
                ${Number(invoice.packagingCharges) > 0 ? `
                  <tr>
                    <td style="padding: 2.5px 0; color: #444;">${invoice.customChargeLabel || 'Custom Amount'}</td>
                    <td style="padding: 2.5px 0; text-align: right;">₹ ${fmt(invoice.packagingCharges)}</td>
                  </tr>
                ` : ''}
                ${Number(invoice.discountTotal) > 0 ? `
                  <tr>
                    <td style="padding: 2.5px 0; color: #059669;">Discount</td>
                    <td style="padding: 2.5px 0; text-align: right; color: #059669;">- ₹ ${fmt(invoice.discountTotal)}</td>
                  </tr>
                ` : ''}
                ${rounded !== 0 ? `
                  <tr>
                    <td style="padding: 2.5px 0; color: #444;">Round Off</td>
                    <td style="padding: 2.5px 0; text-align: right;">${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}</td>
                  </tr>
                ` : ''}
                <tr style="border-top: 1px solid #000;">
                  <td style="padding: 6px 0 2px 0; font-weight: 800; font-size: 13px;">Invoice Total (INR)</td>
                  <td style="padding: 6px 0 2px 0; text-align: right; font-weight: 900; font-size: 14px;">
                    ₹ ${fmt(grandTotal)}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- ── Amount in Words ── -->
        <div style="padding: 5px 12px; border-bottom: 1px solid #000; background: #fafbfc; font-weight: 700; font-size: 10.5px;">
          Amount Chargeable (in words): Rupees ${numberToWords(Math.round(grandTotal))}
        </div>

        <!-- ── Remittance Bank Details & Signatures ── -->
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <!-- Bank Particulars -->
            <td style="width: 55%; vertical-align: top; border-right: 1px solid #000; padding: 8px 12px; font-size: 10px;">
              <div style="font-weight: 800; text-transform: uppercase; margin-bottom: 2px;">
                Bank Remittance Details
              </div>
              ${bank && (bank.bankName || bank.accountNumber) ? `
                <div style="line-height: 1.45; color: #111;">
                  <div>A/C Name: <b>${(bank.accountName || companyName).toUpperCase()}</b></div>
                  <div>Bank: <b>${(bank.bankName || '').toUpperCase()}</b></div>
                  <div>A/C No: <b style="font-family: monospace; font-size: 11px;">${bank.accountNumber}</b></div>
                  ${bank.branch ? `<div>Branch: <b>${bank.branch}</b></div>` : ''}
                  <div>IFSC: <b style="font-family: monospace; font-size: 11px;">${bank.ifscCode}</b></div>
                </div>
              ` : `
                <div style="color: #888; font-style: italic;">Bank details not configured in Settings</div>
              `}
              ${invoice.terms ? `
                <div style="margin-top: 6px; color: #444; border-top: 1px solid #cbd5e1; padding-top: 4px;">
                  <b>Terms & Conditions:</b> ${invoice.terms}
                </div>
              ` : ''}
            </td>

            <!-- Declaration & Signatory -->
            <td style="width: 45%; vertical-align: top; padding: 8px 12px; text-align: right;">
              <div style="display: flex; flex-direction: column; justify-content: space-between; min-height: 80px;">
                <div style="font-weight: 800; font-size: 11px; text-transform: uppercase;">
                  For ${companyName}
                </div>
                <div style="font-size: 9px; color: #666; font-style: italic; margin: 15px 0 6px 0; text-align: center;">
                  This is a computer generated invoice and does not require physical signature.
                </div>
                <div style="border-top: 1px dashed #666; padding-top: 3px; font-weight: 700; font-size: 10.5px;">
                  Authorised Signatory
                </div>
              </div>
            </td>
          </tr>
        </table>
      </div>
    </body>
    </html>
  `;
}

module.exports = {
  buildLogisticsInvoicePdfHtml,
};
