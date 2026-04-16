const pdf = require('pdf-parse');
console.log('Keys of require("pdf-parse"):', Object.keys(pdf));

for (const key in pdf) {
    console.log(`Key: ${key}, Type: ${typeof pdf[key]}`);
}

// Check if it's a default export issue in CommonJS
if (pdf.default) {
    console.log('Default export keys:', Object.keys(pdf.default));
}
