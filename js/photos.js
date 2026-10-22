// Photo handling: on-phone compression, EXIF capture date, local blob cache, object URLs.
import { blobGet, blobPut, S, emit } from './store.js';

const THUMB_EDGE = 360;

export async function compress(file, maxEdge, quality = 0.82) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', quality));
  return { blob, w, h };
}

export async function prepare(file) {
  const [full, thumb, date] = await Promise.all([
    compress(file, S.settings.maxEdge || 1600, 0.82),
    compress(file, THUMB_EDGE, 0.72),
    exifDate(file),
  ]);
  return { full, thumb, date };
}

// Reads DateTimeOriginal (or DateTime) from a JPEG's EXIF block. Returns 'YYYY-MM-DD' or null.
export async function exifDate(file) {
  try {
    const buf = await file.slice(0, 256 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xFFD8) return null;
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off);
      const len = v.getUint16(off + 2);
      if (marker === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10);
      if ((marker & 0xFF00) !== 0xFF00) return null;
      off += 2 + len;
    }
  } catch (e) { /* unreadable: fall through */ }
  return null;
}

function parseTiff(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = o => v.getUint16(t + o, le), u32 = o => v.getUint32(t + o, le);
  const readIfd = (o, want) => {
    const n = u16(o), found = {};
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12, tag = u16(e);
      if (want.includes(tag)) found[tag] = { type: u16(e + 2), count: u32(e + 4), val: u32(e + 8) };
    }
    return found;
  };
  const str = ent => {
    let s = '';
    for (let i = 0; i < ent.count - 1; i++) s += String.fromCharCode(v.getUint8(t + ent.val + i));
    return s;
  };
  const ifd0 = readIfd(u32(4), [0x8769, 0x0132]);
  let raw = null;
  if (ifd0[0x8769]) {
    const ex = readIfd(ifd0[0x8769].val, [0x9003]);
    if (ex[0x9003]) raw = str(ex[0x9003]);
  }
  if (!raw && ifd0[0x0132]) raw = str(ifd0[0x0132]);
  const m = raw && raw.match(/^(\d{4}):(\d{2}):(\d{2})/);
  return m && m[1] !== '0000' ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// ---------- object URLs ----------
const urls = new Map();       // blob key -> object URL
const wanted = new Set();     // remote thumbs to fetch
let fetcher = null;           // set by sync.js: (photos) => Promise

export const setRemoteFetcher = fn => { fetcher = fn; };

export async function storeLocal(photoId, full, thumb) {
  await blobPut(photoId + ':full', full);
  await blobPut(photoId + ':thumb', thumb);
}

// Synchronous: returns a URL if ready, otherwise '' and loads in the background, then re-renders.
export function photoUrl(p, size = 'thumb') {
  if (!p) return '';
  const key = p.id + ':' + size;
  if (urls.has(key)) return urls.get(key) || '';
  urls.set(key, null);
  blobGet(key).then(b => {
    if (b) { urls.set(key, URL.createObjectURL(b)); emit(); return; }
    urls.delete(key);
    const remoteId = size === 'thumb' ? p.thumbId : p.fileId;
    if (remoteId && fetcher) { wanted.add(JSON.stringify([p.id, size, remoteId])); scheduleFetch(); }
  });
  return '';
}

let fetchTimer = null, fetching = false;
function scheduleFetch() {
  clearTimeout(fetchTimer);
  fetchTimer = setTimeout(runFetch, 150);
}
async function runFetch() {
  if (fetching || !wanted.size) return;
  fetching = true;
  const batch = [...wanted].slice(0, 12).map(s => JSON.parse(s));
  batch.forEach(b => wanted.delete(JSON.stringify(b)));
  try {
    const got = await fetcher(batch.map(b => b[2]));
    for (const [pid, size, rid] of batch) {
      if (!got[rid]) continue;
      const blob = b64ToBlob(got[rid]);
      await blobPut(pid + ':' + size, blob);
      urls.set(pid + ':' + size, URL.createObjectURL(blob));
    }
    emit();
  } catch (e) {
    // Leave them unfetched; the next render will ask again.
    batch.forEach(([pid, size]) => urls.delete(pid + ':' + size));
  } finally {
    fetching = false;
    if (wanted.size) scheduleFetch();
  }
}

export function b64ToBlob(b64, type = 'image/jpeg') {
  const bin = atob(b64), arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}
export function blobToB64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
