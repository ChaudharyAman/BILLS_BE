const { PDFParse } = require('pdf-parse');
console.log('Type of PDFParse:', typeof PDFParse);

const pdf = require('pdf-parse');
console.log('Type of default export:', typeof pdf);
if (typeof pdf === 'function') {
    console.log('It is a function!');
} else if (pdf.default && typeof pdf.default === 'function') {
    console.log('It has a .default function!');
}
