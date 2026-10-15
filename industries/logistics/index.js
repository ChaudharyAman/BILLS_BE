const logisticsSchema = require('./schema');
const logisticsItemFields = require('./itemFields');
const { DEFAULT_LOGISTICS_FIELDS, LOGISTICS_CURRENCIES } = require('./constants');
const { buildLogisticsInvoicePdfHtml } = require('./pdfTemplate');

module.exports = {
  id: 'Logistics',
  name: 'logistics',
  label: 'Logistics, Cargo & Freight Forwarding',
  schema: logisticsSchema,
  itemFields: logisticsItemFields,
  defaultFields: DEFAULT_LOGISTICS_FIELDS,
  currencies: LOGISTICS_CURRENCIES,
  buildLogisticsInvoicePdfHtml,
  pdfTemplate: buildLogisticsInvoicePdfHtml,
};
