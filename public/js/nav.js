/* MeshLink Chat – Rendern, Leiste unten, Navigation. */

import { T } from './core/i18n.js';
import { $, esc } from './core/util.js';
import { S } from './core/state.js';
import { ICON } from './core/icons.js';
import { closeSheet } from './ui.js';
import { conversations } from './data.js';
import { renderList } from './views/list.js';
import { renderChat } from './chat/view.js';
import { renderContacts } from './views/contacts.js';
import { renderRoom, renderRooms } from './views/rooms.js';
import { renderMentionsView, renderSearch } from './views/search.js';
import { renderStats } from './views/stats.js';
import { renderRepeaters } from './views/repeaters.js';
import { leaveMap, renderMap, toggleMapFull } from './map/map.js';
import { renderPackets } from './map/packets.js';
import { renderNode } from './views/node.js';
import { renderAdmin } from './views/admin.js';
import { closeDrawer, openDrawer } from './drawer.js';

// ------------------------------------------------------------------ Rendering

let renderQueued = false;
export function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

// Breiter Bildschirm (PC/Tablet quer): links dauerhaft die Chatliste, rechts die aktuelle Ansicht
// Beim Drucken (PDF der Statistik) rechnet der Browser die Seite auf Papierbreite um – das ist kein schmaleres Fenster:
// Layout dann nicht umbauen (sonst lädt die Ansicht neu und aufs Papier kommt nur „Lade …“).
const wideMq = window.matchMedia('(min-width: 1000px)');
const printMq = window.matchMedia('print');
let printing = false;
let wide = wideMq.matches; // aufgebautes Layout; ändert sich nur bei echter Größenänderung
export const isWide = () => wide;
const inApp = () => !['boot', 'login', 'offline'].includes(S.view); // angemeldet und Daten geladen
addEventListener('beforeprint', () => { printing = true; });
addEventListener('afterprint', () => { printing = false; setTimeout(syncLayout, 0); }); // Fenster während des Drucks verändert?
wideMq.addEventListener?.('change', syncLayout);
function syncLayout() {
  if (printing || printMq.matches || wideMq.matches === wide) return;
  wide = wideMq.matches;
  if (!inApp()) return; // Login-/Offline-Seite nicht leeren
  $('#side').innerHTML = '';
  $('#app').innerHTML = '';
  delete $('#app').dataset.conv;
  const focus = S.mapFocus;
  leaveMap(); // Karte hängt am alten DOM -> neu aufbauen, gezeigten Weg behalten
  S.mapFocus = focus;
  render();
}

function renderEmptyMain() {
  const app = $('#app');
  if ($('.view-empty', app)) return;
  app.innerHTML = `<div class="view view-empty"><div class="empty-main"><img src="/icons/icon.svg" alt=""><b>MeshLink Chat</b><span>${T('main.pick')}</span></div></div>`;
}

export function render() {
  const side = $('#side');
  if (isWide() && inApp()) {
    renderList(side);
    side.querySelectorAll('[data-conv]').forEach((b) => b.classList.toggle('active', S.view === 'chat' && b.dataset.conv === S.conv));
    if (S.view === 'list') { renderEmptyMain(); return; }
  } else if (side.innerHTML) side.innerHTML = '';
  if (S.view === 'list') renderList();
  else if (S.view === 'chat') renderChat();
  else if (S.view === 'contacts') renderContacts();
  else if (S.view === 'map') renderMap();
  else if (S.view === 'node') renderNode();
  else if (S.view === 'rooms') renderRooms();
  else if (S.view === 'room') renderRoom();
  else if (S.view === 'search') renderSearch();
  else if (S.view === 'stats') renderStats();
  else if (S.view === 'repeaters') renderRepeaters();
  else if (S.view === 'packets') renderPackets();
  else if (S.view === 'mentions') renderMentionsView();
  else if (S.view === 'admin') renderAdmin();
  ensureNav();
}

