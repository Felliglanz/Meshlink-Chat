/* MeshLink Chat – Einstieg: Login, Verbindung zum Server, Start. */

// Alle Module laden (Reihenfolge wie früher in app.js)
import './core/i18n.js';
import './core/util.js';
import './core/state.js';
import './core/api.js';
import './core/icons.js';
import './ui.js';
import './data.js';
import './scope.js';
import './prefs.js';
import './chat/meta.js';
import './nav.js';
import './views/list.js';
import './chat/view.js';
import './chat/composer.js';
import './chat/actions.js';
import './views/contacts.js';
import './views/rooms.js';
import './views/search.js';
import './views/stats.js';
import './views/repeaters.js';
import './map/map.js';
import './map/packets.js';
import './map/live.js';
import './map/trace.js';
import './views/node.js';
import './views/admin.js';
import './push.js';
import './drawer.js';

import { T } from './core/i18n.js';
import { $, esc } from './core/util.js';
import { S } from './core/state.js';
import { api } from './core/api.js';
import { closeSheet } from './ui.js';
import { applyMeta, conversations, ingest, markRead, mergeRead, readHistoryIfFresh, shareRead } from './data.js';
import { loadScopes } from './scope.js';
import { go, render, scheduleRender } from './nav.js';
import { ensurePush, sendPresence } from './push.js';
import { resetData } from './drawer.js';

// ------------------------------------------------------------------ Login & Start

export function showLogin() {
  S.es?.close(); S.es = null; S.booted = false;
  S.view = 'login';
  closeSheet();
  $('#side').innerHTML = '';
  $('#app').innerHTML = `
    <div class="view view-login">
      <form class="login" id="login">
        <img src="/icons/icon.svg" alt="" class="login-logo">
        <h1>MeshLink Chat</h1>
        <p class="muted">${T('login.prompt')}</p>
        <input type="password" id="pw" placeholder="${esc(T('login.pw'))}" autocomplete="current-password" required>
        <button class="sheet-btn primary" type="submit">${T('login.submit')}</button>
        <div class="login-err" id="login-err"></div>
      </form>
    </div>`;
  $('#login').onsubmit = async (e) => {
    e.preventDefault();
    $('#login-err').textContent = '';
    try {
      await api('/api/login', { method: 'POST', body: { password: $('#pw').value } });
      boot();
    } catch (err) { $('#login-err').textContent = err.message; }
  };
  setTimeout(() => $('#pw')?.focus(), 50);
}

// Start ohne Verbindung zum MeshLink-Chat-Server (z. B. Funkloch): Hinweis statt leerer Seite, automatisch neu versuchen
let offlineTimer = null;
function showOffline(e) {
  S.view = 'offline';
  $('#side').innerHTML = '';
  $('#app').innerHTML = `
    <div class="view view-login">
      <div class="login">
        <img src="/icons/icon.svg" alt="" class="login-logo">
        <h1>MeshLink Chat</h1>
        <p class="muted">${T('offline.text')}</p>
        <button class="sheet-btn primary" id="retry">${T('offline.retry')}</button>
        <div class="login-err">${esc(e?.message || '')}</div>
      </div>
    </div>`;
  $('#retry').onclick = () => boot();
  clearTimeout(offlineTimer);
  offlineTimer = setTimeout(() => { if (S.view === 'offline') boot(); }, 5000);
}

export async function resync() {
  const j = await api('/api/bootstrap');
  applyMeta(j);
  loadScopes();
  S.connected = j.connected; S.error = j.error;
  ingest(j.messages, true);
  mergeRead(j.read);
  // Eigenen Stand melden: nach einem Neustart weiß der Server nichts mehr, und wer hier schon weiter gelesen
  // hat, bringt die anderen Geräte so wieder auf Stand (der Server übernimmt je Chat den neueren Zeitpunkt).
  const mine = {};
  for (const c of [...conversations().channels, ...conversations().dms]) {
    const t = (S.lastRead || {})[c.key];
    if (t && t > ((j.read || {})[c.key] || 0)) mine[c.key] = t;
  }
  if (Object.keys(mine).length) shareRead(mine);
}

let lastAuthCheck = 0;
function connectEvents() {
  S.es?.close();
  const es = new EventSource('/api/events');
  S.es = es;
  let opened = false;
  es.onopen = () => {
    S.sse = true; scheduleRender();
    if (opened) resync().catch(() => {});
    opened = true;
  };
  es.onerror = () => {
    S.sse = false; scheduleRender();
    if (Date.now() - lastAuthCheck > 10000) {
      lastAuthCheck = Date.now();
      resync().then(() => { if (es.readyState === EventSource.CLOSED) connectEvents(); }).catch(() => {});
    }
  };
  es.addEventListener('messages', (e) => ingest(JSON.parse(e.data)));
  es.addEventListener('meta', (e) => applyMeta(JSON.parse(e.data)));
  es.addEventListener('read', (e) => mergeRead(JSON.parse(e.data)));
  es.addEventListener('reset', () => { resetData().catch(() => {}); });
  es.addEventListener('status', (e) => { const s = JSON.parse(e.data); S.connected = s.connected; S.error = s.error; scheduleRender(); });
}

async function boot() {
  try {
    await resync();
  } catch (e) {
    if (e.status !== 401) showOffline(e); // 401 → Login wird schon angezeigt
    return;
  }
  clearTimeout(offlineTimer);
  readHistoryIfFresh();
  S.booted = true;
  connectEvents();
  ensurePush();
  const hash = decodeURIComponent(location.hash.slice(1));
  const params = new URLSearchParams(location.search);
  const conv = params.get('conv') || (hash.startsWith('ch:') || hash.startsWith('dm:') ? hash : null);
  history.replaceState({ view: 'list' }, '', '/');
  S.view = 'list';
  $('#app').innerHTML = '';
  render();
  if (conv) go('chat', conv);
}

document.addEventListener('visibilitychange', () => {
  sendPresence(!document.hidden);
  if (document.hidden || !S.booted) return;
  if (!S.es || S.es.readyState === EventSource.CLOSED) connectEvents();
  resync().catch(() => {});
  if (S.view === 'chat') markRead(S.conv);
});

navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'open-conv' && e.data.conv && S.booted) go('chat', e.data.conv);
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
setInterval(() => { if (S.view === 'list' || S.view === 'chat') scheduleRender(); }, 60000);
boot();
