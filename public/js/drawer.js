/* MeshLink Chat – Menü (☰). */

import { I18N, LANG, ownLanguage, setLanguage, T } from './core/i18n.js';
import { $, esc } from './core/util.js';
import { load, S, save } from './core/state.js';
import { api } from './core/api.js';
import { ICON } from './core/icons.js';
import { setTheme, themePref } from './core/theme.js';
import { closeSheet, openSheet, toast } from './ui.js';
import { conversations, myName, readHistoryIfFresh, saveRead, shareRead } from './data.js';
import { go, render, scheduleRender } from './nav.js';
import { openOwnNodes } from './chat/actions.js';
import { unreadMentions } from './views/search.js';
import { openAdvert, openWatch } from './views/repeaters.js';
import { disablePush, dropPushSubscription, enablePush } from './push.js';
import { resync, showLogin } from './main.js';

// ------------------------------------------------------------------ Menü (Hamburger)

// Aufklappbare Menügruppe; der Zustand wird auf dem Gerät gemerkt, die Gruppe der offenen Seite ist immer offen
S.drawerOpen = load('drawerOpen', { tools: true });
function drawerGroup(key, title, force, html, hint) {
  if (!html.trim()) return '';
  const open = force || Boolean(S.drawerOpen[key]);
  return `<button class="drawer-section drawer-toggle" data-group="${key}" aria-expanded="${open}"><span>${esc(title)}${hint ? ` <small>${esc(hint)}</small>` : ''}</span>${ICON.chevron}</button>
    <div class="drawer-group ${open ? '' : 'collapsed'}">${html}</div>`;
}
// Projektseite: nur ein Link, den der Browser auf Antippen öffnet – die App selbst ruft GitHub nie ab
const REPO_URL = 'https://github.com/Felliglanz/Meshlink-Chat';
export function openDrawer() {
  const root = $('#drawer-root');
  const notifOn = S.notify && 'Notification' in window && Notification.permission === 'granted';
  const sources = S.sources || [];
  const mc = S.source?.protocol === 'meshcore';
  // Was die Leiste unten schon hat (Chats, Kontakte, Karte, Repeater), steht nicht noch einmal im Menü
  const nav = Boolean(document.querySelector('.bottom-nav'));
  const theme = themePref();
  const themeBtn = (k, icon) => `<button role="radio" aria-checked="${theme === k}" data-theme-set="${k}">${ICON[icon]}<span>${T(`theme.${k}`)}</span></button>`;
  root.innerHTML = `
    <div class="backdrop" data-close></div>
    <nav class="drawer" aria-label="${esc(T('drawer.aria'))}">
      <div class="drawer-head">
        <img src="/icons/icon.svg" alt="" class="drawer-logo">
        <div><b>MeshLink Chat</b><div class="muted">${esc(myName() || T('drawer.noNode'))}</div></div>
      </div>
      <div class="drawer-section">${T('drawer.secChat')}</div>
      ${nav ? '' : `<button class="drawer-item ${S.view === 'list' ? 'active' : ''}" data-act="chats">${ICON.chat}<span>${T('drawer.chats')}</span></button>
      <button class="drawer-item ${S.view === 'contacts' ? 'active' : ''}" data-act="contacts">${ICON.people}<span>${T('list.contacts')}</span></button>`}
      <button class="drawer-item ${S.view === 'mentions' ? 'active' : ''}" data-act="mentions"><span class="drawer-at">@</span><span>${T('men.title')}${unreadMentions() ? ` <small class="badge">${unreadMentions()}</small>` : ''}</span></button>
      ${mc ? `<button class="drawer-item ${S.view === 'rooms' ? 'active' : ''}" data-act="rooms">${ICON.home}<span>${T('rooms.title')}</span></button>` : ''}
      <button class="drawer-item ${S.view === 'search' ? 'active' : ''}" data-act="search">${ICON.search}<span>${T('drawer.search')}</span></button>
      <div class="drawer-section">${T('drawer.secNet')}</div>
      ${nav ? '' : `<button class="drawer-item ${S.view === 'map' ? 'active' : ''}" data-act="map">${ICON.map}<span>${T('map.title')}</span></button>`}
      ${mc && !nav ? `<button class="drawer-item ${S.view === 'repeaters' ? 'active' : ''}" data-act="repeaters">${ICON.radio}<span>${T('drawer.repeaters')}</span></button>` : ''}
      <button class="drawer-item ${S.view === 'stats' ? 'active' : ''}" data-act="stats">${ICON.chart}<span>${T('stats.title')}</span></button>
      ${drawerGroup('tools', T('drawer.tools'), S.view === 'packets', `
      ${mc ? `<button class="drawer-item ${S.view === 'packets' ? 'active' : ''}" data-act="packets">${ICON.pulse}<span>${T('drawer.packets')}</span></button>` : ''}
      ${mc ? `<button class="drawer-item" data-act="advert">${ICON.megaphone}<span>${T('advert.title')}</span></button>` : ''}
      <button class="drawer-item" data-act="readall">${ICON.check}<span>${T('drawer.readAll')}</span></button>`)}
      ${sources.length > 1 ? drawerGroup('source', T('drawer.source'), false, sources.map((src) => `<button class="drawer-item ${src.id === S.source?.id ? 'active' : ''}" data-source="${esc(src.id)}">${ICON.radio}<span>${esc(src.name)}${src.primary ? ` <small>${T('drawer.primary')}</small>` : ''}</span>${src.id === S.source?.id ? `<i class="drawer-check">${ICON.check}</i>` : ''}</button>`).join(''), S.source?.name) : ''}
      ${drawerGroup('settings', T('drawer.settings'), false, `
      <button class="drawer-item" data-act="notify">${ICON.bell}<span>${T('drawer.push', { state: notifOn ? T('common.on') : T('common.off') })}</span></button>
      ${notifOn ? `<button class="drawer-item" data-act="pushtest">${ICON.check}<span>${T('drawer.pushTest')}</span></button>` : ''}
      ${mc ? `<button class="drawer-item" data-act="watch">${ICON.radio}<span>${T('drawer.watch', { state: S.watch.on ? T('common.on') : T('common.off') })}</span></button>` : ''}
      <button class="drawer-item" data-act="own">${ICON.user}<span>${T('own.title')}</span></button>
      <button class="drawer-item" data-act="lang">${ICON.globe}<span>${T('drawer.language', { name: esc(langName(LANG)) })}</span></button>`)}
      <div class="drawer-spacer"></div>
      <div class="theme-switch" role="radiogroup" aria-label="${esc(T('theme.aria'))}">${themeBtn('system', 'auto')}${themeBtn('light', 'sun')}${themeBtn('dark', 'moon')}</div>
      <button class="drawer-item" data-act="reload">${ICON.refresh}<span>${T('drawer.reload')}</span></button>
      <a class="drawer-version" href="${REPO_URL}" target="_blank" rel="noopener noreferrer" title="${esc(T('drawer.repo'))}">MeshLink Chat ${esc(S.version || '')} ↗</a>
      <button class="drawer-item danger" data-act="logout">${ICON.logout}<span>${T('drawer.logout')}</span></button>
    </nav>`;
  root.classList.add('open');
  root.onclick = async (e) => {
    if (e.target.closest('[data-close]')) { closeDrawer(); return; }
    const th = e.target.closest('[data-theme-set]');
    if (th) {
      setTheme(th.dataset.themeSet);
      root.querySelectorAll('[data-theme-set]').forEach((b) => b.setAttribute('aria-checked', String(b === th)));
      return;
    }
    const g = e.target.closest('[data-group]');
    if (g) {
      const open = g.getAttribute('aria-expanded') !== 'true';
      g.setAttribute('aria-expanded', String(open));
      g.nextElementSibling.classList.toggle('collapsed', !open);
      S.drawerOpen[g.dataset.group] = open; save('drawerOpen', S.drawerOpen);
      return;
    }
    const src = e.target.closest('[data-source]')?.dataset.source;
    if (src) {
      closeDrawer();
      if (src !== S.source?.id) switchSource(src);
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    closeDrawer();
    if (act === 'chats') { if (S.view !== 'list') go('list'); }
    else if (act === 'contacts') { if (S.view !== 'contacts') go('contacts'); }
    else if (act === 'map') { if (S.view !== 'map') go('map'); }
    else if (act === 'rooms') { if (S.view !== 'rooms') go('rooms'); }
    else if (act === 'search') { if (S.view !== 'search') go('search'); }
    else if (act === 'stats') { if (S.view !== 'stats') go('stats'); }
    else if (act === 'repeaters') { if (S.view !== 'repeaters') go('repeaters'); }
    else if (act === 'packets') { if (S.view !== 'packets') go('packets'); }
    else if (act === 'mentions') { if (S.view !== 'mentions') go('mentions'); }
    else if (act === 'watch') openWatch();
    else if (act === 'lang') openLanguage();
    else if (act === 'reload') location.reload();
    else if (act === 'notify') {
      if (notifOn) await disablePush(); else await enablePush();
    } else if (act === 'pushtest') {
      try {
        const r = await api('/api/push/test', { method: 'POST' });
        const res = r.results || [];
        if (!res.length) toast(T('push.noDevice'));
        else if (r.ok) toast(T('push.testSent', { n: res.filter((x) => x.ok).length }));
        else toast(T('push.rejected', { list: res.map((x) => x.status || x.error).join(', ') }));
      } catch (err) { toast(T('push.testFailed', { msg: err.message })); }
    } else if (act === 'own') openOwnNodes();
    else if (act === 'advert') openAdvert();
    else if (act === 'readall') {
      const lr = { ...(S.lastRead || {}) };
      const { channels, dms } = conversations();
      for (const c of [...channels, ...dms]) lr[c.key] = Date.now();
      S.lastRead = lr; saveRead(); shareRead(lr); scheduleRender();
    } else if (act === 'logout') {
      await dropPushSubscription(); // abgemeldetes Gerät bekommt keine Nachrichten-Vorschau mehr
      await api('/api/logout', { method: 'POST' }).catch(() => {});
      showLogin();
    }
  };
}
// Sprache wählen: "Automatisch" folgt dem Browser, sonst feste Wahl (Cookie). Danach lädt die Seite neu.
const langName = (code) => (I18N.langs || []).find((l) => l.code === code)?.name || code;
function openLanguage() {
  const own = ownLanguage();
  const opt = (code, label, sub = '') => {
    const active = (code || null) === own;
    return `<button class="sheet-btn scope-opt ${active ? 'active' : ''}" data-lang="${esc(code || '')}"><span>${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>${active ? `<i>${ICON.check}</i>` : ''}</button>`;
  };
  openSheet(`
    <div class="sheet-title">${T('lang.title')}</div>
    ${opt(null, T('lang.auto'), own ? T('lang.autoSub') : T('lang.autoNow', { name: langName(LANG) }))}
    ${(I18N.langs || []).map((l) => opt(l.code, l.name)).join('')}
    <div class="hint">${T('lang.hint')}</div>
    <button class="sheet-btn cancel" data-close>${T('common.close')}</button>`, (e) => {
    const b = e.target.closest('[data-lang]');
    if (!b) return;
    const code = b.dataset.lang || null;
    closeSheet();
    if (code !== own) setLanguage(code);
  });
}
export function closeDrawer() { const r = $('#drawer-root'); r.classList.remove('open'); r.innerHTML = ''; }

async function switchSource(id) {
  const name = (S.sources || []).find((x) => x.id === id)?.name || id;
  toast(T('src.switching', { name }));
  try {
    await api('/api/source', { method: 'POST', body: { id } });
    // Der Server meldet "reset" per SSE an alle Geräte; hier zusätzlich direkt neu laden
    await resetData();
    toast(T('src.now', { name }));
  } catch (e) { toast(T('src.failed', { msg: e.message })); }
}

export async function resetData() {
  S.msgs.clear(); S.byPacket.clear(); S.names.clear(); S.expanded.clear(); S.pending.clear();
  S.myNames = new Set(); S.otherNames = new Set(); S.me = '';
  await resync();
  readHistoryIfFresh(); // neue Quelle auf diesem Gerät
  if (S.view === 'chat') go('list');
  else { $('#app').innerHTML = ''; render(); }
}
