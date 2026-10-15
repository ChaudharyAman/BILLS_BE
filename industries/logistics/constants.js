/**
 * Logistics Industry Constants & Defaults
 */

const LOGISTICS_CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'CNY', 'JPY'];

const DEFAULT_LOGISTICS_FIELDS = {
  enabled: false,
  shipperName: '',
  shipperAddress: '',
  shipperCountry: '',
  mblNo: '',
  mblDate: null,
  hblNo: '',
  hblDate: null,
  sbNo: '',
  sbDate: null,
  exporterInvNo: '',
  exporterInvDate: null,
  vehicleNo: '',
  vesselName: '',
  portOfLoading: '',
  portOfDischarge: '',
  finalDestination: '',
  jobRef: '',
  shippingLine: '',
  packages: '',
  grossWeight: '',
  netWeight: '',
  cbm: '',
  containerNo: '',
  flightNo: '',
  deliveryNote: '',
  otherReferences: '',
  chargeableWeight: '',
  despatchedThrough: '',
  termsOfDelivery: '',
  cargoDescription: '',
};

module.exports = {
  LOGISTICS_CURRENCIES,
  DEFAULT_LOGISTICS_FIELDS,
};