export function statusLine() {
  if (!S.sse) return `<span class="dot dot-warn"></span>${T('status.connecting')}`;
  if (!S.connected) return `<span class="dot dot-bad"></span>${T('status.mmDown')}`;
  return `<span class="dot dot-ok"></span>${esc(S.source?.name || T('status.connected'))}`;
}

// Untere Leiste: Chats · Kontakte · Karte · Repeater (nur MeshCore) · Mehr (= Menü). In den Hauptansichten;
// nicht im Chat, in der Verwaltung usw. Breiter Bildschirm: unten in der linken Spalte unter der Chatliste.
const NAV_VIEWS = ['list', 'contacts', 'map', 'repeaters'];
function navHtml(active) {
  const unread = (() => { const { channels, dms } = conversations(); return channels.filter((c) => c.unread).length + dms.filter((c) => c.unread).length; })();
  const tabs = [['list', 'chat', T('nav.chats'), unread], ['contacts', 'people', T('nav.contacts')], ['map', 'map', T('nav.map')]];
  if (S.source?.protocol === 'meshcore') tabs.push(['repeaters', 'radio', T('nav.repeaters')]);
  tabs.push(['more', 'menu', T('nav.more')]);
  return tabs.map(([k, ic, label, n]) => `<button class="${active === k ? 'on' : ''}" data-nav="${k}"${active === k ? ' aria-current="page"' : ''}><span class="ic">${ICON[ic]}</span><span>${esc(label)}</span>${n ? `<span class="nav-dot">${n > 99 ? '99+' : n}</span>` : ''}</button>`).join('');
}
function ensureNav() {
  const wide = isWide() && inApp();
  const host = wide ? $('#side .view-list') : NAV_VIEWS.includes(S.view) ? $('#app > .view') : null;
  document.querySelectorAll('.bottom-nav').forEach((n) => { if (n.parentElement !== host) { n.parentElement?.classList.remove('has-nav'); n.remove(); } });
  if (!host) return;
  let nav = $(':scope > .bottom-nav', host);
  if (!nav) {
    nav = document.createElement('nav');
    nav.className = 'bottom-nav';
    nav.onclick = (e) => {
      const b = e.target.closest('[data-nav]');
      if (!b) return;
      const to = b.dataset.nav;
      if (to === 'more') { openDrawer(); return; }
      if (to === S.view && !(wide && S.view === 'chat')) return;
      go(to, null, S.view !== 'list' && S.view !== 'chat'); // Tab zu Tab ersetzt den Verlauf, „Zurück“ führt zur Chatliste
    };
    host.appendChild(nav);
    host.classList.add('has-nav');
  }
  const html = navHtml(S.view === 'chat' ? 'list' : S.view);
  if (nav.innerHTML !== html) nav.innerHTML = html;
}

// ------------------------------------------------------------------ Navigation

export function go(view, conv, replace = false) {
  leaveMap();
  S.view = view;
  S.conv = conv || null;
  S.replyTo = null;
  const st = { view, conv };
  if (view === 'list') history.replaceState(st, '', '/');
  else if (replace) history.replaceState(st, '', `/#${encodeURIComponent(conv || view)}`);
  else history.pushState(st, '', `/#${encodeURIComponent(conv || view)}`);
  delete $('#app').dataset.conv;
  $('#app').innerHTML = '';
  render();
}

window.addEventListener('popstate', (e) => {
  const st = e.state || { view: 'list' };
  // Vollbild der Karte verlassen (Zurück-Geste) – die Karte bleibt, nichts neu aufbauen
  if (S.mapFullPop) { S.mapFullPop = false; return; }
  if (S.mapFull && S.view === 'map' && st.view === 'map' && !st.mapFull) { toggleMapFull(false); return; }
  closeSheet();
  closeDrawer();
  leaveMap();
  S.view = st.view || 'list';
  S.conv = st.conv || null;
  S.replyTo = null;
  $('#app').innerHTML = '';
  render();
});
