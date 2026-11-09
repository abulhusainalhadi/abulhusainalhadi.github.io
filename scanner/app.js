/* Pengimbas Dokumen — semua pemprosesan berlaku dalam peranti (tiada pelayan). */
'use strict';

const $ = (s) => document.querySelector(s);
const MAX_SRC = 3000;   // had sisi panjang imej sumber
const MAX_OUT = 2480;   // had sisi panjang halaman hasil (~300dpi A4)
const JPEG_Q = 0.88;

/* ------------------------------------------------------------------ */
/* Storan (IndexedDB)                                                  */
/* ------------------------------------------------------------------ */
const DB = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('pengimbas', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('pages', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('pages', mode);
      const req = fn(t.objectStore('pages'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  return {
    all: () => run('readonly', (s) => s.getAll()),
    put: (p) => run('readwrite', (s) => s.put(p)),
    del: (id) => run('readwrite', (s) => s.delete(id)),
    clear: () => run('readwrite', (s) => s.clear()),
  };
})();

/* ------------------------------------------------------------------ */
/* Utiliti                                                             */
/* ------------------------------------------------------------------ */
function mkCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });
const toBlob = (c, type = 'image/jpeg', q = JPEG_Q) =>
  new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob gagal'))), type, q));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function busy(on, text = 'Memproses…') {
  $('#busyText').textContent = text;
  $('#busy').hidden = !on;
}
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 2600);
}

async function loadSource(blob) {
  let img;
  try {
    img = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('Imej tidak dapat dibaca'));
      i.src = URL.createObjectURL(blob);
    });
  }
  const w = img.width, h = img.height;
  const s = Math.min(1, MAX_SRC / Math.max(w, h));
  const c = mkCanvas(w * s, h * s);
  ctx2d(c).drawImage(img, 0, 0, c.width, c.height);
  if (img.close) img.close();
  return c;
}

/* ------------------------------------------------------------------ */
/* Pengesanan tepi dokumen                                              */
/* ------------------------------------------------------------------ */
const FULL_QUAD = [[0, 0], [1, 0], [1, 1], [0, 1]];
const INSET_QUAD = [[0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95]];

function orderQuad(pts) {
  const cx = pts.reduce((a, p) => a + p[0], 0) / 4;
  const cy = pts.reduce((a, p) => a + p[1], 0) / 4;
  const s = pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let k = 0;
  for (let i = 1; i < 4; i++) if (s[i][0] + s[i][1] < s[k][0] + s[k][1]) k = i;
  return [s[k], s[(k + 1) % 4], s[(k + 2) % 4], s[(k + 3) % 4]]; // tl, tr, br, bl
}
function polyArea(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % q.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}
function convexHull(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop();
    up.push(p);
  }
  up.pop(); lo.pop();
  return lo.concat(up);
}
// Pilih 4 titik hull yang memberi luas sisi empat terbesar.
function bestQuadFromHull(hull) {
  let h = hull;
  if (h.length > 80) {
    const step = h.length / 80;
    h = Array.from({ length: 80 }, (_, i) => hull[Math.floor(i * step)]);
  }
  const n = h.length;
  if (n < 4) return null;
  const tri = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  let best = -1, bq = null;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      let m1 = -1, k1 = -1, m2 = -1, k2 = -1;
      for (let k = i + 1; k < j; k++) { const t = tri(h[i], h[j], h[k]); if (t > m1) { m1 = t; k1 = k; } }
      for (let k = j + 1; k < n + i; k++) { const kk = k % n; const t = tri(h[i], h[j], h[kk]); if (t > m2) { m2 = t; k2 = kk; } }
      if (k1 < 0 || k2 < 0) continue;
      if (m1 + m2 > best) { best = m1 + m2; bq = [h[i], h[k1], h[j], h[k2]]; }
    }
  }
  return bq;
}

