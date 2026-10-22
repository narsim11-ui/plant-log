// Hand-drawn SVG charts (no library, works offline).
import { intervals, waterings, stepLabel, fmtDate, parseYmd, startOfDay } from './logic.js';
import { all } from './store.js';
import { esc } from './ui.js';

const DAY = 86400000;

function niceMax(v) {
  if (v <= 4) return 4;
  const steps = [5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60];
  return steps.find(s => s >= v) || Math.ceil(v / 10) * 10;
}

export const RANGES = { '3m': 92, '6m': 183, '1y': 365, all: null };

// Days between waterings, plotted at the watering that ends each interval.
export function intervalChart(el, evs, est, range = '6m') {
  const W = Math.max(280, el.clientWidth || 340), H = 200;
  const m = { l: 30, r: 12, t: 22, b: 26 };
  const ivs = intervals(evs);
  const now = Date.now();
  const firstTs = ivs.length ? ivs[0].ts : now - 30 * DAY;
  const x0 = RANGES[range] ? Math.max(now - RANGES[range] * DAY, Math.min(firstTs, now - 14 * DAY)) : Math.min(firstTs, now - 14 * DAY);
  const shown = ivs.filter(iv => iv.ts >= x0);
  if (!shown.length) {
    el.innerHTML = `<p class="muted small chart-empty">Needs at least two waterings in this range.</p>`;
    return;
  }
  const yMax = niceMax(Math.max(...shown.map(i => i.days), est && est.est || 0) * 1.1);
  const X = t => m.l + (t - x0) / (now - x0) * (W - m.l - m.r);
  const Y = d => m.t + (1 - d / yMax) * (H - m.t - m.b);
  const parts = [];

  // grid + y labels
  const yStep = yMax <= 6 ? 1 : yMax <= 12 ? 2 : yMax <= 30 ? 5 : 10;
  for (let v = 0; v <= yMax; v += yStep) {
    parts.push(`<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>`);
    parts.push(`<text class="axis" x="${m.l - 6}" y="${Y(v) + 3.5}" text-anchor="end">${v}</text>`);
  }
  // x labels: month starts
  const d = new Date(x0); d.setDate(1); d.setMonth(d.getMonth() + 1); d.setHours(0, 0, 0, 0);
  const months = [];
  while (d.getTime() < now) { months.push(d.getTime()); d.setMonth(d.getMonth() + 1); }
  const every = Math.ceil(months.length / Math.floor((W - m.l - m.r) / 48)) || 1;
  months.forEach((t, i) => {
    if (i % every) return;
    parts.push(`<text class="axis" x="${X(t)}" y="${H - 8}" text-anchor="middle">${fmtDate(t).replace(/^\d+ /, '')}</text>`);
  });

  // trip bands
  all('trips').forEach(tr => {
    const s = Math.max(parseYmd(tr.start), x0), e = Math.min((tr.end ? parseYmd(tr.end) : startOfDay(now)) + DAY, now);
    if (e <= x0 || s >= now) return;
    parts.push(`<rect class="band" x="${X(s)}" y="${m.t}" width="${Math.max(2, X(e) - X(s))}" height="${H - m.t - m.b}"/>`);
    parts.push(`<text class="band-label" x="${X(s) + 3}" y="${m.t - 6}">Trip</text>`);
  });
  // repots
  evs.filter(e => e.type === 'repot' && Date.parse(e.date) >= x0).forEach(e => {
    const x = X(Date.parse(e.date));
    parts.push(`<line class="repot" x1="${x}" x2="${x}" y1="${m.t}" y2="${H - m.b}"/>`);
    parts.push(`<text class="band-label" x="${x + 3}" y="${m.t - 6}">Repot</text>`);
  });
  // estimate reference
  if (est && est.est != null) {
    const y = Y(est.est);
    parts.push(`<line class="est" x1="${m.l}" x2="${W - m.r}" y1="${y}" y2="${y}"/>`);
    parts.push(`<text class="est-label" x="${m.l + 4}" y="${y - 5}">est ${est.est.toFixed(1)}d</text>`);
  }
  // line through clean intervals
  const clean = shown.filter(i => i.clean);
  if (clean.length > 1) parts.push(`<polyline class="series" points="${clean.map(i => `${X(i.ts)},${Y(i.days)}`).join(' ')}"/>`);
  // points
  shown.forEach((iv, i) => {
    parts.push(`<circle class="${iv.clean ? 'pt' : 'pt flagged'}" cx="${X(iv.ts)}" cy="${Y(iv.days)}" r="4"/>`);
  });
  shown.forEach((iv, i) => {
    parts.push(`<circle class="hit" data-i="${i}" cx="${X(iv.ts)}" cy="${Y(iv.days)}" r="14"/>`);
  });

  el.innerHTML = `<div class="chart-wrap"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Days between waterings">${parts.join('')}</svg><div class="tip" hidden></div></div>`;
  const tip = el.querySelector('.tip');
  el.querySelectorAll('.hit').forEach(c => {
    const show = () => {
      const iv = shown[+c.dataset.i];
      const what = iv.to.type === 'flush' ? 'Flush' : stepLabel(iv.to.feeds);
      tip.innerHTML = `<b>${iv.days.toFixed(1)} days</b><br>${fmtDate(iv.ts)} · ${esc(what)}${iv.reasons.length ? `<br><span class="muted">Excluded: ${iv.reasons.join(', ')}</span>` : ''}`;
      tip.hidden = false;
      const cx = +c.getAttribute('cx'), cy = +c.getAttribute('cy');
      tip.style.left = Math.min(Math.max(cx - 70, 0), W - 150) + 'px';
      tip.style.top = (cy > H / 2 ? cy - 70 : cy + 14) + 'px';
    };
    c.addEventListener('pointerenter', show);
    c.addEventListener('click', show);
  });
  el.querySelector('svg').addEventListener('pointerleave', () => { tip.hidden = true; });
}

// What each watering was, over the last N days.
export function feedMix(evs, days = 90) {
  const from = Date.now() - days * DAY;
  const ws = waterings(evs).filter(e => Date.parse(e.date) >= from);
  if (!ws.length) return `<p class="muted small">No waterings in the last ${days} days.</p>`;
  const counts = {};
  ws.forEach(e => {
    const k = e.type === 'flush' ? 'Flush' : stepLabel(e.feeds);
    counts[k] = (counts[k] || 0) + 1;
  });
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = rows[0][1];
  return `<div class="bars">${rows.map(([k, n]) => `
    <div class="bar-row"><span class="bar-label">${esc(k)}</span>
      <span class="bar-track"><span class="bar" style="width:${(n / max) * 100}%"></span></span>
      <span class="bar-val">${n}</span></div>`).join('')}</div>
    <p class="muted small">${ws.length} waterings in the last ${days} days.</p>`;
}
