/* MeshLink Chat – Kontakte. */

import { LOC, T } from '../core/i18n.js';
import { $, ago, esc } from '../core/util.js';
import { S } from '../core/state.js';
import { api } from '../core/api.js';
import { ICON } from '../core/icons.js';
import { avatar, closeSheet, openSheet, toast } from '../ui.js';
import { node } from '../data.js';
import { go, scheduleRender } from '../nav.js';
import { showOnMap } from '../map/map.js';
import { nodeKind } from './node.js';

// ------------------------------------------------------------------ Kontakte

export const TYPE = { 1: { label: T('type.companion'), icon: '👤' }, 2: { label: T('type.repeater'), icon: '📡' }, 3: { label: T('type.room'), icon: '🏠' }, 4: { label: T('type.sensor'), icon: '🌡️' } };
export const typeOf = (n) => TYPE[n?.type] || null;
export const canDm = (n) => !n?.type || n.type === 1; // Repeater/Rooms/Sensoren nehmen keine normalen DMs

export function renderContacts() {
  const app = $('#app');
  if (!$('.view-contacts', app)) {
    S.contactTab = S.contactTab || (([...S.nodes.values()].some((n) => n.fav)) ? 'fav' : 'all');
    app.innerHTML = `
      <div class="view view-contacts">
        <header class="bar">
          <button class="icon-btn" id="back" aria-label="${esc(T('common.back'))}">${ICON.back}</button>
          <div class="search">${ICON.search}<input id="q" type="search" placeholder="${esc(T('contacts.search'))}" autocomplete="off"></div>
        </header>
        <div class="segments" role="tablist">
          <button class="seg" data-tab="fav" role="tab">${ICON.star} ${T('contacts.favs')} <span id="cnt-fav"></span></button>
          <button class="seg" data-tab="all" role="tab">${T('contacts.all')} <span id="cnt-all"></span></button>
          <button class="seg" data-tab="rpt" role="tab">📡 ${T('contacts.rpt')} <span id="cnt-rpt"></span></button>
        </div>
        <main class="scroll" id="nodes"></main>
      </div>`;
    $('#back').onclick = () => history.back();
    $('#q').oninput = renderContactList;
    $('.segments').onclick = (e) => {
      const t = e.target.closest('[data-tab]');
      if (t) { S.contactTab = t.dataset.tab; renderContactList(); $('#nodes').scrollTop = 0; }
    };
    // Tippen = direkt zum Chat (Companions) bzw. zur Node-Seite; ⋮ = Menü mit allen Aktionen
    $('#nodes').onclick = (e) => {
      const m = e.target.closest('[data-more]');
      if (m) { e.stopPropagation(); openContact(m.dataset.more); return; }
      const it = e.target.closest('[data-node]');
      if (!it) return;
      const n = node(it.dataset.node);
      if (n && canDm(n)) go('chat', `dm:${n.id}`); else go('node', it.dataset.node);
    };
    $('#nodes').onkeydown = (e) => {
      const m = e.target.closest?.('[data-more]');
      if (m && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.stopPropagation(); openContact(m.dataset.more); }
    };
    loadContactRoutes();
  }
  renderContactList();
}

// Gespeicherte Wege der Kontakte auf dem Companion (nur MeshCore): id -> Hops (0 = direkt) oder 'flood'
S.cRoutes = {};
async function loadContactRoutes() {
  if (S.source?.protocol !== 'meshcore' || Date.now() - (S.cRoutesAt || 0) < 30000) return;
  S.cRoutesAt = Date.now();
  try {
    const r = await api('/api/contacts/routes');
    S.cRoutes = r.routes || {};
    if (S.view === 'contacts') renderContactList();
  } catch { S.cRoutesAt = 0; }
}
// Weg zu einem Kontakt als kurzer Text; null = unbekannt (kein Kontakt auf dem Gerät)
function contactRouteText(n) {
  if (S.source?.protocol === 'meshcore') {
    const r = S.cRoutes[n.id.toLowerCase()];
    if (r == null) return null;
    return r === 'flood' ? T('contacts.flood') : r === 0 ? T('common.direct') : T('common.hops', { n: r });
  }
  return n.hops != null ? T('common.hops', { n: n.hops }) : null;
}
const keyShort = (n) => (n.id.startsWith('mc:') ? n.id.slice(3, 11) : n.id);
// Avatar mit Stern-Abzeichen für Favoriten
const favAvatar = (n) => `<span class="av-wrap">${avatar('dm:' + n.id)}${n.fav ? `<i class="av-star" title="${esc(T('fav.label'))}">★</i>` : ''}</span>`;

