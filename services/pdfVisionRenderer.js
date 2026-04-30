const path = require('path');
const { pathToFileURL } = require('url');
const { createCanvas } = require('@napi-rs/canvas');

let pdfjsModulePromise = null;

async function loadPdfJs() {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsModulePromise;
}

function getStandardFontDataUrl() {
  const packageDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const standardFontsDir = path.join(packageDir, 'standard_fonts');
  const url = pathToFileURL(standardFontsDir).href;
  return url.endsWith('/') ? url : `${url}/`;
}

async function renderPdfPagesToImages(pdfBuffer, options = {}) {
  const { maxPages = 3, scale = 1.4, maxDimension = 1600 } = options;
  const pdfjs = await loadPdfJs();

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    standardFontDataUrl: getStandardFontDataUrl(),
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });

  const pdfDocument = await loadingTask.promise;
  const totalPages = pdfDocument.numPages || 0;
  const images = [];

  try {
    for (let pageNumber = 1; pageNumber <= Math.min(totalPages, maxPages); pageNumber++) {
      const page = await pdfDocument.getPage(pageNumber);
      const initialViewport = page.getViewport({ scale });
      const resizeRatio = Math.min(
        1,
        maxDimension / Math.max(initialViewport.width, initialViewport.height)
      );
      const viewport = page.getViewport({ scale: scale * resizeRatio });

      const canvas = createCanvas(
        Math.max(1, Math.ceil(viewport.width)),
        Math.max(1, Math.ceil(viewport.height))
      );
      const context = canvas.getContext('2d');

      await page.render({
        canvasContext: context,
        viewport,
      }).promise;

      const pngBuffer = canvas.toBuffer('image/png');
      images.push({
        pageNumber,
        mimeType: 'image/png',
        buffer: pngBuffer,
        dataUrl: `data:image/png;base64,${pngBuffer.toString('base64')}`,
      });
    }
  } finally {
    await pdfDocument.destroy();
  }

  return {
    totalPages,
    renderedPages: images.length,
    images,
  };
}

module.exports = {
  renderPdfPagesToImages,
};
