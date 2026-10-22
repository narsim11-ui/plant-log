// Care logic: rotation position, watering intervals, drying estimate, trip flags, labels.
import { all, byId } from './store.js';

const DAY = 86400000;
export const WATER_TYPES = ['water', 'flush'];
export const EST_WINDOW = 10;   // intervals used for the estimate
export const EST_MIN = 3;       // intervals needed before a (faded) estimate shows

export const EVENT_LABELS = {
  water: 'Watered', flush: 'Flush', repot: 'Repot', pest: 'Pest treatment',
  prune: 'Prune', note: 'Note',
};

// ---------- dates ----------
export const ymd = d => {
  d = new Date(d);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const todayYmd = () => ymd(Date.now());
export const startOfDay = d => { d = new Date(d); d.setHours(0, 0, 0, 0); return d.getTime(); };
// Calendar days between two moments (local time), b - a.
export const calDays = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY);
export const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(d, { year = 'auto' } = {}) {
  d = new Date(typeof d === 'string' && d.length === 10 ? parseYmd(d) : d);
  const showYear = year === true || (year === 'auto' && d.getFullYear() !== new Date().getFullYear());
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${showYear ? ' ' + d.getFullYear() : ''}`;
}
export function ago(ts) {
  if (ts == null) return '—';
  const n = calDays(ts, Date.now());
  if (n <= 0) return 'today';
  if (n === 1) return '1d ago';
  return `${n}d ago`;
}

// ---------- feeds & steps ----------
export function feedLabel(id) {
  const f = byId('feeds', id);
  return f ? (f.short || f.name) : '?';
}
export function stepLabel(feeds) {
  if (!feeds || !feeds.length) return 'Plain';
  return feeds.map(feedLabel).join(' + ');
}
export function scheduleSummary(s) {
  return (s.steps || []).map(stepLabel).join(' → ');
}

// ---------- events ----------
export function plantEvents(plantId) {
  return all('events').filter(e => e.plantId === plantId).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}
export const waterings = evs => evs.filter(e => WATER_TYPES.includes(e.type));
export const lastOf = (evs, pred) => { for (let i = evs.length - 1; i >= 0; i--) if (pred(evs[i])) return evs[i]; return null; };

export function nextStep(plant, evs) {
  const s = byId('schedules', plant.scheduleId);
  if (!s || !s.steps || !s.steps.length) return null;
  evs = evs || plantEvents(plant.id);
  const last = lastOf(evs, e => e.scheduleId === s.id && e.stepIndex != null && WATER_TYPES.includes(e.type));
  const lastTs = last ? Date.parse(last.date) : 0;
  let idx;
  if (plant.overrideIdx != null && plant.overrideAt > lastTs) idx = plant.overrideIdx;
  else idx = last ? last.stepIndex + 1 : 0;
  idx = ((idx % s.steps.length) + s.steps.length) % s.steps.length;
  return { schedule: s, idx, feeds: s.steps[idx] || [] };
}

// ---------- trips ----------
export function activeTrip() {
  const t = todayYmd();
  return all('trips').find(tr => tr.start <= t && (!tr.end || tr.end >= t)) || null;
}
// True if a moment falls inside a trip, or within a day either side of it.
export function nearTrip(ts) {
  const d = startOfDay(ts);
  return all('trips').some(tr => {
    const s = parseYmd(tr.start) - DAY;
    const e = (tr.end ? parseYmd(tr.end) : startOfDay(Date.now())) + DAY;
    return d >= s && d <= e;
  });
}

// ---------- intervals & estimate ----------
// Each interval is attached to the watering that ends it.
export function intervals(evs) {
  const ws = waterings(evs);
  const repots = evs.filter(e => e.type === 'repot').map(e => Date.parse(e.date));
  const out = [];
  for (let i = 1; i < ws.length; i++) {
    const a = ws[i - 1], b = ws[i];
    const ta = Date.parse(a.date), tb = Date.parse(b.date);
    const days = (tb - ta) / DAY;
    if (days < 0.5) continue; // same-day double log
    const spansRepot = repots.some(r => r > ta && r <= tb);
    const reasons = [];
    if (a.byHelper || b.byHelper) reasons.push('helper');
    if (nearTrip(ta) || nearTrip(tb)) reasons.push('trip');
    if (spansRepot) reasons.push('repot');
    out.push({ from: a, to: b, ts: tb, days, clean: !reasons.length, reasons });
  }
  return out;
}

export function estimate(evs) {
  const ivs = intervals(evs);
  const lastRepot = lastOf(evs, e => e.type === 'repot');
  const since = lastRepot ? Date.parse(lastRepot.date) : -Infinity;
  const clean = ivs.filter(iv => iv.clean && Date.parse(iv.from.date) >= since).slice(-EST_WINDOW);
  const lastW = lastOf(evs, e => WATER_TYPES.includes(e.type));
  if (clean.length < EST_MIN || !lastW) return { n: clean.length, est: null, lastW };
  let sw = 0, sd = 0;
  clean.forEach((iv, i) => { const w = i + 1; sw += w; sd += w * iv.days; });
  const est = sd / sw;
  const due = Date.parse(lastW.date) + est * DAY;
  return { n: clean.length, est, due, confident: clean.length >= EST_WINDOW, lastW };
}

// Short label for the estimate chip: "~2d", "~today", "~1d over".
export function dueLabel(e) {
  if (!e || e.est == null) return null;
  const n = calDays(Date.now(), e.due);
  if (n > 0) return { text: `~${n}d`, state: 'later' };
  if (n === 0) return { text: '~today', state: 'due' };
  return { text: `~${-n}d over`, state: 'over' };
}

// ---------- photos ----------
export function plantPhotos(plantId) {
  return all('photos').filter(p => p.plantId === plantId);
}
// Sessions = photos grouped by date, newest first. Cover = flagged photo or first.
export function sessions(plantId) {
  const by = {};
  plantPhotos(plantId).forEach(p => (by[p.date] = by[p.date] || []).push(p));
  return Object.keys(by).sort().reverse().map(date => {
    const ps = by[date].sort((a, b) => a.createdAt - b.createdAt);
    return { date, photos: ps, cover: ps.find(p => p.cover) || ps[0], day0: ps.some(p => p.day0) };
  });
}
export function plantCover(plantId) {
  const s = sessions(plantId);
  return s.length ? s[0].cover : null;
}

// ---------- plants ----------
export function plantsByLocation({ withArchived = false } = {}) {
  const locs = all('locations').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const plants = all('plants', { withArchived }).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  const groups = locs.map(l => ({ loc: l, plants: plants.filter(p => p.locationId === l.id) }));
  const known = new Set(locs.map(l => l.id));
  const orphan = plants.filter(p => !known.has(p.locationId));
  if (orphan.length) groups.push({ loc: { id: '', name: 'No location' }, plants: orphan });
  return groups;
}
