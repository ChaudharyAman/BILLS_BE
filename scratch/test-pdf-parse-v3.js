const { PDFParse } = require('pdf-parse');

async function test() {
    try {
        // Just a dummy buffer, might error but I want to see if it's a promise
        const result = PDFParse(Buffer.from('dummy'));
        console.log('Is result a promise?', result instanceof Promise);
        const data = await result;
        console.log('Data:', data);
    } catch (e) {
        console.log('Error (expected):', e.message);
    }
}

test();
