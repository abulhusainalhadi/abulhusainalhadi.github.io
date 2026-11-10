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
    const r = indexedDB.open('pengimbas', 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  return {
    allPages: () => run('pages', 'readonly', (s) => s.getAll()),
    putPage: (p) => run('pages', 'readwrite', (s) => s.put(p)),
    delPage: (id) => run('pages', 'readwrite', (s) => s.delete(id)),
    allDocs: () => run('docs', 'readonly', (s) => s.getAll()),
    putDoc: (d) => run('docs', 'readwrite', (s) => s.put(d)),
    delDoc: (id) => run('docs', 'readwrite', (s) => s.delete(id)),
    clearAll: async () => {
      await run('pages', 'readwrite', (s) => s.clear());
      await run('docs', 'readwrite', (s) => s.clear());
    },
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

function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, maxV = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sB += t * hist[t];
    const mB = sB / wB, mF = (sum - sB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxV) { maxV = v; thr = t; }
  }
  return thr;
}

// Komponen bersambung terbesar dalam topeng (mask) 0/1
function largestComponent(mask, w, h) {
  const N = w * h, lab = new Int32Array(N), stack = new Int32Array(N);
  let bestId = 0, bestCnt = 0, id = 0;
  for (let i = 0; i < N; i++) {
    if (lab[i] || !mask[i]) continue;
    id++; let sp = 0, cnt = 0;
    stack[sp++] = i; lab[i] = id;
    while (sp) {
      const p = stack[--sp]; cnt++;
      const x = p % w;
      if (x > 0 && !lab[p - 1] && mask[p - 1]) { lab[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && !lab[p + 1] && mask[p + 1]) { lab[p + 1] = id; stack[sp++] = p + 1; }
      if (p >= w && !lab[p - w] && mask[p - w]) { lab[p - w] = id; stack[sp++] = p - w; }
      if (p < N - w && !lab[p + w] && mask[p + w]) { lab[p + w] = id; stack[sp++] = p + w; }
    }
    if (cnt > bestCnt) { bestCnt = cnt; bestId = id; }
  }
  return { lab, id: bestId, cnt: bestCnt };
}

// Kotak bersempadan minimum bagi hull (rotating calipers) — sentiasa segi empat
function minAreaRect(hull) {
  const n = hull.length;
  if (n < 3) return null;
  let best = null, bestA = Infinity;
  for (let i = 0; i < n; i++) {
    const p = hull[i], q = hull[(i + 1) % n];
    const ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const c = Math.cos(ang), sn = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of hull) {
      const u = x * c + y * sn, v = -x * sn + y * c;
      if (u < u0) u0 = u; if (u > u1) u1 = u;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const A = (u1 - u0) * (v1 - v0);
    if (A < bestA) {
      bestA = A;
      best = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => [u * c - v * sn, u * sn + v * c]);
    }
  }
  return best;
}
// Sudut dalaman mesti hampir 90° (70°–110°) — bukan segi tiga atau bentuk pelik
function isRectish(q) {
  for (let i = 0; i < 4; i++) {
    const p = q[i], a = q[(i + 3) % 4], b = q[(i + 1) % 4];
    const v1 = [a[0] - p[0], a[1] - p[1]], v2 = [b[0] - p[0], b[1] - p[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) + 1e-9);
    if (Math.abs(cos) > 0.34) return false;
  }
  return true;
}

// Morfologi kotak: dilate (mode 1) atau erode (mode 0), jejari r — dua laluan (sepadan)
function morph(mask, w, h, r, dilate) {
  const N = w * h, t = new Uint8Array(N), o = new Uint8Array(N);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = dilate ? 0 : 1;
    for (let k = -r; k <= r; k++) {
      const xx = x + k;
      const inside = xx >= 0 && xx < w;
      const m = inside ? mask[y * w + xx] : 0;
      if (dilate ? m : !m) { v = dilate ? 1 : 0; break; }
    }
    t[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = dilate ? 0 : 1;
    for (let k = -r; k <= r; k++) {
      const yy = y + k;
      const inside = yy >= 0 && yy < h;
      const m = inside ? t[yy * w + x] : 0;
      if (dilate ? m : !m) { v = dilate ? 1 : 0; break; }
    }
    o[y * w + x] = v;
  }
  return o;
}

// Nilai satu calon kawasan → sisi empat segi (sahaja) + skor
function evalRegion(comp, w, h, shrinkPx, sat) {
  if (comp.cnt < w * h * 0.08) return null;
  const { lab, id } = comp, pts = [];
  for (let y = 0; y < h; y++) {
    let first = -1, last = -1;
    for (let x = 0; x < w; x++) if (lab[y * w + x] === id) { if (first < 0) first = x; last = x; }
    if (first >= 0) { pts.push([first, y]); if (last !== first) pts.push([last + 1, y]); }
  }
  const hull = convexHull(pts);
  if (hull.length < 3) return null;
  let quad = null;
  const q = bestQuadFromHull(hull);
  if (q) { const oq = orderQuad(q); if (isRectish(oq)) quad = oq; }
  if (!quad) { const r = minAreaRect(hull); if (!r) return null; quad = orderQuad(r); }
  const A = polyArea(quad);
  const fit = comp.cnt / A;
  if (A < w * h * 0.1 || A > w * h * 0.995 || fit < 0.82) return null;
  if (shrinkPx) {
    const cx = quad.reduce((s, p) => s + p[0], 0) / 4, cy = quad.reduce((s, p) => s + p[1], 0) / 4;
    quad = quad.map(([x, y]) => {
      const d = Math.hypot(x - cx, y - cy) || 1;
      const k = (shrinkPx * 1.41) / d;
      return [x + (cx - x) * k, y + (cy - y) * k];
    });
  }
  const qn = quad.map(([x, y]) => [x / w, y / h]);
  // Kertas biasanya neutral: kawasan yang banyak warna tepu (fail, kayu, meja) ditolak
  const col = colorFrac(qn, w, h, sat);
  const touch = qn.filter(([x, y]) => x < 0.02 || x > 0.98 || y < 0.02 || y > 0.98).length;
  const score = A * Math.min(1, fit) ** 4 * Math.max(0, 1 - col * 5) * (touch >= 2 ? 0.5 : 1);
  return { quad: qn, score };
}

// Pecahan piksel dalam sisi empat (dinormal) yang tepu warnanya
function colorFrac(q, w, h, sat) {
  const Q = q.map(([x, y]) => [x * w, y * h]);
  const x0 = Math.max(0, Math.floor(Math.min(...Q.map((p) => p[0])))), x1 = Math.min(w - 1, Math.ceil(Math.max(...Q.map((p) => p[0]))));
  const y0 = Math.max(0, Math.floor(Math.min(...Q.map((p) => p[1])))), y1 = Math.min(h - 1, Math.ceil(Math.max(...Q.map((p) => p[1]))));
  let inside = 0, colored = 0;
  for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) {
    let pos = 0, neg = 0;
    for (let k = 0; k < 4; k++) {
      const a = Q[k], b = Q[(k + 1) % 4];
      const cr = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
      if (cr > 0) pos++; else if (cr < 0) neg++;
    }
    if (pos === 0 || neg === 0) { inside++; if (sat[y * w + x] > 0.18) colored++; }
  }
  return inside ? colored / inside : 1;
}

