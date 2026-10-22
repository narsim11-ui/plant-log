// Small UI helpers: escaping, bottom sheets, toasts.

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- bottom sheet ----------
// A sheet owns one history entry so Android's back button closes it instead of leaving the page.
let sheetOpen = null;
let hasEntry = false;
let settle = null;

export function openSheet(html, mount) {
  closeSheet(true);
  const root = $('#sheet-root');
  root.innerHTML = `<div class="scrim" data-close></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
  root.hidden = false;
  requestAnimationFrame(() => root.classList.add('open'));
  const el = $('.sheet', root);
  sheetOpen = { el };
  if (!hasEntry) { history.pushState({ sheet: 1 }, ''); hasEntry = true; }
  root.onclick = e => { if (e.target.closest('[data-close]')) closeSheet(); };
  if (mount) mount(el);
  return el;
}

// Resolves once the sheet's history entry is gone, so callers can navigate safely afterwards.
export function closeSheet(silent) {
  const root = $('#sheet-root');
  if (sheetOpen) {
    sheetOpen = null;
    root.classList.remove('open');
    root.innerHTML = '';
    root.hidden = true;
  }
  if (silent) return Promise.resolve();
  return new Promise(res => setTimeout(() => {
    if (!sheetOpen && hasEntry) { hasEntry = false; settle = res; history.back(); }
    else res();
  }, 0));
}

window.addEventListener('popstate', () => {
  if (settle) { const r = settle; settle = null; r(); return; }
  if (hasEntry) { hasEntry = false; if (sheetOpen) closeSheet(true); }
});
export const isSheetOpen = () => !!sheetOpen;

// ---------- toast ----------
let toastTimer;
export function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="toast-btn">${esc(action.label)}</button>` : ''}`;
  t.hidden = false;
  t.classList.add('show');
  if (action) $('.toast-btn', t).onclick = () => { action.fn(); hideToast(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 6000 : 2500);
}
function hideToast() {
  const t = $('#toast');
  t.classList.remove('show');
  setTimeout(() => { if (!t.classList.contains('show')) t.hidden = true; }, 250);
}

export function confirmSheet(title, body, okLabel = 'Delete') {
  return new Promise(res => {
    let done = false;
    openSheet(`<h2>${esc(title)}</h2><p class="muted">${esc(body)}</p>
      <div class="row-btns"><button class="btn" data-no>Cancel</button><button class="btn danger" data-yes>${esc(okLabel)}</button></div>`, el => {
      $('[data-no]', el).onclick = () => { done = true; closeSheet().then(() => res(false)); };
      $('[data-yes]', el).onclick = () => { done = true; closeSheet().then(() => res(true)); };
    });
    const obs = new MutationObserver(() => { if (!sheetOpen && !done) { obs.disconnect(); res(false); } });
    obs.observe($('#sheet-root'), { childList: true });
  });
}

export function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.type === 'number') o[el.name] = el.value === '' ? null : Number(el.value);
    else o[el.name] = el.value.trim();
  }
  return o;
}

export const icon = name => `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
