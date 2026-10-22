import { S, load, onChange, all, byId, save, saveMany, remove, saveSettings, pendingCount, exportAll, uid } from './store.js';
import {
  plantEvents, nextStep, estimate, dueLabel, stepLabel, scheduleSummary, feedLabel, ago, fmtDate, ymd, todayYmd,
  calDays, activeTrip, nearTrip, sessions, plantCover, plantsByLocation, lastOf, waterings, EVENT_LABELS, EST_MIN, EST_WINDOW, parseYmd,
} from './logic.js';
import { prepare, storeLocal, photoUrl } from './photos.js';
import { sync, startSync, status, configured, call } from './sync.js';
import { intervalChart, feedMix, RANGES } from './charts.js';
import { esc, $, $$, openSheet, closeSheet, toast, confirmSheet, formData, icon } from './ui.js';

const app = $('#app');
const POT_MATERIALS = ['Terracotta', 'Plastic', 'Glazed ceramic', 'Concrete', '3D printed (PETG)', '3D printed (PLA)', 'Self-watering', 'Other'];
const FEED_TYPES = ['NPK', 'Seaweed', 'Fruiting NPK', 'Cal-Mag', 'Other'];
const ui = {
  search: '',
  collapsed: JSON.parse(localStorage.getItem('collapsed') || '{}'),
  chartRange: localStorage.getItem('chartRange') || '6m',
  overviewSort: 'water',
  overviewUnassigned: false,
  homeScroll: 0,
  lastRoute: '',
};

// ---------- router ----------
function parseRoute() {
  const parts = (location.hash.slice(1) || '/').split('/').filter(Boolean);
  return { name: parts[0] || 'home', id: parts[1], tab: parts[2] };
}