function renderContactList() {
  const q = ($('#q')?.value || '').trim().toLowerCase();
  const all = [...S.nodes.values()].filter((n) => n.id !== S.me);
  const groups = { fav: all.filter((n) => n.fav), all, rpt: all.filter((n) => n.type === 2 || n.type === 3) };
  for (const k of Object.keys(groups)) $(`#cnt-${k}`).textContent = groups[k].length;
  document.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.contactTab));
  let list = groups[S.contactTab] || all;
  if (q) list = list.filter((n) => `${n.long} ${n.short} ${n.id}`.toLowerCase().includes(q));
  list = S.contactTab === 'fav'
    ? list.sort((a, b) => (a.long || a.short).localeCompare(b.long || b.short, LOC))
    : list.sort((a, b) => (b.lastHeard || 0) - (a.lastHeard || 0));
  const total = list.length;
  list = list.slice(0, 400);
  $('#nodes').innerHTML = list.map((n) => {
    const t = typeOf(n);
    const route = contactRouteText(n);
    const name = n.long || n.short || n.id;
    return `
    <button class="conv" data-node="${esc(n.id)}">
      ${favAvatar(n)}
      <div class="conv-body">
        <div class="conv-top"><span class="conv-title">${esc(name)}</span><span class="conv-time">${esc(ago(n.lastHeard))}</span></div>
        <div class="conv-bottom"><span class="conv-preview muted">${t ? `${t.icon} ${t.label} · ` : ''}${route ? `<span class="c-route">↪ ${esc(route)}</span> · ` : ''}<code class="c-key">${esc(keyShort(n))}</code></span></div>
      </div>
      <span class="row-more" role="button" tabindex="0" data-more="${esc(n.id)}" aria-label="${esc(T('contacts.moreFor', { name }))}">${ICON.more}</span>
    </button>`;
  }).join('') + (total > list.length ? `<div class="empty">${T('contacts.more', { n: total - list.length })}</div>` : '')
    || `<div class="empty">${S.contactTab === 'fav' ? T('contacts.noFavs') : T('contacts.none')}</div>`;
}

// Favorit umschalten: sofort anzeigen, bei Fehler zurücknehmen. Gilt in MeshMonitor und auf dem Companion.
export async function toggleFav(id) {
  const n = node(id);
  if (!n) return;
  const fav = !n.fav;
  n.fav = fav;
  scheduleRender();
  try {
    await api('/api/node/favorite', { method: 'POST', body: { id, fav } });
    toast(T(fav ? 'fav.added' : 'fav.removed', { name: n.long || n.short || 'Node' }));
  } catch (e) {
    n.fav = !fav;
    scheduleRender();
    toast(e.status === 403 ? T('fav.noPerm') : T('fav.failed', { msg: e.message }));
  }
}

function openContact(id) {
  const n = node(id);
  if (!n) return;
  const t = typeOf(n);
  const row = (k, v) => (v == null || v === '' ? '' : `<div class="info-row"><span>${k}</span><b>${esc(v)}</b></div>`);
  const mc = S.source?.protocol === 'meshcore';
  const route = contactRouteText(n);
  const name = n.long || n.short || 'Node';
  openSheet(`
    <div class="contact-head">${favAvatar(n)}<div><b>${esc(n.long || n.short || n.id)}</b><div class="muted">${t ? `${t.icon} ${t.label}` : 'Node'}${n.fav ? ` · ★ ${T('fav.label')}` : ''}</div></div></div>
    <div class="info">
      ${row(T('node.lastHeard'), n.lastHeard ? `${ago(n.lastHeard)} (${new Date(n.lastHeard).toLocaleString(LOC)})` : null)}
      ${mc ? row(T('contact.route'), route) : row('Hops', n.hops)}
      ${row('SNR', n.snr)}
      ${mc && n.id.startsWith('mc:') ? row(T('contact.key'), `${n.id.slice(3, 11)}…${n.id.slice(-8)}`) : row('ID', n.id.length > 24 ? `${n.id.slice(0, 19)}…` : n.id)}
    </div>
    ${canDm(n) ? `<button class="sheet-btn primary" data-act="dm">${T('contact.send')}</button>` : ''}
    <button class="sheet-btn" data-act="details">${nodeKind(n) ? T('contact.detailsStatus') : T('contact.details')}</button>
    ${mc ? `<button class="sheet-btn" data-act="fav">${n.fav ? T('contact.unfav') : T('contact.fav')}</button>` : ''}
    <button class="sheet-btn" data-act="map">${T('contact.map')}</button>
    ${mc && n.id.startsWith('mc:') ? `<button class="sheet-btn" data-act="key">${T('contact.copyKey')}</button>` : ''}
    <button class="sheet-btn cancel" data-close>${T('common.close')}</button>`, (e) => {
    if (e.target.closest('[data-act="fav"]')) { closeSheet(); toggleFav(n.id); }
    if (e.target.closest('[data-act="dm"]')) { closeSheet(); go('chat', `dm:${n.id}`); }
    if (e.target.closest('[data-act="details"]')) { closeSheet(); go('node', n.id); }
    if (e.target.closest('[data-act="map"]')) { closeSheet(); showOnMap({ title: name, numberFrom: 1, points: [{ id: n.id, label: name, tag: '★' }] }); }
    if (e.target.closest('[data-act="key"]')) {
      closeSheet();
      navigator.clipboard?.writeText(n.id.slice(3)).then(() => toast(T('contact.keyCopied')), () => toast(T('common.copyFailed')));
    }
  });
}
