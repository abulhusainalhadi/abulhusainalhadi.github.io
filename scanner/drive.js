/* Muat naik ke Google Drive (Google Identity Services + Drive API v3, skop drive.file). */
'use strict';

const Drive = (() => {
  const GIS_URL = 'https://accounts.google.com/gsi/client';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  let tokenClient = null, clientId = null;
  let token = null, exp = 0;
  const onTokenFns = new Set();
  const onErrorFns = new Set();

  try {
    const t = JSON.parse(localStorage.getItem('driveToken') || 'null');
    if (t && t.exp > Date.now()) { token = t.token; exp = t.exp; }
  } catch {}

  async function init(id) {
    id = (id || '').trim();
    if (!id) { tokenClient = null; clientId = null; return false; }
    if (tokenClient && clientId === id) return true;
    await loadScript(GIS_URL);
    clientId = id;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: id,
      scope: SCOPE,
      callback: (r) => {
        if (r && r.access_token) {
          token = r.access_token;
          exp = Date.now() + (Number(r.expires_in || 3600) - 120) * 1000;
          localStorage.setItem('driveToken', JSON.stringify({ token, exp }));
          localStorage.setItem('driveConnected', '1');
          onTokenFns.forEach((fn) => fn());
        } else {
          onErrorFns.forEach((fn) => fn(new Error((r && r.error) || 'Kebenaran ditolak')));
        }
      },
      error_callback: (e) => onErrorFns.forEach((fn) => fn(new Error((e && e.message) || (e && e.type) || 'Log masuk dibatalkan'))),
    });
    return true;
  }

  const ready = () => !!tokenClient;
  const valid = () => !!token && Date.now() < exp;
  const connected = () => localStorage.getItem('driveConnected') === '1';

  // Mesti dipanggil terus dari tindakan pengguna (klik) supaya tetingkap Google tidak disekat.
  function requestToken(forceConsent) {
    if (!tokenClient) return false;
    tokenClient.requestAccessToken({ prompt: forceConsent || !connected() ? 'consent' : '' });
    return true;
  }

  function disconnect() {
    if (token && window.google && google.accounts) google.accounts.oauth2.revoke(token, () => {});
    token = null; exp = 0;
    localStorage.removeItem('driveToken');
    localStorage.removeItem('driveConnected');
    localStorage.removeItem('driveFolders');
    Object.keys(verified).forEach((k) => delete verified[k]);
  }

  async function api(url, opts = {}) {
    if (!valid()) throw Object.assign(new Error('Perlu log masuk Google'), { needAuth: true });
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
    if (r.status === 401) {
      token = null; exp = 0;
      localStorage.removeItem('driveToken');
      throw Object.assign(new Error('Sesi Google tamat'), { needAuth: true });
    }
    if (!r.ok) {
      let msg = r.status + '';
      try { msg = (await r.json()).error.message; } catch {}
      throw Object.assign(new Error('Drive: ' + msg), { status: r.status });
    }
    return r.json();
  }

  const verified = {};
  async function ensureFolder(name) {
    if (verified[name]) return verified[name];
    const cache = JSON.parse(localStorage.getItem('driveFolders') || '{}');
    if (cache[name]) {
      try {
        const f = await api(`${API}/files/${cache[name]}?fields=id,trashed`);
        if (!f.trashed) return (verified[name] = f.id);
      } catch (e) { if (e.needAuth) throw e; }
    }
    const q = `name='${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const found = await api(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`);
    let id = found.files && found.files[0] && found.files[0].id;
    if (!id) {
      const f = await api(`${API}/files?fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
      });
      id = f.id;
    }
    cache[name] = id;
    verified[name] = id;
    localStorage.setItem('driveFolders', JSON.stringify(cache));
    return id;
  }

  // Cipta fail baru (atau kemas kini fileId sedia ada). convertTo: jenis Google (cth. Google Docs untuk OCR Google).
  async function upload(blob, { name, folderId, fileId, mime, convertTo }) {
    const b = 'pengimbas' + Math.random().toString(36).slice(2);
    const meta = fileId ? { name } : { name, parents: [folderId], ...(convertTo ? { mimeType: convertTo } : {}) };
    const body = new Blob([
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${b}\r\nContent-Type: ${mime || blob.type}\r\n\r\n`,
      blob,
      `\r\n--${b}--`,
    ]);
    const url = fileId
      ? `${UPLOAD}/files/${fileId}?uploadType=multipart&fields=id,webViewLink`
      : `${UPLOAD}/files?uploadType=multipart&fields=id,webViewLink`;
    try {
      return await api(url, { method: fileId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body });
    } catch (e) {
      if (fileId && e.status === 404) return upload(blob, { name, folderId, mime, convertTo }); // fail lama dipadam
      throw e;
    }
  }

  return {
    init, ready, valid, connected, requestToken, disconnect, ensureFolder, upload,
    onToken: (fn) => onTokenFns.add(fn),
    onError: (fn) => onErrorFns.add(fn),
  };
})();
