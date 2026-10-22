// Sync with the Google Apps Script backend (which writes to the Sheet and Drive in your account).
import { S, TABLES, FIELD_TYPES, all, emit, persistTable, persistDirty, save, saveSettings, blobGet, setSaveHook } from './store.js';
import { blobToB64, setRemoteFetcher } from './photos.js';
import { byId } from './store.js';
import { stepLabel } from './logic.js';

export const status = { state: 'idle', error: '' };
const setStatus = (state, error = '') => { status.state = state; status.error = error; emit(); };

export const configured = () => !!(S.settings.scriptUrl && S.settings.key);

export async function call(action, payload = {}, { url, key } = {}) {
  const res = await fetch(url || S.settings.scriptUrl, {
    method: 'POST',
    body: JSON.stringify(Object.assign({ action, key: key || S.settings.key }, payload)),
  });
  const txt = await res.text();
  let j;
  try { j = JSON.parse(txt); } catch (e) { throw new Error('The Apps Script URL did not return app data. Check the URL and that the deployment access is "Anyone".'); }
  if (!j.ok) throw new Error(j.error === 'bad_key' ? 'App key does not match the one in Apps Script.' : j.error === 'not_setup' ? 'Run the setup function in Apps Script first.' : j.error || 'Unknown error');
  return j;
}

// ---------- encoding ----------
const isType = (k, t) => FIELD_TYPES[t].includes(k);
// Events also carry readable plant/what columns so the Sheet makes sense on its own (ignored on pull).
function encode(rec, t) {
  const o = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v == null) continue;
    if (isType(k, 'json')) o[k] = JSON.stringify(v);
    else o[k] = String(v);
  }
  if (t === 'events') {
    const p = byId('plants', rec.plantId);
    o._plant = p ? p.name : '';
    o._what = rec.type === 'water' ? stepLabel(rec.feeds) : rec.type;
  }
  return o;
}
function decode(row) {
  const o = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === '' || v == null || k[0] === '_') continue;
    if (isType(k, 'num')) o[k] = Number(v);
    else if (isType(k, 'bool')) o[k] = v === 'true' || v === 'TRUE';
    else if (isType(k, 'json')) { try { o[k] = JSON.parse(v); } catch (e) { o[k] = []; } }
    else o[k] = String(v);
  }
  return o;
}

// ---------- steps ----------
async function uploadPhotos() {
  const pending = all('photos').filter(p => !p.fileId);
  for (const p of pending) {
    const full = await blobGet(p.id + ':full');
    const thumb = await blobGet(p.id + ':thumb');
    if (!full || !thumb) continue; // taken on another device and never synced; nothing to send
    const plant = byId('plants', p.plantId);
    const r = await call('upload', {
      photoId: p.id, plantId: p.plantId, plantName: plant ? plant.name : 'Unknown', date: p.date,
      full: await blobToB64(full), thumb: await blobToB64(thumb),
    });
    const cur = S.data.photos[p.id];
    await save('photos', Object.assign({}, cur, { fileId: r.fileId, thumbId: r.thumbId }));
  }
}

async function push() {
  const snapshot = {};
  const tables = {};
  let n = 0;
  for (const t of TABLES) {
    const ids = Object.keys(S.dirty[t] || {});
    if (!ids.length) continue;
    tables[t] = ids.map(id => S.data[t][id]).filter(Boolean).map(r => encode(r, t));
    snapshot[t] = Object.fromEntries(ids.map(id => [id, S.data[t][id] && S.data[t][id].updatedAt]));
    n += ids.length;
  }
  if (!n) return;
  await call('push', { tables });
  // Clear only records that weren't edited again while the push was in flight.
  for (const t of Object.keys(snapshot)) {
    for (const [id, u] of Object.entries(snapshot[t])) {
      if (S.data[t][id] && S.data[t][id].updatedAt === u) delete S.dirty[t][id];
    }
  }
  await persistDirty();
}

async function pull() {
  const r = await call('pull');
  for (const t of TABLES) {
    const rows = (r.tables && r.tables[t]) || [];
    let changed = false;
    for (const row of rows) {
      const rec = decode(row);
      if (!rec.id) continue;
      if (S.dirty[t] && S.dirty[t][rec.id]) continue; // local edit wins until pushed
      const cur = S.data[t][rec.id];
      if (!cur || (rec.updatedAt || 0) > (cur.updatedAt || 0)) { S.data[t][rec.id] = rec; changed = true; }
    }
    if (changed) await persistTable(t);
  }
  if (r.sheetUrl) S.settings.sheetUrl = r.sheetUrl;
  if (r.folderUrl) S.settings.folderUrl = r.folderUrl;
  await saveSettings({ lastSync: Date.now() });
}

let running = false, again = false;
export async function sync() {
  if (!configured()) { setStatus('local'); return; }
  if (!navigator.onLine) { setStatus('offline'); return; }
  if (running) { again = true; return; }
  running = true;
  setStatus('syncing');
  try {
    await uploadPhotos();
    await push();
    await pull();
    setStatus('ok');
  } catch (e) {
    setStatus('error', e.message || String(e));
  } finally {
    running = false;
    if (again) { again = false; setTimeout(sync, 300); }
  }
}

let timer = null;
export function syncSoon(ms = 2500) {
  clearTimeout(timer);
  timer = setTimeout(sync, ms);
}

export function startSync() {
  setSaveHook(() => syncSoon());
  setRemoteFetcher(async ids => (await call('thumbs', { ids })).files || {});
  window.addEventListener('online', () => sync());
  window.addEventListener('offline', () => setStatus('offline'));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
  setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 5 * 60 * 1000);
  sync();
}

export async function fetchFull(p) {
  const r = await call('thumbs', { ids: [p.fileId] });
  return r.files && r.files[p.fileId];
}
