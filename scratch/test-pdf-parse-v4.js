const { PDFParse } = require('pdf-parse');
console.log('PDFParse keys:', Object.keys(PDFParse));
console.log('PDFParse prototype keys:', Object.keys(PDFParse.prototype));

try {
    const p = new PDFParse();
    console.log('Instance keys:', Object.keys(p));
    // Check for common method names
    const methods = ['parse', 'load', 'getText', 'extract'];
    methods.forEach(m => {
        if (typeof p[m] === 'function') console.log(`Method found: ${m}`);
    });
} catch (e) {
    console.log('Error instantiating:', e.message);
}
