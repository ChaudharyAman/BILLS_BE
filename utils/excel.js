const XLSX = require('xlsx-js-style');

const setHeaderStyle = (worksheet, cells = []) => {
  cells.forEach((cellAddress) => {
    if (!worksheet[cellAddress]) return;
    worksheet[cellAddress].s = {
      font: { bold: true, color: { rgb: 'FFFFFF' } },
      fill: { fgColor: { rgb: '1A2E44' } },
      alignment: { horizontal: 'center', vertical: 'center' },
    };
  });
};

const applyNumberFormat = (worksheet, addresses = []) => {
  addresses.forEach((cellAddress) => {
    if (!worksheet[cellAddress]) return;
    worksheet[cellAddress].z = '#,##0';
  });
};

const sendWorkbook = (res, workbook, filename) => {
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
};

module.exports = {
  XLSX,
  setHeaderStyle,
  applyNumberFormat,
  sendWorkbook,
};
