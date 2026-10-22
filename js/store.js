// Local-first store. Everything lives in IndexedDB on the phone; sync.js mirrors it to the Google Sheet.

export const TABLES = ['locations', 'plants', 'feeds', 'schedules', 'events', 'trips', 'photos'];

// Field types used to encode/decode values for the Sheet (which stores everything as text).
export const FIELD_TYPES = {
  num: ['order', 'potDiameter', 'potDepth', 'updatedAt', 'createdAt', 'stepIndex', 'w', 'h', 'overrideIdx', 'overrideAt'],
  bool: ['deleted', 'archived', 'drainage', 'offSchedule', 'byHelper', 'cover', 'day0'],
  json: ['steps', 'feeds'],
};

const DB_NAME = 'plantlog';
let dbp;
function idb() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('kv');
        r.result.createObjectStore('blobs');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

function tx(store, mode, fn) {
  return idb().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  }));
}

export const kvGet = k => tx('kv', 'readonly', s => s.get(k));
export const kvPut = (k, v) => tx('kv', 'readwrite', s => s.put(v, k));
export const blobGet = k => tx('blobs', 'readonly', s => s.get(k));
export const blobPut = (k, v) => tx('blobs', 'readwrite', s => s.put(v, k));
export const blobDel = k => tx('blobs', 'readwrite', s => s.delete(k));

export const S = {
  data: {},      // table -> { id: record }
  dirty: {},     // table -> { id: 1 } records not yet pushed
  settings: {},  // scriptUrl, key, sheetUrl, maxEdge, lastSync
};

const listeners = new Set();
export const onChange = fn => listeners.add(fn);
let emitQueued = false;
export function emit() {
  if (emitQueued) return;
  emitQueued = true;
  queueMicrotask(() => { emitQueued = false; listeners.forEach(fn => fn()); });
}

export async function load() {
  for (const t of TABLES) S.data[t] = (await kvGet('t:' + t)) || {};
  S.dirty = (await kvGet('dirty')) || {};
  S.settings = Object.assign({ maxEdge: 1600 }, (await kvGet('settings')) || {});
}

export const persistTable = t => kvPut('t:' + t, S.data[t]);
export const persistDirty = () => kvPut('dirty', S.dirty);
export async function saveSettings(patch) {
  Object.assign(S.settings, patch);
  await kvPut('settings', S.settings);
  emit();
}

export const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

export function all(t, { withArchived = true } = {}) {
  return Object.values(S.data[t] || {}).filter(r => !r.deleted && (withArchived || !r.archived));
}
export const byId = (t, id) => {
  const r = id && S.data[t] && S.data[t][id];
  return r && !r.deleted ? r : null;
};

let saveHook = () => {};
export const setSaveHook = fn => { saveHook = fn; };

export async function save(t, rec) {
  const now = Date.now();
  rec = Object.assign({}, rec);
  if (!rec.id) rec.id = uid();
  if (!rec.createdAt) rec.createdAt = now;
  rec.updatedAt = now;
  S.data[t][rec.id] = rec;
  (S.dirty[t] = S.dirty[t] || {})[rec.id] = 1;
  await persistTable(t);
  await persistDirty();
  emit();
  saveHook();
  return rec;
}

export async function saveMany(t, recs) {
  const out = [];
  const now = Date.now();
  for (let rec of recs) {
    rec = Object.assign({}, rec);
    if (!rec.id) rec.id = uid();
    if (!rec.createdAt) rec.createdAt = now;
    rec.updatedAt = now;
    S.data[t][rec.id] = rec;
    (S.dirty[t] = S.dirty[t] || {})[rec.id] = 1;
    out.push(rec);
  }
  await persistTable(t);
  await persistDirty();
  emit();
  saveHook();
  return out;
}

export function remove(t, id) {
  const r = S.data[t][id];
  if (!r) return;
  return save(t, Object.assign({}, r, { deleted: true }));
}

export function pendingCount() {
  return Object.values(S.dirty).reduce((n, m) => n + Object.keys(m).length, 0) +
    all('photos').filter(p => !p.fileId).length;
}

export function exportAll() {
  const out = { exportedAt: new Date().toISOString() };
  for (const t of TABLES) out[t] = Object.values(S.data[t]);
  return out;
}