function detectQuad(src) {
  const S = 400;
  const sc = Math.min(1, S / Math.max(src.width, src.height));
  const c = mkCanvas(src.width * sc, src.height * sc);
  const w = c.width, h = c.height, N = w * h;
  const cx = ctx2d(c);
  cx.drawImage(src, 0, 0, w, h);
  const d = cx.getImageData(0, 0, w, h).data;

  // kelabu (asal) + kabur kotak 5x5 (dua laluan)
  let g = new Float32Array(N);
  for (let i = 0; i < N; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const raw = g.slice();
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
  const sat = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const r = d[i * 4], gg = d[i * 4 + 1], b = d[i * 4 + 2];
    const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
    sat[i] = mx ? (mx - mn) / mx : 0;
  }
  const cands = [];

  // Calon A: kawasan yang dikelilingi tepi (Sobel) — tidak bergantung pada warna latar
  {
    const mag = new Float32Array(N);
    const hist = new Uint32Array(256);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1];
      const gy = g[i + w - 1] + 2 * g[i + w] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - w] - g[i - w + 1];
      const m = Math.min(255, Math.hypot(gx, gy) / 4);
      mag[i] = m; hist[m | 0]++;
    }
    for (const lowMul of [1, 0.55, 0.3]) {
      const thr = Math.max(5, otsu(hist, N) * lowMul);
      let edge = new Uint8Array(N);
      for (let i = 0; i < N; i++) edge[i] = mag[i] > thr ? 1 : 0;
      // dilasi 2px untuk menutup celah kecil pada tepi kertas
      for (let pass = 0; pass < 2; pass++) {
        const e2 = new Uint8Array(N);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = y * w + x;
          e2[i] = edge[i] || (x > 0 && edge[i - 1]) || (x < w - 1 && edge[i + 1]) ||
            (y > 0 && edge[i - w]) || (y < h - 1 && edge[i + w]) ? 1 : 0;
        }
        edge = e2;
      }
      // banjir dari sempadan imej melalui piksel bukan-tepi = "luar"
      const out = new Uint8Array(N), st = new Int32Array(N);
      let sp = 0;
      const seed = (i) => { if (!edge[i] && !out[i]) { out[i] = 1; st[sp++] = i; } };
      for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
      for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
      while (sp) {
        const p = st[--sp], x = p % w;
        if (x > 0) seed(p - 1);
        if (x < w - 1) seed(p + 1);
        if (p >= w) seed(p - w);
        if (p < N - w) seed(p + w);
      }
      for (let i = 0; i < N; i++) out[i] = out[i] ? 0 : 1;
      const r = evalRegion(largestComponent(out, w, h), w, h, 2.5, sat);
      if (r) { r.score *= 1.1; cands.push(r); }
    }
  }

  // Calon B: komponen terang terbesar (kertas cerah atas latar gelap)
  {
    const hist = new Uint32Array(256);
    for (let i = 0; i < N; i++) hist[g[i] | 0]++;
    const thr = otsu(hist, N);
    const mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) mask[i] = g[i] > thr ? 1 : 0;
    const r = evalRegion(largestComponent(mask, w, h), w, h, 0, sat);
    if (r) cands.push(r);
  }

  // Calon C: kertas = kawasan cerah DAN neutral (ketepuan rendah). Fail/kayu berwarna tidak lulus.
  {
    const hist = new Uint32Array(256);
    let cnt = 0;
    for (let i = 0; i < N; i++) if (sat[i] < 0.14) { hist[raw[i] | 0]++; cnt++; }
    if (cnt > N * 0.05) {
      const thr = otsu(hist, cnt);
      const mask = new Uint8Array(N);
      for (let i = 0; i < N; i++) mask[i] = sat[i] < 0.14 && raw[i] > thr ? 1 : 0;
      // tutup lubang teks hitam di atas kertas (dilasi 3px kemudian hakisan 3px)
      const closed = morph(mask, w, h, 3, 1);
      const cm = morph(closed, w, h, 3, 0);
      const r = evalRegion(largestComponent(cm, w, h), w, h, 0, sat);
      if (r) { r.score *= 1.15; cands.push(r); }
    }
  }

  if (!cands.length) return { quad: INSET_QUAD, found: false };
  cands.sort((a, b) => b.score - a.score);
  return { quad: cands[0].quad, found: true };
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
/* Penjana PDF (JPEG terbenam + lapisan teks OCR tersembunyi)           */
/* ------------------------------------------------------------------ */
const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

// Rentetan → bait Latin-1 (WinAnsi); aksara di luar julat diganti '?'
function latin1(str) {
  const b = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    b[i] = c < 256 ? c : 63;
  }
  return b;
}
const pdfEsc = (t) => t.replace(/[\\()]/g, (m) => '\\' + m).replace(/[\r\n\t]/g, ' ');
let measureCtx;
function textWidth(t, size) {
  if (!measureCtx) measureCtx = mkCanvas(1, 1).getContext('2d');
  measureCtx.font = `${size}px Helvetica, Arial, sans-serif`;
  return measureCtx.measureText(t).width || size * 0.5 * t.length;
}

function ocrLayer(pg, dx, dy, dw, dh) {
  const o = pg.ocr;
  if (!o || !o.words || !o.words.length) return '';
  const sx = dw / o.w, sy = dh / o.h, f = (v) => v.toFixed(2);
  let s = 'BT 3 Tr\n';
  for (const [t, x0, y0, x1, y1] of o.words) {
    const hPt = (y1 - y0) * sy, wPt = (x1 - x0) * sx;
    if (hPt <= 0 || wPt <= 0) continue;
    const size = Math.max(1, hPt);
    const tz = Math.max(10, Math.min(1000, (wPt / textWidth(t, size)) * 100));
    const X = dx + x0 * sx, Y = dy + (o.h - y1) * sy + hPt * 0.2;
    s += `/F1 ${f(size)} Tf ${f(tz)} Tz 1 0 0 1 ${f(X)} ${f(Y)} Tm (${pdfEsc(t)}) Tj\n`;
  }
  return s + 'ET\n';
}

