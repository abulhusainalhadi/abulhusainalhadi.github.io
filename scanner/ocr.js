/* OCR dalam peranti menggunakan Tesseract.js (dimuat dari CDN bila diperlukan). */
'use strict';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
const PDFJS_WORKER_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

const scriptCache = {};
function loadScript(src) {
  if (!scriptCache[src]) {
    scriptCache[src] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = res;
      s.onerror = () => { delete scriptCache[src]; rej(new Error('Gagal memuat ' + src.split('/')[2] + ' (perlu internet)')); };
      document.head.appendChild(s);
    });
  }
  return scriptCache[src];
}

const OCR = (() => {
  let workerP = null, curLang = null;
  const listeners = new Set();

  async function getWorker(lang) {
    if (workerP && curLang === lang) return workerP;
    if (workerP) { try { (await workerP).terminate(); } catch {} }
    curLang = lang;
    workerP = (async () => {
      await loadScript(TESSERACT_URL);
      return Tesseract.createWorker(lang.split('+'), 1, {
        logger: (m) => listeners.forEach((fn) => fn(m)),
      });
    })();
    workerP.catch(() => { workerP = null; });
    return workerP;
  }

  function collectWords(data) {
    if (Array.isArray(data.words) && data.words.length) return data.words;
    const out = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) out.push(w);
    return out;
  }

  // Kembalikan { text, w, h, words: [[teks, x0, y0, x1, y1], ...] }
  async function recognize(blob, lang, w, h) {
    const worker = await getWorker(lang);
    const { data } = await worker.recognize(blob, {}, { text: true, blocks: true });
    const words = collectWords(data)
      .filter((x) => x.text && x.text.trim() && x.confidence > 20)
      .map((x) => [x.text.trim(), x.bbox.x0, x.bbox.y0, x.bbox.x1, x.bbox.y1]);
    return { text: (data.text || '').trim(), lang, w, h, words };
  }

  return { recognize, onProgress: (fn) => listeners.add(fn) };
})();

/* Tukar fail PDF kepada imej (untuk penukar PDF → JPG) menggunakan pdf.js */
async function pdfToImages(file, onPage) {
  await loadScript(PDFJS_URL);
  const lib = window.pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const v1 = page.getViewport({ scale: 1 });
    const scale = Math.min(4, 2200 / Math.max(v1.width, v1.height));
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width);
    c.height = Math.round(vp.height);
    const x = c.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: x, viewport: vp }).promise;
    out.push(c);
    if (onPage) onPage(i, pdf.numPages);
  }
  return out;
}