function render() {
  const r = parseRoute();
  const key = r.name + '/' + (r.id || '');
  if (ui.lastRoute.startsWith('home') && !key.startsWith('home')) ui.homeScroll = window.scrollY;
  const focused = document.activeElement && document.activeElement.id === 'search';
  let mount = null;
  if (r.name === 'plant' && byId('plants', r.id)) mount = renderPlant(r.id, r.tab || 'log');
  else if (r.name === 'settings') renderSettings();
  else if (r.name === 'overview') renderOverview();
  else renderHome();
  if (key !== ui.lastRoute) window.scrollTo(0, key.startsWith('home') ? ui.homeScroll : 0);
  ui.lastRoute = key;
  if (focused) { const s = $('#search'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }
  if (mount) mount();
}

// ---------- shared bits ----------
function syncChip() {
  const n = pendingCount();
  const map = {
    local: ['Not connected', 'warn'], offline: [`Offline${n ? ` · ${n} queued` : ''}`, 'warn'],
    syncing: ['Syncing…', ''], ok: [n ? `${n} to sync` : 'Synced', 'ok'], error: ['Sync error', 'err'], idle: ['…', ''],
  };
  const [label, cls] = map[status.state] || map.idle;
  return `<button class="sync-chip ${cls}" data-act="sync-chip"><span class="dot"></span>${label}</button>`;
}

function thumbHtml(p, cls = 'thumb') {
  const url = photoUrl(p, 'thumb');
  return `<span class="${cls}">${url ? `<img src="${url}" alt="">` : icon('leaf')}</span>`;
}

function plantState(plant) {
  const evs = plantEvents(plant.id);
  const lastW = lastOf(evs, e => e.type === 'water' || e.type === 'flush');
  const lastFeed = lastOf(evs, e => e.type === 'water' && e.feeds && e.feeds.length);
  const lastRepot = lastOf(evs, e => e.type === 'repot');
  return { evs, lastW, lastFeed, lastRepot, ns: nextStep(plant, evs), est: estimate(evs) };
}

function eventSummary(e) {
  if (e.type === 'water') return `Watered · ${stepLabel(e.feeds)}`;
  if (e.type === 'repot') return `Repot${e.potDiameter ? ` · ${e.potDiameter}${e.potDepth ? '×' + e.potDepth : ''} cm` : ''}${e.potMaterial ? ' ' + e.potMaterial.toLowerCase() : ''}`;
  return EVENT_LABELS[e.type] || e.type;
}

// ---------- home ----------
function renderHome() {
  const trip = activeTrip();
  const groups = plantsByLocation();
  const q = ui.search.toLowerCase();
  const nothing = !all('locations').length && !all('plants').length;

  const sections = groups.map(g => {
    const plants = q ? g.plants.filter(p => (p.name + ' ' + (p.species || '')).toLowerCase().includes(q)) : g.plants;
    if (!plants.length && (q || !g.loc.id)) return '';
    const states = plants.map(p => [p, plantState(p)]);
    const due = states.filter(([, s]) => { const d = dueLabel(s.est); return d && d.state !== 'later'; }).length;
    const collapsed = !q && ui.collapsed[g.loc.id];
    return `<section class="loc">
      <button class="loc-head" data-act="toggle-loc" data-id="${esc(g.loc.id)}" aria-expanded="${!collapsed}">
        <span class="loc-name">${esc(g.loc.name)}</span>
        <span class="loc-meta">${plants.length}${due ? ` · <b>${due} due</b>` : ''}</span>
        <span class="chev">${icon(collapsed ? 'down' : 'up')}</span>
      </button>
      ${collapsed ? '' : plants.length ? states.map(([p, s]) => plantRow(p, s)).join('') : `<p class="muted small pad">No plants here yet.</p>`}
    </section>`;
  }).join('');

  app.innerHTML = `
    <header class="top"><h1>Plants</h1><div class="top-actions">${syncChip()}
      <a class="icon-btn" href="#/overview" aria-label="Overview">${icon('grid')}</a>
      <a class="icon-btn" href="#/settings" aria-label="Settings">${icon('gear')}</a></div></header>
    ${trip ? `<div class="banner trip">${icon('plane')}<span>Travelling since ${fmtDate(trip.start)}. Waterings are marked as trip-affected.</span><button class="btn sm" data-act="end-trip" data-id="${trip.id}">I'm back</button></div>` : ''}
    ${!configured() && !nothing ? `<a class="banner warn" href="#/settings">${icon('cloud')}<span>Not connected to Google Drive. Data is only on this phone.</span></a>` : ''}
    ${nothing ? `<div class="empty"><h2>Start with your locations</h2><p class="muted">Add them in the order you water — Kitchen utility, Living room, Balcony… Plants are grouped and sorted by these.</p><button class="btn primary" data-act="add-location">Add a location</button><p class="muted small">Or <a href="#/settings">connect Google Drive first</a> if you've used the app on another phone.</p></div>` : `
    <div class="search-wrap">${icon('search')}<input id="search" type="search" placeholder="Find a plant" value="${esc(ui.search)}" autocomplete="off"></div>
    ${sections}
    <div class="home-foot">${trip ? '' : `<button class="btn ghost sm" data-act="start-trip">${icon('plane')} Start a trip</button>`}</div>`}
    ${nothing ? '' : `<button class="fab" data-act="add-plant" aria-label="Add plant">${icon('plus')}</button>`}`;
}

function plantRow(p, s) {
  const d = dueLabel(s.est);
  const wateredToday = s.lastW && calDays(s.lastW.date, Date.now()) === 0;
  const next = s.ns ? stepLabel(s.ns.feeds) : 'Water';
  const lastWhat = s.lastW ? (s.lastW.type === 'flush' ? 'flush' : stepLabel(s.lastW.feeds).toLowerCase() === 'plain' ? 'plain' : stepLabel(s.lastW.feeds)) : '';
  return `<div class="prow">
    <a class="prow-main" href="#/plant/${p.id}">${thumbHtml(plantCover(p.id))}
      <span class="prow-text"><span class="pname">${esc(p.name)}</span>
      <span class="pmeta">${s.lastW ? `${ago(s.lastW.date)} · ${esc(lastWhat)}` : 'No waterings yet'}${d ? ` <span class="due s-${d.state} ${s.est.confident ? '' : 'faint'}">${d.text}</span>` : ''}</span></span></a>
    ${wateredToday
      ? `<button class="step-btn done" data-act="log-sheet" data-id="${p.id}">${icon('check')} Today</button>`
      : `<button class="step-btn" data-act="quick-log" data-id="${p.id}">${esc(next)}</button>`}
    <button class="more-btn" data-act="log-sheet" data-id="${p.id}" aria-label="More options">${icon('dots')}</button>
  </div>`;
}

async function quickLog(plantId) {
  const p = byId('plants', plantId);
  const ns = nextStep(p);
  const ev = await save('events', {
    plantId, type: 'water', date: new Date().toISOString(), feeds: ns ? ns.feeds : [],
    scheduleId: ns ? ns.schedule.id : undefined, stepIndex: ns ? ns.idx : undefined,
    byHelper: !!activeTrip() || undefined,
  });
  toast(`${p.name}: ${ns ? stepLabel(ns.feeds) : 'watered'}`, { label: 'Undo', fn: () => remove('events', ev.id) });
}

// ---------- log sheet (new or edit) ----------
function openLogSheet(plantId, existing, presetType) {
  const p = byId('plants', plantId);
  const ev = existing || {};
  const type = ev.type || presetType || 'water';
  const ns = nextStep(p);
  const sched = byId('schedules', p.scheduleId);
  const feeds = all('feeds').sort((a, b) => a.name.localeCompare(b.name));
  // Which rotation step is selected: an existing event's step, or the next one.
  let stepSel = existing ? (ev.stepIndex != null && ev.scheduleId === p.scheduleId ? ev.stepIndex : 'off') : (ns ? ns.idx : 'off');
  let customFeeds = new Set(existing && stepSel === 'off' ? (ev.feeds || []) : []);
  const evDate = ev.date ? ymd(ev.date) : todayYmd();
  const types = ['water', 'flush', 'repot', 'pest', 'prune', 'note'];

  const html = `
    <h2>${existing ? 'Edit entry' : 'Log'} · ${esc(p.name)}</h2>
    <form id="logf">
      <div class="seg" role="radiogroup">${types.map(t => `<label><input type="radio" name="type" value="${t}" ${t === type ? 'checked' : ''}><span>${t === 'water' ? 'Water' : EVENT_LABELS[t]}</span></label>`).join('')}</div>
      <div data-for="water">
        ${sched ? `<p class="lbl">Rotation · ${esc(sched.name)}</p>
          <div class="chips" id="steps">${sched.steps.map((st, i) => `<button type="button" class="chip ${stepSel === i ? 'on' : ''}" data-step="${i}">${i + 1}. ${esc(stepLabel(st))}${ns && ns.idx === i ? ' <small>next</small>' : ''}</button>`).join('')}
            <button type="button" class="chip ${stepSel === 'off' ? 'on' : ''}" data-step="off">Off-schedule…</button></div>`
          : `<p class="muted small">No rotation assigned. Pick what went in the water (nothing = plain).</p>`}
        <div id="custom" ${sched && stepSel !== 'off' ? 'hidden' : ''}>
          <p class="lbl">What went in the water</p>
          <div class="chips">${feeds.map(f => `<button type="button" class="chip ${customFeeds.has(f.id) ? 'on' : ''}" data-feed="${f.id}">${esc(f.short || f.name)}</button>`).join('') || '<span class="muted small">No feeds yet — add them in Settings.</span>'}</div>
          <p class="muted small">Nothing selected = plain water. Off-schedule waterings don't move the rotation.</p>
        </div>
      </div>
      <div data-for="repot" hidden>
        <p class="muted small">Updates the plant's pot details too, and restarts the drying estimate.</p>
        <div class="grid2">
          <label>New pot Ø (cm)<input type="number" name="potDiameter" step="0.5" inputmode="decimal" value="${esc(ev.potDiameter ?? '')}"></label>
          <label>Depth (cm)<input type="number" name="potDepth" step="0.5" inputmode="decimal" value="${esc(ev.potDepth ?? '')}"></label>
        </div>
        <label>Material<select name="potMaterial"><option value="">—</option>${POT_MATERIALS.map(m => `<option ${ev.potMaterial === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label>Soil mix<textarea name="soil" rows="2" placeholder="e.g. cocopeat 40 / perlite 30 / bark 20 / vermicompost 10">${esc(ev.soil || '')}</textarea></label>
      </div>
      <label>Note<textarea name="note" rows="2" placeholder="Optional">${esc(ev.note || '')}</textarea></label>
      <div class="grid2">
        <label>Date<input type="date" name="date" value="${evDate}" max="${todayYmd()}"></label>
        <label class="check"><input type="checkbox" name="byHelper" ${ev.byHelper || (!existing && activeTrip()) ? 'checked' : ''}> Done by helper</label>
      </div>
      <div class="row-btns">
        ${existing ? `<button type="button" class="btn danger" data-del>Delete</button>` : ''}
        <button type="submit" class="btn primary">${existing ? 'Save' : 'Log it'}</button>
      </div>
    </form>`;

  openSheet(html, el => {
    const f = $('#logf', el);
    const sync = () => {
      const t = f.type.value;
      $$('[data-for]', el).forEach(s => { s.hidden = s.dataset.for !== t; });
    };
    sync();
    f.addEventListener('change', e => { if (e.target.name === 'type') sync(); });
    el.addEventListener('click', e => {
      const st = e.target.closest('[data-step]');
      if (st) {
        stepSel = st.dataset.step === 'off' ? 'off' : +st.dataset.step;
        $$('[data-step]', el).forEach(b => b.classList.toggle('on', b === st));
        $('#custom', el).hidden = stepSel !== 'off';
      }
      const fd = e.target.closest('[data-feed]');
      if (fd) { customFeeds.has(fd.dataset.feed) ? customFeeds.delete(fd.dataset.feed) : customFeeds.add(fd.dataset.feed); fd.classList.toggle('on'); }
    });
    const del = $('[data-del]', el);
    if (del) del.onclick = async () => { await remove('events', ev.id); closeSheet(); toast('Entry deleted', { label: 'Undo', fn: () => save('events', Object.assign({}, ev, { deleted: false })) }); };
    f.onsubmit = async e => {
      e.preventDefault();
      const d = formData(f);
      const t = f.type.value;
      const keepTime = ev.date && ymd(ev.date) === d.date;
      const date = keepTime ? ev.date : d.date === todayYmd() ? new Date().toISOString() : new Date(parseYmd(d.date) + 12 * 3600e3).toISOString();
      const rec = { id: ev.id, createdAt: ev.createdAt, plantId, type: t, date, note: d.note || undefined, byHelper: d.byHelper || undefined };
      if (t === 'water') {
        if (sched && stepSel !== 'off') Object.assign(rec, { feeds: sched.steps[stepSel] || [], scheduleId: sched.id, stepIndex: stepSel });
        else Object.assign(rec, { feeds: [...customFeeds], offSchedule: !!sched || undefined });
      }
      if (t === 'repot') {
        Object.assign(rec, { potDiameter: d.potDiameter ?? undefined, potDepth: d.potDepth ?? undefined, potMaterial: d.potMaterial || undefined, soil: d.soil || undefined });
        const patch = {};
        if (d.potDiameter != null) patch.potDiameter = d.potDiameter;
        if (d.potDepth != null) patch.potDepth = d.potDepth;
        if (d.potMaterial) patch.potMaterial = d.potMaterial;
        if (d.soil) patch.soil = d.soil;
        if (Object.keys(patch).length) await save('plants', Object.assign({}, byId('plants', plantId), patch));
      }
      await save('events', rec);
      closeSheet();
      toast(existing ? 'Saved' : `Logged: ${t === 'water' ? stepLabel(rec.feeds) : EVENT_LABELS[t]}`);
    };
  });
}

// ---------- plant page ----------
function renderPlant(id, tab) {
  const p = byId('plants', id);
  const s = plantState(p);
  const loc = byId('locations', p.locationId);
  const cover = plantCover(id);
  const coverUrl = cover ? photoUrl(cover, 'full') || photoUrl(cover, 'thumb') : '';
  const d = dueLabel(s.est);
  const tabs = [['log', 'Log'], ['photos', 'Photos'], ['charts', 'Charts'], ['details', 'Details']];

  const estText = s.est.est != null
    ? `${d.text} <span class="muted">· every ~${s.est.est.toFixed(1)}d, from ${s.est.n} waterings${s.est.confident ? '' : ' (low confidence)'}</span>`
    : `<span class="muted">Needs ${EST_MIN} clean intervals (has ${s.est.n})</span>`;

  app.innerHTML = `
    <header class="top sub"><a class="icon-btn" href="#/" aria-label="Back">${icon('back')}</a><h1>${esc(p.name)}</h1>
      <div class="top-actions">${syncChip()}</div></header>
    <div class="hero ${coverUrl ? '' : 'empty'}">${coverUrl ? `<img src="${coverUrl}" alt="">` : `<button class="btn ghost" data-act="add-photos" data-id="${id}">${icon('camera')} Add first photo</button>`}</div>
    <p class="subtitle">${esc([p.species, loc && loc.name].filter(Boolean).join(' · '))}${p.archived ? ' · <b>Archived</b>' : ''}</p>
    <dl class="stats">
      <div><dt>Last watered</dt><dd>${s.lastW ? `${ago(s.lastW.date)} <span class="muted">· ${fmtDate(s.lastW.date)} · ${esc(s.lastW.type === 'flush' ? 'Flush' : stepLabel(s.lastW.feeds))}</span>` : '—'}</dd></div>
      <div><dt>Next step</dt><dd>${s.ns ? `<button class="link" data-act="set-step" data-id="${id}">${esc(stepLabel(s.ns.feeds))}</button> <span class="muted">· step ${s.ns.idx + 1}/${s.ns.schedule.steps.length} of ${esc(s.ns.schedule.name)}</span>` : `<button class="link" data-act="edit-plant" data-id="${id}">Assign a rotation</button>`}</dd></div>
      <div><dt>Estimate</dt><dd>${estText}</dd></div>
      <div><dt>Last feed</dt><dd>${s.lastFeed ? `${esc(stepLabel(s.lastFeed.feeds))} <span class="muted">· ${ago(s.lastFeed.date)}</span>` : '—'}</dd></div>
      <div><dt>Last repot</dt><dd>${s.lastRepot ? `${fmtDate(s.lastRepot.date, { year: true })} <span class="muted">· ${calDays(s.lastRepot.date, Date.now())}d ago</span>` : '—'}</dd></div>
    </dl>
    <div class="actions">
      <button class="btn primary" data-act="quick-log" data-id="${id}">${icon('drop')} ${esc(s.ns ? stepLabel(s.ns.feeds) : 'Water')}</button>
      <button class="btn" data-act="log-sheet" data-id="${id}">Log…</button>
      <button class="btn" data-act="add-photos" data-id="${id}" aria-label="Add photos">${icon('camera')}</button>
    </div>
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/plant/${id}/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</nav>
    <section class="tab-body" id="tab">${tab === 'photos' ? photosTab(p) : tab === 'charts' ? chartsTab(p, s) : tab === 'details' ? detailsTab(p) : logTab(p, s)}</section>`;

  if (tab === 'charts') return () => intervalChart($('#ivchart'), s.evs, s.est, ui.chartRange);
  return null;
}

function logTab(p, s) {
  if (!s.evs.length) return `<p class="muted pad">Nothing logged yet.</p>`;
  let month = '';
  return `<ul class="log">${[...s.evs].reverse().map(e => {
    const m = fmtDate(e.date, { year: true }).replace(/^\d+ /, '');
    const head = m !== month ? `<li class="log-month">${m}</li>` : '';
    month = m;
    const flags = [];
    if (e.byHelper) flags.push('helper');
    if ((e.type === 'water' || e.type === 'flush') && nearTrip(Date.parse(e.date))) flags.push('trip');
    if (e.offSchedule) flags.push('off-schedule');
    return `${head}<li><button class="log-item" data-act="edit-event" data-id="${e.id}">
      <span class="log-date">${new Date(e.date).getDate()}</span>
      <span class="log-text"><span>${esc(eventSummary(e))}</span>${flags.map(f => `<span class="flag">${f}</span>`).join('')}${e.note ? `<span class="log-note">${esc(e.note)}</span>` : ''}</span>
    </button></li>`;
  }).join('')}</ul>`;
}

function photosTab(p) {
  const ss = sessions(p.id);
  return `<div class="row-btns left">
      <button class="btn" data-act="add-photos" data-id="${p.id}">${icon('camera')} Add photos</button>
      ${ss.length > 1 ? `<button class="btn" data-act="compare" data-id="${p.id}">Compare</button>` : ''}
    </div>
    ${ss.length ? `<div class="sessions">${ss.map(x => `
      <button class="session" data-act="session" data-id="${p.id}" data-date="${x.date}">
        ${thumbHtml(x.cover, 'sthumb')}
        <span class="s-date">${fmtDate(x.date, { year: true })}${x.day0 ? ' <b class="badge">Day 0</b>' : ''}</span>
        <span class="muted small">${x.photos.length} photo${x.photos.length > 1 ? 's' : ''}</span>
      </button>`).join('')}</div>` : `<p class="muted pad">No photos yet. Older photos keep their original date if the file has it; otherwise you can set it.</p>`}`;
}

function chartsTab(p, s) {
  return `<div class="card">
      <div class="card-head"><h3>Days between waterings</h3>
        <div class="seg sm">${Object.keys(RANGES).map(r => `<button class="${r === ui.chartRange ? 'on' : ''}" data-act="range" data-r="${r}">${r}</button>`).join('')}</div></div>
      <div id="ivchart" class="chart"></div>
      <p class="muted small">Hollow points were affected by a trip, a helper or a repot and are left out of the estimate. Dashed line = current estimate.</p>
    </div>
    <div class="card"><h3>What the waterings were · 90 days</h3>${feedMix(s.evs, 90)}</div>`;
}

function detailsTab(p) {
  const loc = byId('locations', p.locationId);
  const sched = byId('schedules', p.scheduleId);
  const row = (k, v) => `<div><dt>${k}</dt><dd>${v || '<span class="muted">—</span>'}</dd></div>`;
  return `<dl class="stats details">
      ${row('Species', esc(p.species))}
      ${row('Location', esc(loc && loc.name))}
      ${row('Rotation', sched ? `${esc(sched.name)}<br><span class="muted small">${esc(scheduleSummary(sched))}</span>` : '')}
      ${row('Pot', [p.potDiameter && `Ø ${p.potDiameter} cm`, p.potDepth && `${p.potDepth} cm deep`, p.potMaterial && esc(p.potMaterial), p.drainage === false ? 'no drainage' : p.drainage ? 'drainage' : ''].filter(Boolean).join(' · '))}
      ${row('Soil mix', esc(p.soil))}
      ${row('Acquired', esc(p.acquired))}
      ${row('Notes', esc(p.notes).replace(/\n/g, '<br>'))}
    </dl>
    <div class="row-btns left wrap">
      <button class="btn" data-act="edit-plant" data-id="${p.id}">Edit</button>
      <button class="btn" data-act="copy-summary" data-id="${p.id}">Copy summary for Claude</button>
      <button class="btn" data-act="archive" data-id="${p.id}">${p.archived ? 'Unarchive' : 'Archive'}</button>
      <button class="btn danger ghost" data-act="delete-plant" data-id="${p.id}">Delete</button>
    </div>`;
}

// ---------- plant form ----------
function openPlantForm(existing) {
  const p = existing || { drainage: true, locationId: (plantsByLocation()[0] || { loc: {} }).loc.id };
  const locs = all('locations').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const scheds = all('schedules').sort((a, b) => a.name.localeCompare(b.name));
  openSheet(`<h2>${existing ? 'Edit plant' : 'New plant'}</h2>
    <form id="pf">
      <label>Name<input name="name" required value="${esc(p.name || '')}" placeholder="e.g. Monstera Thai"></label>
      <label>Species / cultivar<input name="species" value="${esc(p.species || '')}" placeholder="Optional"></label>
      <label>Location<select name="locationId">${locs.map(l => `<option value="${l.id}" ${l.id === p.locationId ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}<option value="__new">+ New location…</option></select></label>
      <input name="newLoc" placeholder="New location name" hidden>
      <label>Rotation<select name="scheduleId"><option value="">None / not decided yet</option>${scheds.map(s => `<option value="${s.id}" ${s.id === p.scheduleId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <div class="grid2">
        <label>Pot Ø (cm)<input type="number" name="potDiameter" step="0.5" inputmode="decimal" value="${esc(p.potDiameter ?? '')}"></label>
        <label>Depth (cm)<input type="number" name="potDepth" step="0.5" inputmode="decimal" value="${esc(p.potDepth ?? '')}"></label>
      </div>
      <div class="grid2">
        <label>Material<select name="potMaterial"><option value="">—</option>${POT_MATERIALS.map(m => `<option ${p.potMaterial === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" name="drainage" ${p.drainage !== false ? 'checked' : ''}> Drainage hole</label>
      </div>
      <label>Soil mix<textarea name="soil" rows="2" placeholder="e.g. cocopeat 40 / perlite 30 / bark 20 / vermicompost 10">${esc(p.soil || '')}</textarea></label>
      <label>Acquired<input name="acquired" value="${esc(p.acquired || '')}" placeholder="Date, or rough: ~mid 2024"></label>
      <label>Notes<textarea name="notes" rows="2">${esc(p.notes || '')}</textarea></label>
      <div class="row-btns"><button class="btn primary" type="submit">${existing ? 'Save' : 'Add plant'}</button></div>
    </form>`, el => {
    const f = $('#pf', el);
    const sel = f.locationId, nl = f.newLoc;
    const toggle = () => { nl.hidden = sel.value !== '__new'; if (!nl.hidden) nl.focus(); };
    sel.onchange = toggle;
    if (!locs.length) { sel.value = '__new'; toggle(); }
    f.onsubmit = async e => {
      e.preventDefault();
      const d = formData(f);
      let locationId = d.locationId;
      if (locationId === '__new') {
        if (!d.newLoc) { nl.focus(); return; }
        locationId = (await save('locations', { name: d.newLoc, order: locs.length })).id;
      }
      const siblings = all('plants').filter(x => x.locationId === locationId);
      const rec = Object.assign({}, existing || {}, {
        name: d.name, species: d.species || undefined, locationId, scheduleId: d.scheduleId || undefined,
        potDiameter: d.potDiameter ?? undefined, potDepth: d.potDepth ?? undefined, potMaterial: d.potMaterial || undefined,
        drainage: d.drainage, soil: d.soil || undefined, acquired: d.acquired || undefined, notes: d.notes || undefined,
      });
      if (!existing || existing.locationId !== locationId) rec.order = siblings.length;
      const saved = await save('plants', rec);
      await closeSheet();
      if (!existing) location.hash = `#/plant/${saved.id}/photos`;
    };
  });
}

function openStepPicker(plantId) {
  const p = byId('plants', plantId);
  const ns = nextStep(p);
  openSheet(`<h2>Next step · ${esc(p.name)}</h2><p class="muted small">Use this to line the rotation up with where the plant actually is.</p>
    <div class="list">${ns.schedule.steps.map((st, i) => `<button class="list-item ${i === ns.idx ? 'on' : ''}" data-i="${i}">${i + 1}. ${esc(stepLabel(st))}${i === ns.idx ? ' <small>current</small>' : ''}</button>`).join('')}</div>`, el => {
    el.addEventListener('click', async e => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      await save('plants', Object.assign({}, p, { overrideIdx: +b.dataset.i, overrideAt: Date.now() }));
      closeSheet();
    });
  });
}

function copySummary(plantId) {
  const p = byId('plants', plantId);
  const s = plantState(p);
  const loc = byId('locations', p.locationId);
  const sched = byId('schedules', p.scheduleId);
  const from = Date.now() - 120 * 86400000;
  const lines = [
    `Plant: ${p.name}${p.species ? ` (${p.species})` : ''}`,
    `Location: ${loc ? loc.name : '—'}`,
    `Pot: ${[p.potDiameter && `Ø${p.potDiameter} cm`, p.potDepth && `${p.potDepth} cm deep`, p.potMaterial, p.drainage === false ? 'NO drainage' : 'drainage'].filter(Boolean).join(', ')}`,
    `Soil: ${p.soil || '—'}`,
    `Rotation: ${sched ? `${sched.name} (${scheduleSummary(sched)}), next: ${stepLabel(s.ns.feeds)}` : 'none'} · all feeds at ~half strength, by eye`,
    `Watering estimate: ${s.est.est != null ? `${s.est.est.toFixed(1)} days (from ${s.est.n} clean intervals)` : 'not enough data'}`,
    `Last repot: ${s.lastRepot ? ymd(s.lastRepot.date) : '—'} · Acquired: ${p.acquired || '—'}`,
    p.notes ? `Notes: ${p.notes}` : '',
    '', 'Log, last 120 days:',
    ...s.evs.filter(e => Date.parse(e.date) >= from).map(e => `${ymd(e.date)}  ${eventSummary(e)}${e.byHelper ? ' [helper]' : ''}${nearTrip(Date.parse(e.date)) ? ' [trip]' : ''}${e.note ? ` — ${e.note}` : ''}`),
    '', `Photo sessions: ${sessions(p.id).map(x => x.date + (x.day0 ? ' (Day 0)' : '')).join(', ') || 'none'}`,
    S.settings.folderUrl ? `Photos are in Google Drive: Plant Log/Photos/${p.name}` : '',
  ].filter(l => l !== null);
  navigator.clipboard.writeText(lines.join('\n')).then(() => toast('Copied — paste it into Claude'), () => toast('Could not copy'));
}

// ---------- photos ----------
let photoTarget = null;
function pickPhotos(plantId) {
  photoTarget = plantId;
  const input = $('#file');
  input.value = '';
  input.click();
}

async function handleFiles(files) {
  const plantId = photoTarget;
  if (!files.length || !plantId) return;
  const el = openSheet(`<h2>Preparing ${files.length} photo${files.length > 1 ? 's' : ''}…</h2><p class="muted">Shrinking to ${S.settings.maxEdge || 1600}px on the phone. Originals are not uploaded.</p>`);
  const items = [];
  for (const f of files) {
    try { items.push(Object.assign({ name: f.name }, await prepare(f))); } catch (e) { /* skip unreadable */ }
  }
  if (!items.length) { closeSheet(); toast('Could not read those files'); return; }
  const today = todayYmd();
  items.forEach(it => { it.url = URL.createObjectURL(it.thumb.blob); });
  el.innerHTML = `<div class="grab"></div><h2>Add ${items.length} photo${items.length > 1 ? 's' : ''}</h2>
    <form id="phf"><div class="ph-list">${items.map((it, i) => `<div class="ph-item"><img src="${it.url}" alt="">
      <label>Date<input type="date" name="d${i}" value="${it.date || today}" max="${today}"></label>
      <span class="small ${it.date ? 'muted' : 'warn-text'}">${it.date ? 'from photo' : 'no date in file — check'}</span></div>`).join('')}</div>
      <label class="check"><input type="checkbox" name="day0"> These are Day 0 (when I got the plant)</label>
      <div class="row-btns"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`;
  $('#phf', el).onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const recs = [];
    for (let i = 0; i < items.length; i++) {
      const id = uid();
      await storeLocal(id, items[i].full.blob, items[i].thumb.blob);
      recs.push({ id, plantId, date: f['d' + i].value || today, w: items[i].full.w, h: items[i].full.h, day0: f.day0.checked || undefined });
    }
    await saveMany('photos', recs);
    items.forEach(it => URL.revokeObjectURL(it.url));
    closeSheet();
    toast(`${recs.length} photo${recs.length > 1 ? 's' : ''} saved`);
  };
}

function openSession(plantId, date) {
  const ses = sessions(plantId).find(x => x.date === date);
  if (!ses) return;
  const html = () => `<h2>${fmtDate(date, { year: true })}${ses.day0 ? ' · Day 0' : ''}</h2>
    <div class="gallery">${ses.photos.map(p => `<figure><img src="${photoUrl(p, 'full') || photoUrl(p, 'thumb')}" alt="">
      <figcaption>
        <button class="btn sm ${ses.cover.id === p.id ? 'on' : ''}" data-cover="${p.id}">${ses.cover.id === p.id ? 'Cover' : 'Make cover'}</button>
        <button class="btn sm danger ghost" data-delp="${p.id}">Delete</button>
      </figcaption></figure>`).join('')}</div>
    <form id="sesf" class="grid2">
      <label>Move session to date<input type="date" name="date" value="${date}" max="${todayYmd()}"></label>
      <label class="check"><input type="checkbox" name="day0" ${ses.day0 ? 'checked' : ''}> Day 0</label>
      <div class="row-btns span2"><button class="btn primary" type="submit">Save</button></div>
    </form>`;
  openSheet(html(), el => {
    // Full-size images may arrive after opening; refresh their src without rebuilding the sheet.
    const refresh = () => $$('.gallery img', el).forEach((img, i) => { const u = photoUrl(ses.photos[i], 'full'); if (u && img.src !== u) img.src = u; });
    const iv = setInterval(() => { if (!document.body.contains(el)) clearInterval(iv); else refresh(); }, 800);
    el.addEventListener('click', async e => {
      const c = e.target.closest('[data-cover]');
      if (c) {
        await saveMany('photos', ses.photos.map(p => Object.assign({}, p, { cover: p.id === c.dataset.cover || undefined })));
        closeSheet();
        return;
      }
      const d = e.target.closest('[data-delp]');
      if (d) {
        const p = ses.photos.find(x => x.id === d.dataset.delp);
        await closeSheet();
        if (await confirmSheet('Delete this photo?', 'It is removed from the app. The file stays in your Drive folder until you delete it there.')) await remove('photos', p.id);
      }
    });
    $('#sesf', el).onsubmit = async e => {
      e.preventDefault();
      const nd = e.target.date.value || date, d0 = e.target.day0.checked;
      await saveMany('photos', ses.photos.map(p => Object.assign({}, p, { date: nd, day0: d0 || undefined })));
      closeSheet();
    };
  });
}

function openCompare(plantId) {
  const ss = sessions(plantId);
  let a = ss.length - 1, b = 0, ia = 0, ib = 0; // oldest vs newest
  const side = (si, pi, which) => {
    const x = ss[si], p = x.photos[pi % x.photos.length];
    return `<div class="cmp-side"><select data-which="${which}">${ss.map((s, i) => `<option value="${i}" ${i === si ? 'selected' : ''}>${fmtDate(s.date, { year: true })}${s.day0 ? ' · Day 0' : ''}</option>`).join('')}</select>
      <button class="cmp-img" data-cycle="${which}"><img src="${photoUrl(p, 'full') || photoUrl(p, 'thumb')}" alt="">${x.photos.length > 1 ? `<span class="cmp-count">${(pi % x.photos.length) + 1}/${x.photos.length}</span>` : ''}</button></div>`;
  };
  const body = () => `<h2>Compare</h2><p class="muted small">${Math.abs(calDays(parseYmd(ss[a].date), parseYmd(ss[b].date)))} days apart. Tap a photo to flip through that session.</p>
    <div class="cmp">${side(a, ia, 'a')}${side(b, ib, 'b')}</div>`;
  openSheet(body(), el => {
    const redraw = () => { el.innerHTML = '<div class="grab"></div>' + body(); };
    el.addEventListener('change', e => {
      const s = e.target.closest('[data-which]');
      if (!s) return;
      if (s.dataset.which === 'a') { a = +s.value; ia = 0; } else { b = +s.value; ib = 0; }
      redraw();
    });
    el.addEventListener('click', e => {
      const c = e.target.closest('[data-cycle]');
      if (!c) return;
      if (c.dataset.cycle === 'a') ia++; else ib++;
      redraw();
    });
    const iv = setInterval(() => { if (!document.body.contains(el)) clearInterval(iv); else if ($$('img', el).some(i => !i.getAttribute('src'))) redraw(); }, 1000);
  });
  $('#sheet-root .sheet').classList.add('wide');
}

// ---------- overview ----------
function renderOverview() {
  const plants = all('plants', { withArchived: false });
  let rows = plants.map(p => {
    const s = plantState(p);
    const loc = byId('locations', p.locationId);
    const dd = e => e ? calDays(e.date, Date.now()) : null;
    return { p, loc: loc ? loc.name : '', water: dd(s.lastW), feed: dd(s.lastFeed), repot: dd(s.lastRepot), sched: byId('schedules', p.scheduleId), due: dueLabel(s.est) };
  });
  const unassigned = rows.filter(r => !r.sched).length;
  if (ui.overviewUnassigned) rows = rows.filter(r => !r.sched);
  const k = ui.overviewSort;
  rows.sort((x, y) => k === 'name' ? x.p.name.localeCompare(y.p.name) : k === 'loc' ? x.loc.localeCompare(y.loc) : (y[k] ?? -1) - (x[k] ?? -1));
  const th = (key, label) => `<th><button data-act="sort" data-k="${key}" class="${k === key ? 'on' : ''}">${label}</button></th>`;
  const cell = v => v == null ? '<td class="muted">—</td>' : `<td class="num">${v}d</td>`;
  app.innerHTML = `
    <header class="top sub"><a class="icon-btn" href="#/" aria-label="Back">${icon('back')}</a><h1>Overview</h1><div class="top-actions">${syncChip()}</div></header>
    <div class="ov-stats"><div><b>${plants.length}</b><span>plants</span></div><div><b>${rows.filter(r => r.due && r.due.state !== 'later').length}</b><span>due by estimate</span></div><div><b>${unassigned}</b><span>no rotation</span></div></div>
    ${unassigned ? `<label class="check pad"><input type="checkbox" data-act="unassigned" ${ui.overviewUnassigned ? 'checked' : ''}> Show only plants without a rotation</label>` : ''}
    <div class="table-wrap"><table class="ov"><thead><tr>${th('name', 'Plant')}${th('water', 'Water')}${th('feed', 'Feed')}${th('repot', 'Repot')}</tr></thead>
    <tbody>${rows.map(r => `<tr><td><a href="#/plant/${r.p.id}">${esc(r.p.name)}<span class="ov-loc">${esc(r.loc)}${r.sched ? '' : ' · no rotation'}</span></a></td>${cell(r.water)}${cell(r.feed)}${cell(r.repot)}</tr>`).join('')}</tbody></table></div>
    <p class="muted small pad">Days since each. Tap a column to sort; <button class="link" data-act="sort" data-k="loc">sort by location</button>.</p>`;
}

// ---------- settings ----------
function renderSettings() {
  const locs = all('locations').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const feeds = all('feeds').sort((a, b) => a.name.localeCompare(b.name));
  const scheds = all('schedules').sort((a, b) => a.name.localeCompare(b.name));
  const trips = all('trips').sort((a, b) => b.start.localeCompare(a.start));
  const plants = all('plants');
  const st = S.settings;
  app.innerHTML = `
    <header class="top sub"><a class="icon-btn" href="#/" aria-label="Back">${icon('back')}</a><h1>Settings</h1><div class="top-actions">${syncChip()}</div></header>

    <section class="card"><h3>Google Drive connection</h3>
      ${status.state === 'error' ? `<p class="err-text small">${esc(status.error)}</p>` : ''}
      <form id="conn">
        <label>Apps Script web app URL<input name="scriptUrl" value="${esc(st.scriptUrl || '')}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off"></label>
        <label>App key<input name="key" value="${esc(st.key || '')}" autocomplete="off"></label>
        <div class="row-btns left"><button class="btn primary" type="submit">Save & test</button><button class="btn" type="button" data-act="sync-now">Sync now</button></div>
      </form>
      <p class="muted small">${st.lastSync ? `Last synced ${fmtDate(st.lastSync)} ${new Date(st.lastSync).toTimeString().slice(0, 5)}` : 'Never synced'} · ${pendingCount()} change(s) waiting
        ${st.sheetUrl ? ` · <a href="${esc(st.sheetUrl)}" target="_blank" rel="noopener">Data sheet</a>` : ''}${st.folderUrl ? ` · <a href="${esc(st.folderUrl)}" target="_blank" rel="noopener">Drive folder</a>` : ''}</p>
    </section>

    <section class="card"><div class="card-head"><h3>Locations <span class="muted small">in watering order</span></h3><button class="btn sm" data-act="add-location">Add</button></div>
      ${locs.length ? `<ul class="olist">${locs.map((l, i) => `<li><span class="grow">${esc(l.name)} <span class="muted small">${plants.filter(p => p.locationId === l.id && !p.archived).length}</span></span>
        <button class="icon-btn sm" data-act="loc-up" data-id="${l.id}" ${i ? '' : 'disabled'} aria-label="Move up">${icon('up')}</button>
        <button class="icon-btn sm" data-act="loc-down" data-id="${l.id}" ${i < locs.length - 1 ? '' : 'disabled'} aria-label="Move down">${icon('down')}</button>
        <button class="btn sm" data-act="loc-edit" data-id="${l.id}">Edit</button></li>`).join('')}</ul>` : '<p class="muted small">None yet.</p>'}
    </section>

    <section class="card"><div class="card-head"><h3>Feeds</h3><button class="btn sm" data-act="feed-edit">Add</button></div>
      ${feeds.length ? `<ul class="olist">${feeds.map(f => `<li><span class="grow">${esc(f.name)}${f.short && f.short !== f.name ? ` <span class="muted small">“${esc(f.short)}”</span>` : ''} <span class="muted small">${esc(f.kind || '')}</span></span><button class="btn sm" data-act="feed-edit" data-id="${f.id}">Edit</button></li>`).join('')}</ul>`
        : `<p class="muted small">No feeds yet.</p><button class="btn" data-act="seed">Add 19:19:19, Seaweed, Fruiting NPK + three starter rotations</button>`}
    </section>

    <section class="card"><div class="card-head"><h3>Rotations</h3><button class="btn sm" data-act="sched-edit" ${feeds.length ? '' : 'disabled'}>Add</button></div>
      ${scheds.length ? `<ul class="olist">${scheds.map(s => `<li><span class="grow">${esc(s.name)}<br><span class="muted small">${esc(scheduleSummary(s))} · ${plants.filter(p => p.scheduleId === s.id && !p.archived).length} plants</span></span><button class="btn sm" data-act="sched-edit" data-id="${s.id}">Edit</button></li>`).join('')}</ul>` : '<p class="muted small">None yet.</p>'}
    </section>

    <section class="card"><div class="card-head"><h3>Trips</h3><button class="btn sm" data-act="trip-edit">Add</button></div>
      <p class="muted small">Waterings during a trip, or a day either side, are flagged and left out of the estimate.</p>
      ${trips.length ? `<ul class="olist">${trips.map(t => `<li><span class="grow">${fmtDate(t.start, { year: true })} – ${t.end ? fmtDate(t.end, { year: true }) : 'ongoing'}${t.note ? ` <span class="muted small">${esc(t.note)}</span>` : ''}</span><button class="btn sm" data-act="trip-edit" data-id="${t.id}">Edit</button></li>`).join('')}</ul>` : ''}
    </section>

    <section class="card"><h3>Photos</h3>
      <label>Stored size (long edge)<select data-act="maxedge">${[[1600, '1600 px · ~300 KB'], [1200, '1200 px · ~180 KB'], [2048, '2048 px · ~500 KB']].map(([v, l]) => `<option value="${v}" ${+st.maxEdge === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </section>

    <section class="card"><h3>Backup</h3>
      <p class="muted small">Your data already lives in the Google Sheet. These are extra offline copies.</p>
      <div class="row-btns left wrap"><button class="btn" data-act="export-json">Export everything (JSON)</button><button class="btn" data-act="export-csv">Export log (CSV)</button></div>
    </section>
    <p class="muted small pad center">Plant Log v1</p>`;

  $('#conn').onsubmit = async e => {
    e.preventDefault();
    const d = formData(e.target);
    try {
      toast('Testing…');
      const r = await call('ping', {}, { url: d.scriptUrl, key: d.key });
      await saveSettings({ scriptUrl: d.scriptUrl, key: d.key, sheetUrl: r.sheetUrl, folderUrl: r.folderUrl });
      toast('Connected');
      sync();
    } catch (err) {
      toast(err.message || 'Could not connect');
    }
  };
}

function openLocationForm(id) {
  const l = byId('locations', id) || {};
  const plants = all('plants').filter(p => p.locationId === id && !p.archived).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  openSheet(`<h2>${id ? 'Location' : 'New location'}</h2>
    <form id="lf"><label>Name<input name="name" required value="${esc(l.name || '')}" placeholder="e.g. Kitchen utility"></label>
    ${plants.length ? `<p class="lbl">Plant order (watering sequence)</p><ul class="olist" id="porder">${plants.map((p, i) => `<li data-id="${p.id}"><span class="grow">${esc(p.name)}</span>
      <button type="button" class="icon-btn sm" data-mv="-1" aria-label="Up">${icon('up')}</button><button type="button" class="icon-btn sm" data-mv="1" aria-label="Down">${icon('down')}</button></li>`).join('')}</ul>` : ''}
    <div class="row-btns">${id ? `<button type="button" class="btn danger ghost" data-del>Delete</button>` : ''}<button class="btn primary" type="submit">Save</button></div></form>`, el => {
    const ul = $('#porder', el);
    if (ul) ul.addEventListener('click', e => {
      const b = e.target.closest('[data-mv]');
      if (!b) return;
      const li = b.closest('li');
      if (b.dataset.mv === '-1' && li.previousElementSibling) ul.insertBefore(li, li.previousElementSibling);
      if (b.dataset.mv === '1' && li.nextElementSibling) ul.insertBefore(li.nextElementSibling, li);
    });
    const del = $('[data-del]', el);
    if (del) del.onclick = async () => {
      if (plants.length) { toast('Move its plants to another location first'); return; }
      await remove('locations', id); closeSheet();
    };
    $('#lf', el).onsubmit = async e => {
      e.preventDefault();
      await save('locations', Object.assign({}, l, { name: e.target.name.value.trim(), order: l.order ?? all('locations').length }));
      if (ul) {
        const ids = $$('li', ul).map(li => li.dataset.id);
        const changed = ids.map((pid, i) => [byId('plants', pid), i]).filter(([p, i]) => p.order !== i).map(([p, i]) => Object.assign({}, p, { order: i }));
        if (changed.length) await saveMany('plants', changed);
      }
      closeSheet();
    };
  });
}

async function moveLocation(id, dir) {
  const locs = all('locations').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const i = locs.findIndex(l => l.id === id), j = i + dir;
  if (j < 0 || j >= locs.length) return;
  [locs[i], locs[j]] = [locs[j], locs[i]];
  await saveMany('locations', locs.map((l, k) => Object.assign({}, l, { order: k })).filter((l, k) => byId('locations', l.id).order !== k));
}

function openFeedForm(id) {
  const f = byId('feeds', id) || {};
  openSheet(`<h2>${id ? 'Edit feed' : 'New feed'}</h2>
    <form id="ff"><label>Name<input name="name" required value="${esc(f.name || '')}" placeholder="e.g. Cal-Mag"></label>
      <label>Short label <span class="muted small">shown on buttons</span><input name="short" value="${esc(f.short || '')}" maxlength="12" placeholder="e.g. CalMag"></label>
      <div class="grid2"><label>Type<select name="kind">${FEED_TYPES.map(t => `<option ${f.kind === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>NPK<input name="npk" value="${esc(f.npk || '')}" placeholder="19-19-19"></label></div>
      <label>Notes<textarea name="notes" rows="2" placeholder="Brand, how you mix it…">${esc(f.notes || '')}</textarea></label>
      <div class="row-btns">${id ? `<button type="button" class="btn danger ghost" data-del>Delete</button>` : ''}<button class="btn primary" type="submit">Save</button></div></form>`, el => {
    const del = $('[data-del]', el);
    if (del) del.onclick = async () => {
      if (all('schedules').some(s => (s.steps || []).some(st => st.includes(id)))) { toast('Remove it from rotations first'); return; }
      await remove('feeds', id); closeSheet();
    };
    $('#ff', el).onsubmit = async e => {
      e.preventDefault();
      const d = formData(e.target);
      await save('feeds', Object.assign({}, f, { name: d.name, short: d.short || undefined, kind: d.kind, npk: d.npk || undefined, notes: d.notes || undefined }));
      closeSheet();
    };
  });
}

function openScheduleForm(id) {
  const s = byId('schedules', id) || { name: '', steps: [[]] };
  let steps = (s.steps || []).map(st => [...st]);
  const feeds = all('feeds').sort((a, b) => a.name.localeCompare(b.name));
  const groups = plantsByLocation();
  const assigned = new Set(all('plants').filter(p => id && p.scheduleId === id).map(p => p.id));
  const stepsHtml = () => steps.map((st, i) => `<li class="step"><div class="step-head"><b>Step ${i + 1}</b> <span class="muted small">${esc(stepLabel(st))}</span>
      <span class="grow"></span><button type="button" class="icon-btn sm" data-sm="${i}:-1" aria-label="Up">${icon('up')}</button><button type="button" class="icon-btn sm" data-sm="${i}:1" aria-label="Down">${icon('down')}</button><button type="button" class="icon-btn sm" data-sx="${i}" aria-label="Remove">${icon('x')}</button></div>
      <div class="chips">${feeds.map(f => `<button type="button" class="chip ${st.includes(f.id) ? 'on' : ''}" data-sf="${i}:${f.id}">${esc(f.short || f.name)}</button>`).join('')}</div></li>`).join('');
  openSheet(`<h2>${id ? 'Edit rotation' : 'New rotation'}</h2>
    <form id="sf"><label>Name<input name="name" required value="${esc(s.name)}" placeholder="e.g. Foliage A"></label>
      <p class="lbl">Steps <span class="muted small">— no feed selected = plain water. Pick two for a combined watering.</span></p>
      <ol class="steps" id="steps">${stepsHtml()}</ol>
      <button type="button" class="btn sm" data-add-step>+ Add step</button>
      <p class="lbl">Plants on this rotation</p>
      <div class="assign">${groups.map(g => g.plants.length ? `<p class="muted small">${esc(g.loc.name)}</p>${g.plants.map(p => {
        const other = p.scheduleId && p.scheduleId !== id ? byId('schedules', p.scheduleId) : null;
        return `<label class="check"><input type="checkbox" name="pl" value="${p.id}" ${assigned.has(p.id) ? 'checked' : ''}> ${esc(p.name)}${other ? ` <span class="muted small">(now: ${esc(other.name)})</span>` : ''}</label>`;
      }).join('')}` : '').join('')}</div>
      <div class="row-btns">${id ? `<button type="button" class="btn danger ghost" data-del>Delete</button>` : ''}<button class="btn primary" type="submit">Save</button></div></form>`, el => {
    const ol = $('#steps', el);
    const redraw = () => { ol.innerHTML = stepsHtml(); };
    el.addEventListener('click', e => {
      const t = e.target.closest('[data-sf],[data-sm],[data-sx],[data-add-step]');
      if (!t) return;
      if (t.dataset.sf) { const [i, fid] = t.dataset.sf.split(':'); const st = steps[+i]; st.includes(fid) ? st.splice(st.indexOf(fid), 1) : st.push(fid); }
      if (t.dataset.sm) { const [i, d] = t.dataset.sm.split(':').map(Number); const j = i + d; if (j >= 0 && j < steps.length) [steps[i], steps[j]] = [steps[j], steps[i]]; }
      if (t.dataset.sx) { steps.splice(+t.dataset.sx, 1); }
      if (t.hasAttribute('data-add-step')) steps.push([]);
      redraw();
    });
    const del = $('[data-del]', el);
    if (del) del.onclick = async () => {
      await closeSheet();
      if (!await confirmSheet('Delete this rotation?', 'Plants on it become unassigned. Their logs are kept.')) return;
      await saveMany('plants', all('plants').filter(p => p.scheduleId === id).map(p => Object.assign({}, p, { scheduleId: undefined })));
      await remove('schedules', id);
    };
    $('#sf', el).onsubmit = async e => {
      e.preventDefault();
      if (!steps.length) { toast('Add at least one step'); return; }
      const saved = await save('schedules', Object.assign({}, s, { name: e.target.name.value.trim(), steps }));
      const chosen = new Set($$('input[name=pl]:checked', el).map(i => i.value));
      const changes = all('plants').filter(p => chosen.has(p.id) !== (p.scheduleId === saved.id))
        .map(p => Object.assign({}, p, { scheduleId: chosen.has(p.id) ? saved.id : undefined }));
      if (changes.length) await saveMany('plants', changes);
      closeSheet();
    };
  });
}

function openTripForm(id) {
  const t = byId('trips', id) || { start: todayYmd() };
  openSheet(`<h2>${id ? 'Edit trip' : 'New trip'}</h2>
    <form id="tf"><div class="grid2"><label>Left on<input type="date" name="start" required value="${t.start}"></label>
      <label>Back on<input type="date" name="end" value="${t.end || ''}"></label></div>
      <p class="muted small">Leave "Back on" empty while you're still away.</p>
      <label>Note<input name="note" value="${esc(t.note || '')}" placeholder="Optional"></label>
      <div class="row-btns">${id ? `<button type="button" class="btn danger ghost" data-del>Delete</button>` : ''}<button class="btn primary" type="submit">Save</button></div></form>`, el => {
    const del = $('[data-del]', el);
    if (del) del.onclick = async () => { await remove('trips', id); closeSheet(); };
    $('#tf', el).onsubmit = async e => {
      e.preventDefault();
      const d = formData(e.target);
      if (d.end && d.end < d.start) { toast('Return date is before departure'); return; }
      await save('trips', Object.assign({}, t, { start: d.start, end: d.end || undefined, note: d.note || undefined }));
      closeSheet();
    };
  });
}

async function seedFeeds() {
  const [npk, sea, fruit] = await saveMany('feeds', [
    { name: 'NPK 19:19:19', short: '19:19:19', kind: 'NPK', npk: '19-19-19' },
    { name: 'Seaweed extract', short: 'Seaweed', kind: 'Seaweed' },
    { name: 'Fruiting NPK', short: 'Fruiting', kind: 'Fruiting NPK' },
  ]);
  await saveMany('schedules', [
    { name: 'Foliage A (with seaweed)', steps: [[npk.id], [sea.id], [npk.id], []] },
    { name: 'Foliage B (NPK only)', steps: [[npk.id], []] },
    { name: 'Fruiting', steps: [[npk.id], [fruit.id], [npk.id], []] },
  ]);
  toast('Added. Edit the Fruiting NPK to set its ratio.');
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function exportCsv() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['date', 'plant', 'location', 'type', 'what', 'helper', 'trip', 'note']];
  all('events').sort((a, b) => a.date.localeCompare(b.date)).forEach(e => {
    const p = byId('plants', e.plantId) || {};
    const l = byId('locations', p.locationId) || {};
    rows.push([ymd(e.date), p.name, l.name, e.type, e.type === 'water' ? stepLabel(e.feeds) : eventSummary(e), e.byHelper ? 'yes' : '', nearTrip(Date.parse(e.date)) ? 'yes' : '', e.note]);
  });
  download(`plant-log-${todayYmd()}.csv`, rows.map(r => r.map(q).join(',')).join('\n'), 'text/csv');
}

// ---------- events ----------
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const id = t.dataset.id;
  switch (t.dataset.act) {
    case 'quick-log': await quickLog(id); break;
    case 'log-sheet': openLogSheet(id); break;
    case 'edit-event': { const ev = byId('events', id); openLogSheet(ev.plantId, ev); break; }
    case 'toggle-loc': ui.collapsed[id] = !ui.collapsed[id]; localStorage.setItem('collapsed', JSON.stringify(ui.collapsed)); render(); break;
    case 'add-plant': openPlantForm(); break;
    case 'edit-plant': openPlantForm(byId('plants', id)); break;
    case 'set-step': openStepPicker(id); break;
    case 'add-photos': pickPhotos(id); break;
    case 'session': openSession(id, t.dataset.date); break;
    case 'compare': openCompare(id); break;
    case 'copy-summary': copySummary(id); break;
    case 'archive': { const p = byId('plants', id); await save('plants', Object.assign({}, p, { archived: !p.archived || undefined })); toast(p.archived ? 'Unarchived' : 'Archived — hidden from the list, history kept'); break; }
    case 'delete-plant': {
      const p = byId('plants', id);
      if (await confirmSheet(`Delete ${p.name}?`, 'Removes the plant and hides its log. Archive instead if it died or was given away — that keeps the history visible.')) {
        await remove('plants', id); location.hash = '#/';
      }
      break;
    }
    case 'range': ui.chartRange = t.dataset.r; localStorage.setItem('chartRange', ui.chartRange); render(); break;
    case 'sort': ui.overviewSort = t.dataset.k; render(); break;
    case 'sync-chip': if (status.state === 'local') location.hash = '#/settings'; else if (status.state === 'error') toast(status.error); else sync(); break;
    case 'sync-now': sync(); break;
    case 'add-location': openLocationForm(); break;
    case 'loc-edit': openLocationForm(id); break;
    case 'loc-up': moveLocation(id, -1); break;
    case 'loc-down': moveLocation(id, 1); break;
    case 'feed-edit': openFeedForm(id); break;
    case 'sched-edit': openScheduleForm(id); break;
    case 'trip-edit': openTripForm(id); break;
    case 'seed': seedFeeds(); break;
    case 'start-trip': openTripForm(); break;
    case 'end-trip': { const tr = byId('trips', id); await save('trips', Object.assign({}, tr, { end: todayYmd() })); toast('Welcome back'); break; }
    case 'export-json': download(`plant-log-${todayYmd()}.json`, JSON.stringify(exportAll(), null, 1), 'application/json'); break;
    case 'export-csv': exportCsv(); break;
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'file') handleFiles([...t.files]);
  if (t.dataset.act === 'unassigned') { ui.overviewUnassigned = t.checked; render(); }
  if (t.dataset.act === 'maxedge') saveSettings({ maxEdge: +t.value });
});
document.addEventListener('input', e => {
  if (e.target.id === 'search') { ui.search = e.target.value; render(); }
});

// Long-press a log button to open the full log sheet.
let pressTimer = null;
document.addEventListener('pointerdown', e => {
  const b = e.target.closest('[data-act="quick-log"]');
  if (!b) return;
  pressTimer = setTimeout(() => { pressTimer = 'fired'; openLogSheet(b.dataset.id); }, 550);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => document.addEventListener(ev, () => { if (pressTimer !== 'fired') clearTimeout(pressTimer); }, true));
document.addEventListener('click', e => {
  if (pressTimer === 'fired') { pressTimer = null; e.stopImmediatePropagation(); e.preventDefault(); }
}, true);

// ---------- boot ----------
(async () => {
  await load();
  onChange(render);
  window.addEventListener('hashchange', render);
  render();
  startSync();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
})();
