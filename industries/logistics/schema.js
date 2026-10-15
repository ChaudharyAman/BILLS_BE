const mongoose = require('mongoose');

/**
 * Logistics Subdocument Schema for Invoices
 * Captures shipper/consignor, waybills (MBL/HBL), vessel/flight, container specs, and ports.
 */
const logisticsSchema = new mongoose.Schema({
  enabled: { type: Boolean, default: false },
  shipperName: { type: String, default: '' },
  shipperAddress: { type: String, default: '' },
  shipperCountry: { type: String, default: '' },
  mblNo: { type: String, default: '' },
  mblDate: { type: Date, default: null },
  hblNo: { type: String, default: '' },
  hblDate: { type: Date, default: null },
  sbNo: { type: String, default: '' },
  sbDate: { type: Date, default: null },
  exporterInvNo: { type: String, default: '' },
  exporterInvDate: { type: Date, default: null },
  vehicleNo: { type: String, default: '' },
  vesselName: { type: String, default: '' },
  portOfLoading: { type: String, default: '' },
  portOfDischarge: { type: String, default: '' },
  finalDestination: { type: String, default: '' },
  jobRef: { type: String, default: '' },
  shippingLine: { type: String, default: '' },
  packages: { type: String, default: '' },
  grossWeight: { type: String, default: '' },
  netWeight: { type: String, default: '' },
  cbm: { type: String, default: '' },
  containerNo: { type: String, default: '' },
  flightNo: { type: String, default: '' },
  deliveryNote: { type: String, default: '' },
  otherReferences: { type: String, default: '' },
  chargeableWeight: { type: String, default: '' },
  despatchedThrough: { type: String, default: '' },
  termsOfDelivery: { type: String, default: '' },
  cargoDescription: { type: String, default: '' },
}, { _id: false });

module.exports = logisticsSchema;