async function makePdf(pages, sizeMode) {
  const parts = [];
  let len = 0;
  const offs = [];
  const push = (x) => { const b = typeof x === 'string' ? latin1(x) : x; parts.push(b); len += b.length; };
  const n = pages.length;
  const total = 3 + n * 3;

  push('%PDF-1.4\n%âãÏÓ\n');
  offs[1] = len; push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  const kids = pages.map((_, i) => `${4 + i * 3} 0 R`).join(' ');
  offs[2] = len; push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);
  offs[3] = len; push('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n');

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
    const pObj = 4 + i * 3, cObj = pObj + 1, iObj = pObj + 2;
    offs[pObj] = len;
    push(`${pObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(pw)} ${f(ph)}] ` +
      `/Resources << /XObject << /Im0 ${iObj} 0 R >> /Font << /F1 3 0 R >> >> /Contents ${cObj} 0 R >>\nendobj\n`);
    const content = latin1(`q ${f(dw)} 0 0 ${f(dh)} ${f(dx)} ${f(dy)} cm /Im0 Do Q\n` + ocrLayer(pg, dx, dy, dw, dh));
    offs[cObj] = len;
    push(`${cObj} 0 obj\n<< /Length ${content.length} >>\nstream\n`);
    push(content);
    push('\nendstream\nendobj\n');
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
/* Keadaan: dokumen, halaman & tetapan                                  */
/* ------------------------------------------------------------------ */
// pages: {id, docId, order, created, original, quad, rotation, filter, processed, w, h, ocr, driveId, driveSynced, docsSynced, url}
// docs:  {id, name, created, kind:'single'|'batch', closed, pdfDriveId, pdfSynced}
let pages = [];
let docs = [];
let cur = null;               // sesi tangkapan / sunting semasa
let view = { docId: null };   // dokumen yang sedang dibuka
let pickTarget = null;        // dokumen sasaran bila tambah halaman dari paparan dokumen
let lastFilter = localStorage.getItem('lastFilter') || 'magic';

const DEFAULTS = {
  mode: 'single', batchDocId: null,
  autoOcr: true, ocrLang: 'msa+eng',
  format: 'pdf', pageSize: localStorage.getItem('pageSize') || 'a4',
  driveClientId: '', driveFolder: 'Pengimbas Dokumen',
  driveAuto: true, drivePages: true, drivePdf: true, driveDocs: false,
};
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('settings') || '{}')); } catch {}
const saveSettings = () => localStorage.setItem('settings', JSON.stringify(settings));