function detectQuad(src) {
  const S = 360;
  const sc = Math.min(1, S / Math.max(src.width, src.height));
  const c = mkCanvas(src.width * sc, src.height * sc);
  const w = c.width, h = c.height, N = w * h;
  const cx = ctx2d(c);
  cx.drawImage(src, 0, 0, w, h);
  const d = cx.getImageData(0, 0, w, h).data;

  // kelabu + kabur kotak 5x5 (dua laluan)
  let g = new Float32Array(N);
  for (let i = 0; i < N; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const blur = (a, horiz) => {
    const o = new Float32Array(N), r = 2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = horiz ? x + k : x, yy = horiz ? y : y + k;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        s += a[yy * w + xx]; n++;
      }
      o[y * w + x] = s / n;
    }
    return o;
  };
  g = blur(blur(g, true), false);

  // ambang Otsu
  const hist = new Array(256).fill(0);
  for (let i = 0; i < N; i++) hist[g[i] | 0]++;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, maxV = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = N - wB; if (!wF) break;
    sB += t * hist[t];
    const mB = sB / wB, mF = (sum - sB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxV) { maxV = v; thr = t; }
  }

  // komponen terang terbesar (kertas biasanya lebih cerah dari latar)
  const lab = new Int32Array(N);
  const stack = new Int32Array(N);
  let bestId = 0, bestCnt = 0, id = 0;
  for (let i = 0; i < N; i++) {
    if (lab[i] || g[i] <= thr) continue;
    id++; let sp = 0, cnt = 0;
    stack[sp++] = i; lab[i] = id;
    while (sp) {
      const p = stack[--sp]; cnt++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && !lab[p - 1] && g[p - 1] > thr) { lab[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && !lab[p + 1] && g[p + 1] > thr) { lab[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && !lab[p - w] && g[p - w] > thr) { lab[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && !lab[p + w] && g[p + w] > thr) { lab[p + w] = id; stack[sp++] = p + w; }
    }
    if (cnt > bestCnt) { bestCnt = cnt; bestId = id; }
  }
  if (bestCnt < N * 0.08) return { quad: INSET_QUAD, found: false };

  // titik sempadan komponen → hull cembung → sisi empat terbaik
  const pts = [];
  for (let y = 0; y < h; y++) {
    let first = -1, last = -1;
    for (let x = 0; x < w; x++) if (lab[y * w + x] === bestId) { if (first < 0) first = x; last = x; }
    if (first >= 0) { pts.push([first, y]); if (last !== first) pts.push([last, y]); }
  }
  const hull = convexHull(pts);
  const q = bestQuadFromHull(hull);
  if (!q) return { quad: INSET_QUAD, found: false };
  const quad = orderQuad(q.map(([x, y]) => [(x + 0.5) / w, (y + 0.5) / h]));
  const a = polyArea(quad);
  if (a < 0.08 || a > 0.995) return { quad: a > 0.995 ? FULL_QUAD : INSET_QUAD, found: false };
  return { quad, found: true };
}

/* ------------------------------------------------------------------ */
/* Pembetulan perspektif                                               */
/* ------------------------------------------------------------------ */
function solve8(A, b) {
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    const v = A[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / v;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / (A[r][r] || 1e-12);
  }
  return x;
}
// homografi: (u,v) dalam segi empat tepat hasil → (x,y) dalam imej sumber
function homography(dst, src) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = dst[i], [x, y] = src[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  return solve8(A, b);
}

function warp(src, nquad) {
  const W = src.width, H = src.height;
  const q = nquad.map(([x, y]) => [x * W, y * H]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let ow = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  let oh = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const s = Math.min(1, MAX_OUT / Math.max(ow, oh));
  ow = Math.max(1, Math.round(ow * s)); oh = Math.max(1, Math.round(oh * s));
  const hm = homography([[0, 0], [ow, 0], [ow, oh], [0, oh]], q);
  const sd = ctx2d(src).getImageData(0, 0, W, H).data;
  const out = mkCanvas(ow, oh);
  const oc = ctx2d(out);
  const od = oc.createImageData(ow, oh);
  const o = od.data;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hm;
  let p = 0;
  for (let v = 0; v < oh; v++) {
    const vv = v + 0.5;
    for (let u = 0; u < ow; u++, p += 4) {
      const uu = u + 0.5;
      const den = h6 * uu + h7 * vv + 1;
      let x = (h0 * uu + h1 * vv + h2) / den - 0.5;
      let y = (h3 * uu + h4 * vv + h5) / den - 0.5;
      if (x < 0) x = 0; else if (x > W - 1.001) x = W - 1.001;
      if (y < 0) y = 0; else if (y > H - 1.001) y = H - 1.001;
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      const i00 = (y0 * W + x0) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      o[p] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
      o[p + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
      o[p + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
      o[p + 3] = 255;
    }
  }
  oc.putImageData(od, 0, 0);
  return out;
}

function rotate(c, deg) {
  deg = ((deg % 360) + 360) % 360;
  if (!deg) return c;
  const swap = deg === 90 || deg === 270;
  const o = mkCanvas(swap ? c.height : c.width, swap ? c.width : c.height);
  const x = ctx2d(o);
  x.translate(o.width / 2, o.height / 2);
  x.rotate((deg * Math.PI) / 180);
  x.drawImage(c, -c.width / 2, -c.height / 2);
  return o;
}

/* ------------------------------------------------------------------ */
/* Penapis                                                             */
/* ------------------------------------------------------------------ */
// Anggaran kecerahan kertas (tanpa teks): maks setempat pada grid kecil, dikaburkan, kemudian diinterpolasi.
function paperBackground(lum, w, h) {
  const bs = Math.max(4, Math.round(Math.max(w, h) / 120));
  const gw = Math.ceil(w / bs), gh = Math.ceil(h / bs);
  let g = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const gy = ((y / bs) | 0) * gw;
    for (let x = 0; x < w; x++) {
      const k = gy + ((x / bs) | 0), v = lum[y * w + x];
      if (v > g[k]) g[k] = v;
    }
  }
  // dilasi 1 sel (tutup baris teks tebal), kemudian purata 5x5
  const pass = (src, fn, r) => {
    const o = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let acc = 0, n = 0;
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
        const xx = x + i, yy = y + j;
        if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
        const v = src[yy * gw + xx];
        if (fn === 'max') { if (v > acc) acc = v; } else { acc += v; n++; }
      }
      o[y * gw + x] = fn === 'max' ? acc : acc / n;
    }
    return o;
  };
  g = pass(pass(g, 'max', 1), 'avg', 2);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let fy = y / bs - 0.5; if (fy < 0) fy = 0;
    const y0 = Math.min(gh - 1, fy | 0), y1 = Math.min(gh - 1, y0 + 1), ty = Math.min(1, fy - y0);
    for (let x = 0; x < w; x++) {
      let fx = x / bs - 0.5; if (fx < 0) fx = 0;
      const x0 = Math.min(gw - 1, fx | 0), x1 = Math.min(gw - 1, x0 + 1), tx = Math.min(1, fx - x0);
      const a = g[y0 * gw + x0] * (1 - tx) + g[y0 * gw + x1] * tx;
      const b = g[y1 * gw + x0] * (1 - tx) + g[y1 * gw + x1] * tx;
      out[y * w + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

function applyFilter(c, f) {
  if (f === 'original') return c;
  const w = c.width, h = c.height, N = w * h;
  const out = mkCanvas(w, h);
  const ox = ctx2d(out);
  ox.drawImage(c, 0, 0);
  const id = ox.getImageData(0, 0, w, h);
  const d = id.data;
  const lum = new Float32Array(N);
  for (let i = 0; i < N; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  if (f === 'gray') {
    for (let i = 0; i < N; i++) d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = lum[i];
  } else if (f === 'enhance') {
    // regangan kontras berdasarkan persentil 1% & 99%
    const hist = new Uint32Array(256);
    for (let i = 0; i < N; i++) hist[lum[i] | 0]++;
    let lo = 0, hi = 255, acc = 0;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > N * 0.01) { lo = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > N * 0.01) { hi = i; break; } }
    const sc = 255 / Math.max(1, hi - lo);
    for (let i = 0; i < N * 4; i++) { if ((i & 3) !== 3) d[i] = clamp((d[i] - lo) * sc); }
  } else if (f === 'magic' || f === 'bw') {
    const bg = paperBackground(lum, w, h);
    if (f === 'bw') {
      for (let i = 0; i < N; i++) {
        const v = lum[i] < bg[i] * 0.78 ? 0 : 255;
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
      }
    } else {
      // pembetulan pencahayaan: bahagi dengan anggaran warna kertas, kemudian tingkatkan kontras
      for (let i = 0; i < N; i++) {
        const k = 250 / Math.max(bg[i], 30);
        for (let ch = 0; ch < 3; ch++) {
          let v = d[i * 4 + ch] * k;
          v = (v - 255) * 1.4 + 255; // gelapkan teks, kekalkan putih
          d[i * 4 + ch] = clamp(v);
        }
      }
    }
  }
  ox.putImageData(id, 0, 0);
  return out;
}

/* ------------------------------------------------------------------ */
/* Penjana PDF (JPEG terbenam, tanpa pustaka luar)                      */
/* ------------------------------------------------------------------ */
const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

async function makePdf(pages, sizeMode) {
  const enc = new TextEncoder();
  const parts = [];
  let len = 0;
  const offs = [];
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const n = pages.length;
  const total = 2 + n * 3;

  push('%PDF-1.4\n%âãÏÓ\n');
  offs[1] = len; push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  offs[2] = len; push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);

  for (let i = 0; i < n; i++) {
    const pg = pages[i];
    const jpg = new Uint8Array(await pg.processed.arrayBuffer());
    const iw = pg.w, ih = pg.h;
    let pw, ph, dw, dh, dx, dy;
    if (sizeMode === 'fit') {
      pw = 595.28; ph = (pw * ih) / iw; dw = pw; dh = ph; dx = 0; dy = 0;
    } else {
      let [a, b] = PAGE_SIZES[sizeMode] || PAGE_SIZES.a4;
      if (iw > ih) [a, b] = [b, a];
      pw = a; ph = b;
      const s = Math.min(pw / iw, ph / ih);
      dw = iw * s; dh = ih * s; dx = (pw - dw) / 2; dy = (ph - dh) / 2;
    }
    const f = (v) => v.toFixed(2);
    const pObj = 3 + i * 3, cObj = pObj + 1, iObj = pObj + 2;
    offs[pObj] = len;
    push(`${pObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(pw)} ${f(ph)}] ` +
      `/Resources << /XObject << /Im0 ${iObj} 0 R >> >> /Contents ${cObj} 0 R >>\nendobj\n`);
    const content = `q ${f(dw)} 0 0 ${f(dh)} ${f(dx)} ${f(dy)} cm /Im0 Do Q`;
    offs[cObj] = len;
    push(`${cObj} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
    offs[iObj] = len;
    push(`${iObj} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${iw} /Height ${ih} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
    push(jpg);
    push('\nendstream\nendobj\n');
  }
  const xref = len;
  let x = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) x += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
  push(x);
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

/* ------------------------------------------------------------------ */
/* Keadaan aplikasi                                                    */
/* ------------------------------------------------------------------ */
let pages = [];      // {id, order, original, quad, rotation, filter, processed, w, h, url}
let cur = null;      // sesi suntingan semasa
let lastFilter = localStorage.getItem('lastFilter') || 'magic';

function show(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === id));
}

function defaultName() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `Imbasan_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function renderHome() {
  const grid = $('#grid');
  grid.innerHTML = '';
  pages.forEach((pg, i) => {
    if (!pg.url) pg.url = URL.createObjectURL(pg.processed);
    const b = document.createElement('button');
    b.className = 'thumb';
    b.innerHTML = `<img alt=""><span class="num">${i + 1}</span>`;
    b.querySelector('img').src = pg.url;
    b.onclick = () => openExisting(pg);
    grid.appendChild(b);
  });
  $('#empty').hidden = pages.length > 0;
  $('#exportBar').hidden = pages.length === 0;
  $('#btnClear').style.visibility = pages.length ? 'visible' : 'hidden';
  if (!$('#docName').value) $('#docName').value = defaultName();
}

async function loadPages() {
  try {
    pages = (await DB.all()).sort((a, b) => a.order - b.order);
  } catch (e) {
    console.warn(e);
    pages = [];
  }
  renderHome();
}

/* ---------- Tangkapan / import ---------- */
async function handleFiles(files, fromCamera) {
  files = [...files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name));
  if (!files.length) return;
  if (files.length === 1) {
    busy(true, 'Mengesan dokumen…');
    await nextFrame();
    try {
      const src = await loadSource(files[0]);
      const det = detectQuad(src);
      cur = { page: null, original: files[0], src, quad: det.quad, rotation: 0, filter: lastFilter, fromCamera };
      openCrop();
      if (!det.found) toast('Tepi tidak dikesan — laraskan sudut secara manual');
    } catch (e) {
      alert('Gagal membuka imej: ' + e.message);
    } finally {
      busy(false);
    }
    return;
  }
  // banyak imej: proses automatik, boleh disunting kemudian
  for (let i = 0; i < files.length; i++) {
    busy(true, `Memproses ${i + 1}/${files.length}…`);
    await nextFrame();
    try {
      const src = await loadSource(files[i]);
      const det = detectQuad(src);
      cur = { page: null, original: files[i], src, quad: det.quad, rotation: 0, filter: lastFilter };
      await saveCurrent(false);
    } catch (e) {
      console.error(e);
      toast(`Imej ${i + 1} gagal diproses`);
    }
  }
  cur = null;
  busy(false);
  renderHome();
  toast(`${files.length} halaman ditambah`);
}

async function openExisting(pg) {
  busy(true, 'Membuka…');
  await nextFrame();
  try {
    const src = await loadSource(pg.original);
    cur = { page: pg, original: pg.original, src, quad: pg.quad, rotation: pg.rotation, filter: pg.filter };
    cur.warped = warp(src, cur.quad);
    openEdit();
  } finally {
    busy(false);
  }
}

/* ---------- Paparan potong (crop) ---------- */
const crop = { disp: null, scale: 1, cw: 0, ch: 0, drag: -1, dpr: 1 };
const cropCanvas = $('#cropCanvas');
const loupe = $('#loupe');

function openCrop() {
  cur.quadBak = cur.quad;
  show('crop');
  requestAnimationFrame(layoutCrop);
}

function layoutCrop() {
  if (!cur) return;
  const wrap = $('#cropWrap');
  const pad = 22;
  const W = wrap.clientWidth - pad * 2, H = wrap.clientHeight - pad * 2;
  const s = Math.min(W / cur.src.width, H / cur.src.height);
  crop.cw = Math.round(cur.src.width * s);
  crop.ch = Math.round(cur.src.height * s);
  crop.dpr = window.devicePixelRatio || 1;
  cropCanvas.style.width = crop.cw + 'px';
  cropCanvas.style.height = crop.ch + 'px';
  cropCanvas.width = crop.cw * crop.dpr;
  cropCanvas.height = crop.ch * crop.dpr;
  crop.disp = mkCanvas(cropCanvas.width, cropCanvas.height);
  const dx = crop.disp.getContext('2d');
  dx.imageSmoothingQuality = 'high';
  dx.drawImage(cur.src, 0, 0, crop.disp.width, crop.disp.height);
  drawCrop();
}

function drawCrop() {
  const c = cropCanvas.getContext('2d');
  const W = cropCanvas.width, H = cropCanvas.height, r = crop.dpr;
  c.clearRect(0, 0, W, H);
  c.drawImage(crop.disp, 0, 0);
  const P = cur.quad.map(([x, y]) => [x * W, y * H]);
  // gelapkan luar kawasan
  c.save();
  c.fillStyle = 'rgba(0,0,0,0.45)';
  c.beginPath();
  c.rect(0, 0, W, H);
  c.moveTo(P[0][0], P[0][1]);
  for (let i = 3; i >= 1; i--) c.lineTo(P[i][0], P[i][1]);
  c.closePath();
  c.fill('evenodd');
  c.restore();
  c.strokeStyle = '#2dd4bf';
  c.lineWidth = 2.5 * r;
  c.beginPath();
  P.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.closePath();
  c.stroke();
  P.forEach(([x, y], i) => {
    c.beginPath();
    c.arc(x, y, (crop.drag === i ? 16 : 12) * r, 0, Math.PI * 2);
    c.fillStyle = 'rgba(45,212,191,0.35)';
    c.fill();
    c.lineWidth = 3 * r;
    c.strokeStyle = '#fff';
    c.stroke();
  });
}

function drawLoupe(nx, ny) {
  const lc = loupe.getContext('2d');
  const L = loupe.width, zoom = 3;
  const sx = nx * cur.src.width, sy = ny * cur.src.height;
  const viewPx = ((loupe.clientWidth || 120) / zoom) * (cur.src.width / crop.cw);
  lc.fillStyle = '#000';
  lc.fillRect(0, 0, L, L);
  lc.imageSmoothingEnabled = true;
  lc.drawImage(cur.src, sx - viewPx / 2, sy - viewPx / 2, viewPx, viewPx, 0, 0, L, L);
  // garisan sisi empat dalam loupe
  const toL = ([x, y]) => [((x * cur.src.width - sx) / viewPx + 0.5) * L, ((y * cur.src.height - sy) / viewPx + 0.5) * L];
  lc.strokeStyle = '#2dd4bf';
  lc.lineWidth = 3;
  lc.beginPath();
  cur.quad.map(toL).forEach(([x, y], i) => (i ? lc.lineTo(x, y) : lc.moveTo(x, y)));
  lc.closePath();
  lc.stroke();
  lc.strokeStyle = '#f43f5e';
  lc.lineWidth = 2;
  lc.beginPath();
  lc.moveTo(L / 2 - 14, L / 2); lc.lineTo(L / 2 + 14, L / 2);
  lc.moveTo(L / 2, L / 2 - 14); lc.lineTo(L / 2, L / 2 + 14);
  lc.stroke();
  loupe.classList.toggle('right', nx < 0.35 && ny < 0.35);
}

function evtNorm(e) {
  const r = cropCanvas.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height, r];
}

cropCanvas.addEventListener('pointerdown', (e) => {
  if (!cur) return;
  const [nx, ny, r] = evtNorm(e);
  let best = -1, bd = 44; // px
  cur.quad.forEach(([x, y], i) => {
    const d = Math.hypot((x - nx) * r.width, (y - ny) * r.height);
    if (d < bd) { bd = d; best = i; }
  });
  if (best < 0) return;
  crop.drag = best;
  crop.grab = [cur.quad[best][0] - nx, cur.quad[best][1] - ny];
  cropCanvas.setPointerCapture(e.pointerId);
  loupe.hidden = false;
  drawLoupe(...cur.quad[best]);
  drawCrop();
  e.preventDefault();
});
cropCanvas.addEventListener('pointermove', (e) => {
  if (crop.drag < 0) return;
  const [nx, ny] = evtNorm(e);
  const x = Math.min(1, Math.max(0, nx + crop.grab[0]));
  const y = Math.min(1, Math.max(0, ny + crop.grab[1]));
  cur.quad = cur.quad.slice();
  cur.quad[crop.drag] = [x, y];
  drawCrop();
  drawLoupe(x, y);
});
const endDrag = () => {
  if (crop.drag < 0) return;
  crop.drag = -1;
  loupe.hidden = true;
  cur.quad = orderQuad(cur.quad);
  drawCrop();
};
cropCanvas.addEventListener('pointerup', endDrag);
cropCanvas.addEventListener('pointercancel', endDrag);
window.addEventListener('resize', () => { if ($('#crop').classList.contains('active')) layoutCrop(); });

$('#cropAuto').onclick = () => {
  const det = detectQuad(cur.src);
  cur.quad = det.quad;
  drawCrop();
  if (!det.found) toast('Tepi dokumen tidak dikesan');
};
$('#cropFull').onclick = () => { cur.quad = FULL_QUAD.map((p) => p.slice()); drawCrop(); };
$('#cropCancel').onclick = () => {
  if (cur && cur.warped) { cur.quad = cur.quadBak; openEdit(); return; }
  cur = null;
  show('home');
};
$('#cropNext').onclick = async () => {
  busy(true, 'Meluruskan dokumen…');
  await nextFrame();
  try {
    cur.warped = warp(cur.src, cur.quad);
    openEdit();
  } finally {
    busy(false);
  }
};

/* ---------- Paparan sunting ---------- */
function openEdit() {
  show('edit');
  const idx = cur.page ? pages.indexOf(cur.page) : -1;
  $('#editTitle').textContent = idx >= 0 ? `Halaman ${idx + 1}` : 'Halaman baru';
  $('#editDelete').style.visibility = cur.page ? 'visible' : 'hidden';
  $('#moveL').hidden = $('#moveR').hidden = !cur.page;
  renderPreview();
}

function buildOutput() {
  return applyFilter(rotate(cur.warped, cur.rotation), cur.filter);
}

async function renderPreview() {
  document.querySelectorAll('#filters button').forEach((b) => b.classList.toggle('on', b.dataset.f === cur.filter));
  busy(true);
  await nextFrame();
  try {
    cur.out = buildOutput();
    const wrap = $('#previewWrap');
    wrap.innerHTML = '';
    wrap.appendChild(cur.out);
  } finally {
    busy(false);
  }
}

$('#filters').addEventListener('click', (e) => {
  const f = e.target.dataset && e.target.dataset.f;
  if (!f || !cur) return;
  cur.filter = f;
  lastFilter = f;
  localStorage.setItem('lastFilter', f);
  renderPreview();
});
$('#rotL').onclick = () => { cur.rotation = (cur.rotation + 270) % 360; renderPreview(); };
$('#rotR').onclick = () => { cur.rotation = (cur.rotation + 90) % 360; renderPreview(); };
$('#recrop').onclick = () => openCrop();
$('#editBack').onclick = () => { cur = null; show('home'); };

async function saveCurrent(useCurOut = true) {
  const out = useCurOut && cur.out ? cur.out : (cur.warped || (cur.warped = warp(cur.src, cur.quad)), buildOutput());
  const blob = await toBlob(out);
  const pg = cur.page || {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    order: pages.length ? pages[pages.length - 1].order + 1 : 0,
    original: cur.original,
  };
  Object.assign(pg, { quad: cur.quad, rotation: cur.rotation, filter: cur.filter, processed: blob, w: out.width, h: out.height });
  if (pg.url) { URL.revokeObjectURL(pg.url); pg.url = null; }
  const rec = { ...pg };
  delete rec.url;
  await DB.put(rec);
  if (!cur.page) pages.push(pg);
}

$('#editSave').onclick = async () => {
  busy(true, 'Menyimpan…');
  try {
    const isNew = !cur.page;
    const fromCamera = cur.fromCamera;
    await saveCurrent(true);
    cur = null;
    renderHome();
    show('home');
    toast('Halaman disimpan');
    if (isNew && fromCamera && confirm('Imbas halaman seterusnya?')) $('#inCamera').click();
  } catch (e) {
    alert('Gagal menyimpan: ' + e.message);
  } finally {
    busy(false);
  }
};

$('#editDelete').onclick = async () => {
  if (!cur.page || !confirm('Padam halaman ini?')) return;
  await DB.del(cur.page.id);
  if (cur.page.url) URL.revokeObjectURL(cur.page.url);
  pages = pages.filter((p) => p !== cur.page);
  cur = null;
  renderHome();
  show('home');
};

async function movePage(dir) {
  const i = pages.indexOf(cur.page), j = i + dir;
  if (i < 0 || j < 0 || j >= pages.length) return;
  [pages[i], pages[j]] = [pages[j], pages[i]];
  pages.forEach((p, k) => (p.order = k));
  await Promise.all([pages[i], pages[j]].map((p) => { const r = { ...p }; delete r.url; return DB.put(r); }));
  $('#editTitle').textContent = `Halaman ${j + 1}`;
  renderHome();
  toast(`Dialih ke kedudukan ${j + 1}`);
}
$('#moveL').onclick = () => movePage(-1);
$('#moveR').onclick = () => movePage(1);

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

$('#saveJpg').onclick = async () => {
  const blob = await toBlob(cur.out || buildOutput(), 'image/jpeg', 0.92);
  download(blob, `${$('#docName').value || defaultName()}.jpg`);
};

/* ---------- Eksport ---------- */
const fileName = () => ($('#docName').value.trim() || defaultName()).replace(/[\\/:*?"<>|]+/g, '_') + '.pdf';

async function buildPdfFile() {
  busy(true, 'Menjana PDF…');
  await nextFrame();
  try {
    const blob = await makePdf(pages, $('#pageSize').value);
    return new File([blob], fileName(), { type: 'application/pdf' });
  } finally {
    busy(false);
  }
}

$('#btnPdf').onclick = async () => {
  if (!pages.length) return;
  const f = await buildPdfFile();
  download(f, f.name);
  toast(`PDF disimpan (${(f.size / 1024 / 1024).toFixed(1)} MB)`);
};

if (navigator.canShare && navigator.canShare({ files: [new File([''], 'x.pdf', { type: 'application/pdf' })] })) {
  $('#btnShare').hidden = false;
}
$('#btnShare').onclick = async () => {
  if (!pages.length) return;
  const f = await buildPdfFile();
  try {
    await navigator.share({ files: [f], title: f.name });
  } catch (e) {
    if (e.name !== 'AbortError') download(f, f.name);
  }
};

$('#btnClear').onclick = async () => {
  if (!pages.length || !confirm('Padam semua halaman?')) return;
  await DB.clear();
  pages.forEach((p) => p.url && URL.revokeObjectURL(p.url));
  pages = [];
  $('#docName').value = '';
  renderHome();
};

$('#inCamera').onchange = (e) => { handleFiles(e.target.files, true); e.target.value = ''; };
$('#inGallery').onchange = (e) => { handleFiles(e.target.files, false); e.target.value = ''; };

$('#pageSize').value = localStorage.getItem('pageSize') || 'a4';
$('#pageSize').onchange = (e) => localStorage.setItem('pageSize', e.target.value);

loadPages();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
