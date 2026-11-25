/* MeshLink Chat – Chatliste mit Suche und Filtern. */

import { T } from '../core/i18n.js';
import { $, esc, listTime } from '../core/util.js';
import { load, S, save } from '../core/state.js';
import { ICON, ic } from '../core/icons.js';
import { avatar } from '../ui.js';
import { chSort, chSortLabel, conversations, convTitle, isMine, isOwnOther, node, nodeName, openChannelSort, updateBadge } from '../data.js';
import { effectiveScope, scopeLabel } from '../scope.js';
import { convPref } from '../prefs.js';
import { go, isWide, statusLine } from '../nav.js';
import { openDrawer } from '../drawer.js';

// Chatliste: Filter (je Gerät gemerkt) und Suchtext (nur bis zum Neuladen)
const LIST_FILTERS = ['all', 'unread', 'fav', 'dm', 'ch'];
S.listFilter = load('listFilter', 'all');
S.listQ = '';
const isFavConv = (key) => key.startsWith('dm:') && Boolean(node(key.slice(3))?.fav);

export function renderList(app = $('#app')) {
  if (!$('.view-list', app)) {
    app.innerHTML = `
      <div class="view view-list">
        <header class="bar">
          <button class="icon-btn" id="menu-btn" aria-label="${esc(T('list.menu'))}">${ICON.menu}</button>
          <div class="bar-title"><h1>MeshLink Chat</h1><div class="sub" id="status"></div></div>
        </header>
        <div class="list-tools">
          <label class="list-search">${ICON.search}<input id="list-q" type="search" autocomplete="off" enterkeyhint="search"></label>
          <div class="chips" id="list-chips"></div>
        </div>
        <main class="scroll" id="convs"></main>
        <button class="fab" id="new-dm" aria-label="${esc(T('list.newDm'))}">${ICON.plus}</button>
      </div>`;
    $('#menu-btn').onclick = openDrawer;
    $('#new-dm').onclick = () => go('contacts');
    const q = $('#list-q', app);
    q.value = S.listQ;
    q.oninput = () => { S.listQ = q.value; renderList(app); };
    $('#list-chips', app).onclick = (e) => {
      const b = e.target.closest('[data-lf]');
      if (!b) return;
      S.listFilter = b.dataset.lf; save('listFilter', S.listFilter);
      renderList(app);
    };
    $('#convs').onclick = (e) => {
      if (e.target.closest('#ch-sort')) { openChannelSort(); return; }
      const it = e.target.closest('[data-conv]');
      if (it) go('chat', it.dataset.conv, isWide() && S.view !== 'list');
    };
  }
  $('#status').innerHTML = statusLine();
  const { channels, dms } = conversations();
  const item = (c) => {
    const l = c.last;
    let preview = `<span class="muted">${T('list.noMsgs')}</span>`;
    if (l) {
      const who = isMine(l) ? `${T('common.you')}: ` : isOwnOther(l) ? `${T('list.youVia', { name: esc(l.name) })}: ` : c.key.startsWith('ch:') ? `${esc(nodeName(l.from))}: ` : '';
      preview = `${who}${esc(l.text.replace(/@\[([^\]]{1,40})\]/g, '@$1'))}`;
    }
    return `
      <button class="conv" data-conv="${esc(c.key)}">
        ${avatar(c.key)}
        <div class="conv-body">
          <div class="conv-top"><span class="conv-title">${esc(convTitle(c.key))}${c.muted ? ` <small class="conv-flag" title="${esc(T('list.mutedFlag'))}">${ic('mute')}</small>` : convPref(c.key) === 'all' ? ` <small class="conv-flag" title="${esc(T('list.allFlag'))}">${ic('megaphone')}</small>` : ''}${convScopeFlag(c.key)}</span><span class="conv-time ${c.unread ? 'accent' : ''}">${listTime(l?.ts)}</span></div>
          <div class="conv-bottom"><span class="conv-preview">${preview}</span>${c.unread ? `<span class="badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</div>
        </div>
      </button>`;
  };
  // Kanal mit eigenem oder abweichendem Scope: kleines Schild (der Standard der Quelle steht nicht an jedem Kanal)
  const convScopeFlag = (key) => {
    if (!key.startsWith('ch:') || S.source?.protocol !== 'meshcore') return '';
    const idx = Number(key.slice(3));
    const e = effectiveScope(idx);
    const show = e.scope && (e.from === 'own' || (e.from === 'channel' && e.scope !== S.scopeInfo?.defaultScope));
    return show ? ` <small class="conv-flag conv-scope" title="${esc(scopeLabel(idx, true))}">${ic('lock')}${esc(e.scope)}</small>` : '';
  };
  // Suchzeile (Name des Chats) und Filter-Chips: Alles · Ungelesen · ★ (Favoriten-Kontakte) · DMs · Kanäle
  const f = LIST_FILTERS.includes(S.listFilter) ? S.listFilter : 'all';
  const q = S.listQ.trim().toLowerCase();
  const unreadN = channels.filter((c) => c.unread).length + dms.filter((c) => c.unread).length;
  $('#list-q', app).placeholder = T('list.searchN', { n: channels.length + dms.length });
  const chip = (k, label, extra = '') => `<button class="pill ${f === k ? 'primary-pill' : ''}" data-lf="${k}"${k === 'fav' ? ` aria-label="${esc(T('list.fFav'))}" title="${esc(T('list.fFav'))}"` : ''}>${label}${extra}</button>`;
  const chips = chip('all', T('list.fAll')) + chip('unread', T('list.fUnread'), unreadN ? ` <b>${unreadN > 99 ? '99+' : unreadN}</b>` : '')
    + chip('fav', ICON.star) + chip('dm', T('list.fDms')) + chip('ch', T('list.fChannels'));
  if ($('#list-chips', app).innerHTML !== chips) $('#list-chips', app).innerHTML = chips;
  const keep = (c) => (!q || convTitle(c.key).toLowerCase().includes(q)) && (f !== 'unread' || c.unread > 0) && (f !== 'fav' || isFavConv(c.key));
  const banner = S.error && S.sse ? `<div class="banner">${esc(S.error)}</div>` : '';
  const sortBtn = channels.length > 1 ? `<button class="sort-btn" id="ch-sort" aria-label="${esc(T('list.sortTitle'))}" title="${esc(T('list.sortTitle'))}">${ICON.sort}<span>${esc(chSortLabel(chSort()))}</span></button>` : '';
  if (f === 'all' && !q) {
    $('#convs', app).innerHTML = `${banner}
      <div class="section section-row"><span>${T('list.channels')}</span>${sortBtn}</div>
      ${channels.map(item).join('') || `<div class="empty">${T('list.noChannels')}</div>`}
      <div class="section">${T('list.dms')}</div>
      ${dms.map(item).join('') || `<div class="empty">${T('list.noDms')}</div>`}`;
  } else {
    const chs = f === 'dm' || f === 'fav' ? [] : channels.filter(keep);
    const ds = f === 'ch' ? [] : dms.filter(keep);
    const empty = f === 'unread' && !q ? T('list.allRead') : f === 'fav' && !q ? T('list.noFavs') : T('list.noMatch');
    $('#convs', app).innerHTML = `${banner}
      ${chs.length ? `<div class="section section-row"><span>${T('list.channels')}</span>${sortBtn}</div>${chs.map(item).join('')}` : ''}
      ${ds.length ? `<div class="section">${T('list.dms')}</div>${ds.map(item).join('')}` : ''}
      ${chs.length || ds.length ? '' : `<div class="empty">${empty}</div>`}`;
  }
  updateBadge();
}