const pad2 = (n) => String(n).padStart(2, '0');
function stamp(t, secs) {
  const d = new Date(t);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${secs ? pad2(d.getSeconds()) : ''}`;
}
const defaultName = () => 'Dokumen_' + stamp(Date.now(), true);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const getDoc = (id) => docs.find((d) => d.id === id) || null;
const docPages = (id) => pages.filter((p) => p.docId === id).sort((a, b) => a.order - b.order);
const nextOrder = () => pages.reduce((m, p) => Math.max(m, p.order), -1) + 1;
const safeName = (s) => (s || '').trim().replace(/[\\/:*?"<>|]+/g, '_') || 'Dokumen';
const docBase = (d) => safeName(d.name);
const pageFile = (d, i) => `${docBase(d)}_${pad2(i + 1)}`;
const baseName = (f) => (f.name || '').replace(/\.[^.]+$/, '');
const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const isImg = (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name);

function makeDoc(name, opts = {}) {
  return {
    id: uid(), name: (name || '').trim() || defaultName(), created: Date.now(),
    kind: opts.kind || 'single', closed: opts.closed !== undefined ? opts.closed : true,
    pdfDriveId: null, pdfSynced: false,
  };
}
const persistPage = (pg) => { const r = { ...pg }; delete r.url; return DB.putPage(r); };
const persistDoc = (d) => DB.putDoc({ ...d });

/* ---------- Batch ---------- */
const batchDoc = () => (settings.batchDocId && getDoc(settings.batchDocId)) || null;
function openBatch() {
  let d = batchDoc();
  if (!d) {
    d = makeDoc('', { kind: 'batch', closed: false });
    docs.push(d);
    settings.batchDocId = d.id;
    saveSettings();
    persistDoc(d);
  }
  return d;
}
// Sasaran tangkapan: paparan dokumen > batch terbuka > dokumen tunggal baharu
function targetFor(explicitId) {
  if (explicitId && getDoc(explicitId)) return { docId: explicitId };
  if (settings.mode === 'batch') return { docId: openBatch().id };
  return { docId: null };
}

async function markDocChanged(docId, allPages = true) {
  const d = getDoc(docId);
  if (!d) return;
  d.pdfSynced = false;
  await persistDoc(d);
  if (allPages) for (const p of docPages(docId)) { p.driveSynced = false; await persistPage(p); }
}

async function deletePage(pg) {
  const docId = pg.docId;
  await DB.delPage(pg.id);
  if (pg.url) URL.revokeObjectURL(pg.url);
  pages = pages.filter((p) => p !== pg);
  if (!docPages(docId).length && settings.batchDocId !== docId) {
    const d = getDoc(docId);
    docs = docs.filter((x) => x !== d);
    await DB.delDoc(docId);
  } else {
    await markDocChanged(docId, true);
  }
}

async function docFile(d, size) {
  const blob = await makePdf(docPages(d.id), size);
  return new File([blob], docBase(d) + '.pdf', { type: 'application/pdf' });
}

function ocrTextOf(ps) {
  const one = (p) => (p.ocr && p.ocr.text ? p.ocr.text : '(tiada teks)');
  if (ps.length === 1) return one(ps[0]) + '\n';
  return ps.map((p, i) => `--- Halaman ${i + 1} ---\n${one(p)}`).join('\n\n') + '\n';
}

/* ---------- Keadaan OCR & Drive ---------- */
const ocrState = { running: null, page: null, progress: 0, phase: '', skip: new Set() };
const driveState = { busy: false, again: false, files: [], error: '' };

const driveOn = () => !!settings.driveClientId;
// Halaman JPG & Google Docs hanya untuk dokumen Tunggal; batch dihantar sebagai satu PDF
const pagePendingDrive = (pg) => {
  const d = getDoc(pg.docId);
  if (!d || d.kind !== 'single' || !d.closed || !settings.driveAuto) return false;
  return (settings.drivePages && !pg.driveSynced) || (settings.driveDocs && !pg.docsSynced);
};
const docPendingDrive = (d) => {
  const n = docPages(d.id).length;
  return settings.driveAuto && settings.drivePdf && d.closed && !d.pdfSynced && n > 0 &&
    (d.kind === 'batch' || n > 1);
};
const drivePendingCount = () => (driveOn()
  ? pages.filter(pagePendingDrive).length + docs.filter(docPendingDrive).length + driveState.files.length
  : 0);

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
  // pemegang tengah sisi (tarik seluruh sisi)
  for (let i = 0; i < 4; i++) {
    const p = P[i], q = P[(i + 1) % 4];
    const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
    const ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
    c.save();
    c.translate(mx, my);
    c.rotate(ang);
    c.beginPath();
    const L = (crop.drag === 4 + i ? 34 : 26) * r, T = 10 * r;
    c.roundRect ? c.roundRect(-L / 2, -T / 2, L, T, T / 2) : c.rect(-L / 2, -T / 2, L, T);
    c.fillStyle = '#fff';
    c.fill();
    c.restore();
  }
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
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const cropWrap = $('#cropWrap');

// Acara dipasang pada seluruh kawasan (bukan kanvas sahaja) supaya sentuhan
// yang sedikit terkeluar dari gambar masih boleh menarik sudut/sisi.
cropWrap.addEventListener('pointerdown', (e) => {
  if (!cur || crop.drag >= 0) return;
  const [nx, ny, r] = evtNorm(e);
  const Q = cur.quad;
  const cands = Q.map((p) => p);
  for (let i = 0; i < 4; i++) {
    const p = Q[i], q = Q[(i + 1) % 4];
    cands.push([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
  }
  let best = -1, bd = 56; // px
  cands.forEach(([x, y], i) => {
    const dd = Math.hypot((x - nx) * r.width, (y - ny) * r.height) + (i >= 4 ? 8 : 0); // utamakan sudut
    if (dd < bd) { bd = dd; best = i; }
  });
  if (best < 0) return;
  crop.drag = best;
  crop.start = [nx, ny];
  crop.q0 = Q.map((p) => p.slice());
  crop.pid = e.pointerId;
  try { cropWrap.setPointerCapture(e.pointerId); } catch {}
  loupe.hidden = false;
  drawLoupe(...cands[best]);
  drawCrop();
  e.preventDefault();
});
cropWrap.addEventListener('pointermove', (e) => {
  if (crop.drag < 0 || e.pointerId !== crop.pid) return;
  e.preventDefault();
  const [nx, ny] = evtNorm(e);
  const dx = nx - crop.start[0], dy = ny - crop.start[1];
  const q = crop.q0.map((p) => p.slice());
  let look;
  if (crop.drag < 4) {
    const i = crop.drag;
    q[i] = [clamp01(crop.q0[i][0] + dx), clamp01(crop.q0[i][1] + dy)];
    look = q[i];
  } else {
    const i = crop.drag - 4, j = (i + 1) % 4;
    // hadkan anjakan supaya kedua-dua hujung kekal dalam gambar
    let ddx = dx, ddy = dy;
    for (const k of [i, j]) {
      ddx = Math.min(1 - crop.q0[k][0], Math.max(-crop.q0[k][0], ddx));
      ddy = Math.min(1 - crop.q0[k][1], Math.max(-crop.q0[k][1], ddy));
    }
    q[i] = [crop.q0[i][0] + ddx, crop.q0[i][1] + ddy];
    q[j] = [crop.q0[j][0] + ddx, crop.q0[j][1] + ddy];
    look = [(q[i][0] + q[j][0]) / 2, (q[i][1] + q[j][1]) / 2];
  }
  cur.quad = q;
  drawCrop();
  drawLoupe(...look);
});
const endDrag = (e) => {
  if (crop.drag < 0 || (e && e.pointerId !== crop.pid)) return;
  crop.drag = -1;
  loupe.hidden = true;
  cur.quad = orderQuad(cur.quad);
  drawCrop();
};
cropWrap.addEventListener('pointerup', endDrag);
cropWrap.addEventListener('pointercancel', endDrag);
cropWrap.addEventListener('lostpointercapture', endDrag);
// Sandaran untuk pelayar yang abaikan touch-action: halang tatal/tarik-untuk-muat-semula
cropWrap.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
cropWrap.addEventListener('touchstart', (e) => { if (e.touches.length === 1) e.preventDefault(); }, { passive: false });
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
  back();
};
$('#cropNext').onclick = async () => {
  busy(true, 'Meluruskan dokumen…');
  await nextFrame();
  try {
    cur.warped = warp(cur.src, cur.quad);
    if (cur.page) cur.dirty = true;
    openEdit();
  } finally {
    busy(false);
  }
};


/* ------------------------------------------------------------------ */
/* Status                                                               */
/* ------------------------------------------------------------------ */
function docBadges(d) {
  const ps = docPages(d.id), bits = [];
  if (settings.batchDocId === d.id) bits.push('<span title="Batch terbuka">●</span>');
  if (ps.length && ps.every((p) => p.ocr)) bits.push('<span title="Teks dikenal pasti">T</span>');
  else if (ocrState.page && ps.includes(ocrState.page)) bits.push('<span title="OCR">…</span>');
  if (driveOn() && settings.driveAuto && ps.length && d.closed) {
    const pend = docPendingDrive(d) || ps.some(pagePendingDrive);
    const done = d.kind === 'batch' ? (!settings.drivePdf || d.pdfSynced) : ps.every((p) => p.driveSynced || !settings.drivePages);
    if (pend) bits.push('<span title="Menunggu Drive">⏳</span>');
    else if (done) bits.push('<span title="Di Google Drive">☁</span>');
  }
  return bits.join('');
}

function renderStatus() {
  const msgs = [];
  if (ocrState.page) msgs.push(ocrState.phase === 'load' ? '🔤 Memuat data OCR…' : `🔤 OCR… ${Math.round(ocrState.progress * 100)}%`);
  if (driveOn()) {
    const pend = drivePendingCount();
    if (driveState.busy) msgs.push(`☁ Memuat naik… (${pend})`);
    else if (pend && !Drive.valid()) msgs.push(`☁ ${pend} menunggu — tekan untuk log masuk Google`);
    else if (driveState.error) msgs.push('☁ ' + driveState.error);
    else if (pend) msgs.push(`☁ ${pend} menunggu`);
  }
  document.querySelectorAll('.status-line').forEach((el) => {
    el.textContent = msgs.join('  ·  ');
    el.hidden = !msgs.length;
    el.classList.toggle('clickable', driveOn() && drivePendingCount() > 0 && !driveState.busy);
    el.onclick = () => { if (driveOn() && drivePendingCount()) driveKick(); };
  });
  document.querySelectorAll('#docGrid .thumb').forEach((t) => {
    const d = getDoc(t.dataset.id);
    if (d) t.querySelector('.badges').innerHTML = docBadges(d);
  });
}

/* ------------------------------------------------------------------ */
/* Giliran OCR & Google Drive (latar belakang)                          */
/* ------------------------------------------------------------------ */
OCR.onProgress((m) => {
  if (!ocrState.page) return;
  if (m.status === 'recognizing text') { ocrState.phase = 'rec'; ocrState.progress = m.progress || 0; }
  else if (/load|initializ/.test(m.status)) ocrState.phase = 'load';
  renderStatus();
});

function runOcrQueue() {
  if (ocrState.running) return ocrState.running;
  if (!settings.autoOcr) return Promise.resolve();
  ocrState.running = (async () => {
    await null; // pastikan 'running' ditetapkan sebelum blok finally berjalan
    try {
      for (;;) {
        const pg = pages.find((p) => !p.ocr && !ocrState.skip.has(p.id));
        if (!pg) break;
        ocrState.page = pg; ocrState.progress = 0; ocrState.phase = '';
        renderStatus();
        const blob = pg.processed;
        try {
          const r = await OCR.recognize(blob, settings.ocrLang, pg.w, pg.h);
          if (pg.processed === blob && pages.includes(pg)) { pg.ocr = r; await persistPage(pg); }
        } catch (e) {
          console.warn(e);
          pages.forEach((p) => !p.ocr && ocrState.skip.add(p.id));
          toast('OCR tidak dapat dijalankan: ' + e.message);
        }
      }
    } finally {
      ocrState.page = null;
      ocrState.running = null;
      renderStatus();
    }
  })();
  return ocrState.running;
}

async function waitForOcr(list) {
  if (!settings.autoOcr || !list.some((p) => !p.ocr && !ocrState.skip.has(p.id))) return;
  busy(true, 'Menunggu OCR selesai…');
  const t = setInterval(() => {
    if (ocrState.page) $('#busyText').textContent = `OCR… ${Math.round(ocrState.progress * 100)}%`;
  }, 300);
  try { await runOcrQueue(); } finally { clearInterval(t); busy(false); }
}

Drive.onToken(() => { driveState.error = ''; renderSettingsDrive(); flushDrive(); });
Drive.onError((e) => { driveState.error = e.message; renderStatus(); renderSettingsDrive(); toast('Google: ' + e.message); });

// Panggil dari dalam tindakan pengguna (klik) — boleh buka tetingkap log masuk Google.
function driveKick() {
  if (!driveOn()) return;
  if (Drive.valid()) flushDrive();
  else if (Drive.ready()) Drive.requestToken();
  else Drive.init(settings.driveClientId).then(() => toast('Tekan sekali lagi untuk log masuk Google')).catch((e) => toast(e.message));
}

async function flushDrive() {
  if (!driveOn() || !Drive.valid()) { renderStatus(); return; }
  if (driveState.busy) { driveState.again = true; return; }
  driveState.busy = true; driveState.again = false; driveState.error = '';
  renderStatus();
  let ok = true;
  try {
    const folderId = await Drive.ensureFolder(settings.driveFolder || DEFAULTS.driveFolder);
    // 1) halaman dokumen tunggal (JPG / Google Docs)
    for (const pg of [...pages]) {
      if (!pages.includes(pg) || !pagePendingDrive(pg)) continue;
      const d = getDoc(pg.docId);
      const name = pageFile(d, pageIndex(pg));
      const blob = pg.processed;
      if (settings.drivePages && !pg.driveSynced) {
        const r = await Drive.upload(blob, { name: name + '.jpg', folderId, fileId: pg.driveId, mime: 'image/jpeg' });
        if (pg.processed === blob) { pg.driveId = r.id; pg.driveSynced = true; }
      }
      if (settings.driveDocs && !pg.docsSynced) {
        await Drive.upload(blob, { name: name + ' (teks)', folderId, mime: 'image/jpeg', convertTo: 'application/vnd.google-apps.document' });
        if (pg.processed === blob) pg.docsSynced = true;
      }
      if (pages.includes(pg)) await persistPage(pg);
      renderStatus();
    }
    // 2) PDF dokumen (batch yang siap, atau dokumen berbilang halaman)
    for (const d of [...docs]) {
      if (!docs.includes(d) || !docPendingDrive(d)) continue;
      const file = await docFile(d, settings.pageSize);
      const r = await Drive.upload(file, { name: docBase(d) + '.pdf', folderId, fileId: d.pdfDriveId, mime: 'application/pdf' });
      d.pdfDriveId = r.id; d.pdfSynced = true;
      await persistDoc(d);
      renderStatus();
    }
    // 3) muat naik manual dari butang ☁ Drive
    while (driveState.files.length) {
      const f = driveState.files[0];
      await Drive.upload(f.blob, { name: f.name, folderId, mime: f.mime });
      driveState.files.shift();
      toast(`☁ ${f.name} dimuat naik ke Drive`);
    }
  } catch (e) {
    ok = false;
    console.warn(e);
    driveState.error = e.needAuth ? '' : e.message;
    if (!e.needAuth) toast(e.message);
  } finally {
    driveState.busy = false;
    renderStatus();
  }
  if (ok && driveState.again) flushDrive();
}
const pageIndex = (pg) => docPages(pg.docId).indexOf(pg);

function afterChange() { runOcrQueue(); flushDrive(); }

/* ------------------------------------------------------------------ */
/* Paparan: utama, dokumen, sunting                                     */
/* ------------------------------------------------------------------ */
function show(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === id));
}
function showHome() { view.docId = null; renderHome(); show('home'); }
function openDoc(id) { view.docId = id; renderDoc(); show('doc'); }
function back() { if (view.docId && getDoc(view.docId)) openDoc(view.docId); else showHome(); }
function refresh() {
  if ($('#doc').classList.contains('active')) renderDoc();
  else if ($('#home').classList.contains('active')) renderHome();
}

function renderHome() {
  const grid = $('#docGrid');
  grid.innerHTML = '';
  docs.slice().sort((a, b) => b.created - a.created).forEach((d) => {
    const ps = docPages(d.id), first = ps[0];
    const b = document.createElement('button');
    b.className = 'thumb doc-card' + (settings.batchDocId === d.id ? ' open-batch' : '');
    b.dataset.id = d.id;
    b.innerHTML = '<img alt=""><span class="num"></span><span class="badges"></span><span class="dname"></span>';
    if (first) {
      if (!first.url) first.url = URL.createObjectURL(first.processed);
      b.querySelector('img').src = first.url;
    }
    b.querySelector('.num').textContent = `${ps.length} hlm`;
    b.querySelector('.dname').textContent = d.name;
    b.onclick = () => openDoc(d.id);
    grid.appendChild(b);
  });
  $('#empty').hidden = docs.length > 0;
  $('#btnClear').style.visibility = docs.length ? 'visible' : 'hidden';
  document.querySelectorAll('#modeBar [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === settings.mode));
  const bb = batchDoc();
  $('#batchBar').hidden = settings.mode !== 'batch' && !bb;
  const bn = $('#batchName');
  if (bb && document.activeElement !== bn) bn.value = bb.name;
  $('#batchCount').textContent = bb
    ? `${docPages(bb.id).length} halaman dalam batch ini`
    : 'Tangkap gambar untuk mula batch baharu';
  $('#batchDone').hidden = !bb;
  renderStatus();
}

function renderDoc() {
  const d = getDoc(view.docId);
  if (!d) return showHome();
  const ps = docPages(d.id);
  const dn = $('#docName');
  if (document.activeElement !== dn) dn.value = d.name;
  $('#docMeta').textContent = `${ps.length} halaman` +
    (d.kind === 'batch' ? (d.closed ? ' · batch siap' : ' · batch terbuka') : '');
  $('#docDone').hidden = d.closed;
  $('#emptyDoc').hidden = ps.length > 0;
  $('#btnDrive').hidden = !driveOn();
  const grid = $('#pageGrid');
  grid.innerHTML = '';
  ps.forEach((pg, i) => {
    if (!pg.url) pg.url = URL.createObjectURL(pg.processed);
    const b = document.createElement('button');
    b.className = 'thumb';
    b.innerHTML = `<img alt=""><span class="num">${i + 1}</span>`;
    b.querySelector('img').src = pg.url;
    b.onclick = () => openExisting(pg);
    grid.appendChild(b);
  });
  syncExportBar();
  renderStatus();
}

async function renameDoc(id, name) {
  const d = getDoc(id);
  if (!d) return;
  const n = (name || '').trim();
  if (!n || n === d.name) return refresh();
  d.name = n;
  await persistDoc(d);
  await markDocChanged(id, true);
  refresh();
  afterChange();
}
$('#docName').onchange = (e) => renameDoc(view.docId, e.target.value);
$('#batchName').onchange = (e) => { const d = openBatch(); renameDoc(d.id, e.target.value); };

async function finishBatch(id) {
  const d = getDoc(id || settings.batchDocId);
  if (!d) return;
  const n = docPages(d.id).length;
  if (!n) {
    docs = docs.filter((x) => x !== d);
    await DB.delDoc(d.id);
    toast('Batch kosong — dibuang');
  } else {
    d.closed = true; d.pdfSynced = false;
    await persistDoc(d);
    toast(`Batch "${d.name}" siap (${n} halaman)`);
  }
  if (settings.batchDocId === d.id) { settings.batchDocId = null; saveSettings(); }
  refresh();
  afterChange();
}
$('#batchDone').onclick = () => finishBatch(settings.batchDocId);
$('#docDone').onclick = () => finishBatch(view.docId);
$('#docBack').onclick = () => showHome();

$('#docDelete').onclick = async () => {
  const d = getDoc(view.docId);
  if (!d || !confirm(`Padam dokumen "${d.name}" dan semua halamannya dari telefon?\n(Fail di Google Drive tidak dipadam)`)) return;
  for (const p of docPages(d.id)) { await DB.delPage(p.id); if (p.url) URL.revokeObjectURL(p.url); }
  pages = pages.filter((p) => p.docId !== d.id);
  docs = docs.filter((x) => x !== d);
  await DB.delDoc(d.id);
  if (settings.batchDocId === d.id) { settings.batchDocId = null; saveSettings(); }
  showHome();
  toast('Dokumen dipadam');
};

document.querySelectorAll('#modeBar [data-mode]').forEach((b) => {
  b.onclick = () => { settings.mode = b.dataset.mode; saveSettings(); renderHome(); };
});

/* ---------- Tangkapan / import ---------- */
$('#btnCamHome').onclick = () => { pickTarget = null; $('#inCamera').click(); };
$('#btnGalHome').onclick = () => { pickTarget = null; $('#inGallery').click(); };
$('#btnCamDoc').onclick = () => { pickTarget = view.docId; $('#inCamera').click(); };
$('#btnGalDoc').onclick = () => { pickTarget = view.docId; $('#inGallery').click(); };
$('#inCamera').onchange = (e) => { const t = pickTarget; pickTarget = null; handleFiles(e.target.files, { fromCamera: true, docId: t }); e.target.value = ''; };
$('#inGallery').onchange = (e) => { const t = pickTarget; pickTarget = null; handleFiles(e.target.files, { fromCamera: false, docId: t }); e.target.value = ''; };

async function importPdfs(pdfs, explicitId) {
  let added = 0;
  for (const file of pdfs) {
    let docId;
    if (explicitId && getDoc(explicitId)) docId = explicitId;
    else if (settings.mode === 'batch') docId = openBatch().id;
    else {
      const d = makeDoc(baseName(file), { kind: 'single', closed: true });
      docs.push(d); await persistDoc(d); docId = d.id;
    }
    try {
      busy(true, 'Memuat penukar PDF…');
      const canvases = await pdfToImages(file, (i, n) => { $('#busyText').textContent = `Menukar PDF: halaman ${i}/${n}…`; });
      for (const c of canvases) {
        const blob = await toBlob(c, 'image/jpeg', 0.9);
        cur = { page: null, docId, original: blob, src: c, quad: FULL_QUAD, rotation: 0, filter: 'original' };
        await saveCurrent(false);
        added++;
      }
    } catch (e) {
      console.error(e);
      alert(`Gagal menukar ${file.name}: ${e.message}`);
    }
  }
  cur = null;
  return added;
}

async function handleFiles(input, opts = {}) {
  const all = [...input];
  const pdfs = all.filter(isPdf);
  const imgs = all.filter((f) => !isPdf(f) && isImg(f));
  if (!pdfs.length && !imgs.length) return;
  if (pdfs.length) {
    const n = await importPdfs(pdfs, opts.docId);
    busy(false);
    refresh();
    if (n) toast(`PDF ditukar kepada ${n} halaman`);
    afterChange();
  }
  if (!imgs.length) return;
  if (imgs.length === 1) {
    busy(true, 'Mengesan dokumen…');
    await nextFrame();
    try {
      const f = imgs[0];
      const src = await loadSource(f);
      const det = detectQuad(src);
      cur = {
        page: null, original: f, src, quad: det.quad, rotation: 0, filter: lastFilter,
        fromCamera: !!opts.fromCamera, docName: opts.fromCamera ? '' : baseName(f), ...targetFor(opts.docId),
      };
      openCrop();
      if (!det.found) toast('Tepi tidak dikesan — laraskan sudut secara manual');
    } catch (e) {
      alert('Gagal membuka imej: ' + e.message);
    } finally {
      busy(false);
    }
    return;
  }
  // banyak imej: Tunggal → setiap imej jadi dokumen sendiri; Batch → semua masuk satu batch
  for (let i = 0; i < imgs.length; i++) {
    busy(true, `Memproses ${i + 1}/${imgs.length}…`);
    await nextFrame();
    try {
      const f = imgs[i];
      const src = await loadSource(f);
      const det = detectQuad(src);
      cur = { page: null, original: f, src, quad: det.quad, rotation: 0, filter: lastFilter, docName: baseName(f), ...targetFor(opts.docId) };
      await saveCurrent(false);
    } catch (e) {
      console.error(e);
      toast(`Imej ${i + 1} gagal diproses`);
    }
  }
  cur = null;
  busy(false);
  toast(`${imgs.length} imej ditambah`);
  afterChange();
  refresh();
}

/* ---------- Paparan potong: selepas batal ---------- */
// (cropCancel memanggil back() — lihat bahagian potong di atas)

/* ---------- Paparan sunting ---------- */
async function openExisting(pg) {
  busy(true, 'Membuka…');
  await nextFrame();
  try {
    const src = await loadSource(pg.original);
    cur = { page: pg, docId: pg.docId, original: pg.original, src, quad: pg.quad, rotation: pg.rotation, filter: pg.filter, ocr: null, dirty: false };
    cur.warped = warp(src, cur.quad);
    openEdit();
  } finally {
    busy(false);
  }
}

function openEdit() {
  show('edit');
  const ps = cur.page ? docPages(cur.docId) : [];
  const idx = cur.page ? ps.indexOf(cur.page) : -1;
  $('#editTitle').textContent = idx >= 0 ? `Halaman ${idx + 1} / ${ps.length}` : 'Halaman baru';
  $('#editDelete').style.visibility = cur.page ? 'visible' : 'hidden';
  $('#moveL').hidden = $('#moveR').hidden = !cur.page;
  renderPreview();
}

function buildOutput() {
  return applyFilter(rotate(cur.warped, cur.rotation), cur.filter);
}

async function renderPreview() {
  cur.ocr = null;
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
  cur.dirty = true;
  lastFilter = f;
  localStorage.setItem('lastFilter', f);
  renderPreview();
});
$('#rotL').onclick = () => { cur.rotation = (cur.rotation + 270) % 360; cur.dirty = true; renderPreview(); };
$('#rotR').onclick = () => { cur.rotation = (cur.rotation + 90) % 360; cur.dirty = true; renderPreview(); };
$('#recrop').onclick = () => openCrop();
$('#editBack').onclick = () => { cur = null; back(); };

function curPageName() {
  const d = cur.docId && getDoc(cur.docId);
  if (cur.page && d) return pageFile(d, pageIndex(cur.page));
  return safeName(cur.docName || defaultName());
}

async function saveCurrent(useCurOut = true) {
  const out = useCurOut && cur.out ? cur.out : (cur.warped || (cur.warped = warp(cur.src, cur.quad)), buildOutput());
  const blob = await toBlob(out);
  if (!cur.docId) {
    const d = makeDoc(cur.docName, { kind: 'single', closed: true });
    docs.push(d);
    cur.docId = d.id;
    await persistDoc(d);
  }
  const pg = cur.page || { id: uid(), docId: cur.docId, order: nextOrder(), created: Date.now(), original: cur.original };
  Object.assign(pg, {
    quad: cur.quad, rotation: cur.rotation, filter: cur.filter, processed: blob, w: out.width, h: out.height,
    ocr: cur.ocr || null, driveSynced: false, docsSynced: false,
  });
  ocrState.skip.delete(pg.id);
  if (pg.url) { URL.revokeObjectURL(pg.url); pg.url = null; }
  await persistPage(pg);
  if (!cur.page) pages.push(pg);
  const d = getDoc(pg.docId);
  if (d) { d.pdfSynced = false; await persistDoc(d); }
}

$('#editSave').onclick = async () => {
  if (cur.page && !cur.dirty) { cur = null; back(); return; }
  busy(true, 'Menyimpan…');
  let isNew = false, fromCamera = false;
  try {
    isNew = !cur.page;
    fromCamera = !!cur.fromCamera;
    await saveCurrent(true);
    cur = null;
    back();
    toast('Halaman disimpan');
    afterChange();
  } catch (e) {
    alert('Gagal menyimpan: ' + e.message);
    return;
  } finally {
    busy(false);
  }
  if (isNew && fromCamera && settings.mode === 'batch' && confirm('Imbas halaman seterusnya?')) {
    $('#inCamera').click();
  }
};

$('#editDelete').onclick = async () => {
  if (!cur.page || !confirm('Padam halaman ini?')) return;
  await deletePage(cur.page);
  cur = null;
  back();
};

async function movePage(dir) {
  const ps = docPages(cur.docId);
  const i = ps.indexOf(cur.page), j = i + dir;
  if (i < 0 || j < 0 || j >= ps.length) return;
  const a = ps[i], b = ps[j];
  [a.order, b.order] = [b.order, a.order];
  await persistPage(a);
  await persistPage(b);
  await markDocChanged(cur.docId, true);
  $('#editTitle').textContent = `Halaman ${j + 1} / ${ps.length}`;
  toast(`Dialih ke kedudukan ${j + 1}`);
  afterChange();
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
  download(blob, curPageName() + '.jpg');
};

/* ---------- Panel teks (OCR) ---------- */
$('#btnText').onclick = async () => {
  let ocr = cur.ocr || (cur.page && !cur.dirty ? cur.page.ocr : null);
  if (!ocr) {
    busy(true, 'Mengenal pasti teks…');
    try {
      const o = cur.out || (cur.out = buildOutput());
      const blob = await toBlob(o);
      ocr = await OCR.recognize(blob, settings.ocrLang, o.width, o.height);
      cur.ocr = ocr;
      if (cur.page && !cur.dirty) { cur.page.ocr = ocr; await persistPage(cur.page); renderStatus(); }
    } catch (e) {
      alert('OCR gagal: ' + e.message);
      return;
    } finally {
      busy(false);
    }
  }
  $('#ocrText').value = ocr.text || '';
  $('#ocrEmpty').hidden = !!(ocr.text && ocr.text.trim());
  $('#textPanel').hidden = false;
};
$('#textClose').onclick = () => { $('#textPanel').hidden = true; };
$('#textCopy').onclick = async () => {
  const t = $('#ocrText').value;
  try { await navigator.clipboard.writeText(t); }
  catch { $('#ocrText').select(); document.execCommand('copy'); }
  toast('Teks disalin');
};

/* ---------- Eksport (mengikut dokumen) ---------- */
const curDoc = () => getDoc(view.docId);

async function buildExport(d, fmt) {
  const ps = docPages(d.id);
  if (!ps.length) return [];
  if (fmt === 'pdf' || fmt === 'txt') await waitForOcr(ps);
  busy(true, fmt === 'pdf' ? 'Menjana PDF…' : 'Menyediakan fail…');
  await nextFrame();
  try {
    const base = docBase(d);
    if (fmt === 'pdf') return [await docFile(d, settings.pageSize)];
    if (fmt === 'txt') return [new File([ocrTextOf(ps)], base + '.txt', { type: 'text/plain' })];
    return ps.map((p, i) => new File([p.processed], ps.length > 1 ? `${base}_${pad2(i + 1)}.jpg` : `${base}.jpg`, { type: 'image/jpeg' }));
  } finally {
    busy(false);
  }
}

$('#btnExport').onclick = async () => {
  const d = curDoc();
  if (!d) return;
  const files = await buildExport(d, settings.format);
  if (!files.length) return toast('Tiada halaman');
  for (let i = 0; i < files.length; i++) {
    download(files[i], files[i].name);
    if (files.length > 1) await new Promise((r) => setTimeout(r, 350));
  }
  const mb = files.reduce((a, f) => a + f.size, 0) / 1048576;
  toast(`${files.length > 1 ? files.length + ' fail' : files[0].name} disimpan (${mb.toFixed(1)} MB)`);
};

$('#btnDrive').onclick = async () => {
  const d = curDoc();
  if (!d) return;
  driveKick();
  const [f] = await buildExport(d, 'pdf');
  if (!f) return;
  driveState.files.push({ blob: f, name: f.name, mime: 'application/pdf' });
  if (!Drive.valid()) toast('Log masuk Google — fail akan dimuat naik selepas itu');
  flushDrive();
};

if (navigator.canShare && navigator.canShare({ files: [new File([''], 'x.pdf', { type: 'application/pdf' })] })) {
  $('#btnShare').hidden = false;
}
$('#btnShare').onclick = async () => {
  const d = curDoc();
  if (!d) return;
  const files = await buildExport(d, settings.format);
  if (!files.length) return;
  try {
    await navigator.share({ files, title: files[0].name });
  } catch (e) {
    if (e.name === 'NotAllowedError') toast('Tekan Kongsi sekali lagi');
    else if (e.name !== 'AbortError') files.forEach((f) => download(f, f.name));
  }
};

$('#btnClear').onclick = async () => {
  if (!docs.length || !confirm('Padam SEMUA dokumen dari telefon? (Fail di Google Drive tidak dipadam)')) return;
  await DB.clearAll();
  pages.forEach((p) => p.url && URL.revokeObjectURL(p.url));
  pages = []; docs = []; driveState.files = [];
  settings.batchDocId = null; saveSettings();
  showHome();
};

function syncExportBar() {
  $('#fmt').value = settings.format;
  $('#pageSize').value = settings.pageSize;
  $('#pageSizeWrap').hidden = settings.format !== 'pdf';
  $('#btnExport').textContent = { pdf: 'Simpan PDF', jpg: 'Simpan JPG', txt: 'Simpan Teks' }[settings.format];
}
$('#fmt').onchange = (e) => { settings.format = e.target.value; saveSettings(); syncExportBar(); };
$('#pageSize').onchange = (e) => { settings.pageSize = e.target.value; saveSettings(); };

/* ---------- Tetapan ---------- */
function renderSettingsDrive() {
  const st = $('#driveState');
  if (!driveOn()) { st.textContent = 'Belum ditetapkan — masukkan Client ID di atas.'; $('#driveConnect').hidden = true; $('#driveDisconnect').hidden = true; return; }
  const on = Drive.valid() || Drive.connected();
  st.textContent = Drive.valid() ? '✅ Disambungkan' : on ? 'Disambungkan (log masuk semula diperlukan bila muat naik)' : 'Belum disambungkan';
  $('#driveConnect').hidden = Drive.valid();
  $('#driveDisconnect').hidden = !on;
}

function openSettings() {
  document.querySelectorAll('#settings [data-key]').forEach((el) => {
    const v = settings[el.dataset.key];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  });
  $('#originHint').textContent = location.origin;
  renderSettingsDrive();
  show('settings');
}
document.querySelectorAll('#settings [data-key]').forEach((el) => {
  el.addEventListener('change', () => {
    const k = el.dataset.key;
    settings[k] = el.type === 'checkbox' ? el.checked : el.value.trim();
    if (k === 'driveClientId') {
      Drive.disconnect();
      if (settings.driveClientId) Drive.init(settings.driveClientId).catch((e) => toast(e.message));
    }
    saveSettings();
    syncExportBar();
    renderSettingsDrive();
    if (k === 'autoOcr' && settings.autoOcr) { ocrState.skip.clear(); runOcrQueue(); }
  });
});
$('#btnSettings').onclick = openSettings;
$('#settingsBack').onclick = () => { back(); afterChange(); };
$('#driveConnect').onclick = () => {
  if (!Drive.ready()) {
    Drive.init(settings.driveClientId).then(() => toast('Tekan "Sambung" sekali lagi')).catch((e) => toast(e.message));
    return;
  }
  Drive.requestToken(true);
};
$('#driveDisconnect').onclick = () => { Drive.disconnect(); driveState.error = ''; renderSettingsDrive(); renderStatus(); };
$('#ocrRedo').onclick = () => {
  pages.forEach((p) => { p.ocr = null; });
  ocrState.skip.clear();
  Promise.all(pages.map(persistPage)).then(() => { toast('OCR semula dimulakan'); runOcrQueue(); refresh(); });
};

/* ---------- Fail dikongsi dari app lain (WhatsApp dll.) ---------- */
async function takeSharedFiles() {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('pengimbas-share', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files', { autoIncrement: true });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return new Promise((res, rej) => {
    const t = db.transaction('files', 'readwrite');
    const st = t.objectStore('files');
    const req = st.getAll();
    st.clear();
    t.oncomplete = () => res((req.result || []).map((x) => new File([x.blob], x.name, { type: x.type || x.blob.type })));
    t.onerror = () => rej(t.error);
  });
}

async function checkShared() {
  const q = new URLSearchParams(location.search);
  if (!q.has('share')) return;
  history.replaceState(null, '', location.pathname);
  if (q.get('share') === 'error') { toast('Gagal menerima fail yang dikongsi'); return; }
  try {
    const files = await takeSharedFiles();
    if (!files.length) return;
    toast(files.length > 1 ? `${files.length} fail diterima` : 'Fail diterima');
    await handleFiles(files, { fromCamera: false });
  } catch (e) {
    alert('Gagal membaca fail yang dikongsi: ' + e.message);
  }
}

/* ---------- Mula ---------- */
async function loadAll() {
  try {
    docs = await DB.allDocs();
    pages = (await DB.allPages()).sort((a, b) => a.order - b.order);
  } catch (e) {
    console.warn(e);
    docs = []; pages = [];
  }
  // migrasi: halaman lama (versi sebelum dokumen) jadi dokumen tunggal sendiri
  for (const p of pages) {
    if (p.docId && getDoc(p.docId)) continue;
    const d = makeDoc('Imbasan_' + stamp(p.created || Date.now(), true));
    d.created = p.created || Date.now();
    docs.push(d);
    p.docId = d.id;
    await persistDoc(d);
    await persistPage(p);
  }
  if (settings.batchDocId && !getDoc(settings.batchDocId)) { settings.batchDocId = null; saveSettings(); }
  showHome();
  runOcrQueue();
  if (Drive.valid()) flushDrive();
}

document.querySelectorAll('.status-line').forEach((el) => { el.hidden = true; });
$('#btnClear').style.visibility = 'hidden';
syncExportBar();
if (driveOn()) Drive.init(settings.driveClientId).catch(() => {});
loadAll().then(checkShared);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
