/* MeshLink Chat – Suche und Erwähnungen. */

import { T } from '../core/i18n.js';
import { $, dayLabel, esc, hm } from '../core/util.js';
import { S } from '../core/state.js';
import { api } from '../core/api.js';
import { ICON } from '../core/icons.js';
import { avatar, permHint } from '../ui.js';
import { convOf, convTitle, ingest, isMine, isOwnOther, mentionsMe, nodeName } from '../data.js';
import { go } from '../nav.js';

// ------------------------------------------------------------------ Suche (nur in den geladenen Nachrichten)

export function renderSearch() {
  const app = $('#app');
  if (!$('.view-search', app)) {
    app.innerHTML = `
      <div class="view view-search">
        <header class="bar">
          <button class="icon-btn" id="back" aria-label="${esc(T('common.back'))}">${ICON.back}</button>
          <div class="search">${ICON.search}<input id="sq" type="search" placeholder="${esc(T('search.ph'))}" autocomplete="off"></div>
        </header>
        <main class="scroll" id="results"><div class="empty">${T('search.prompt')}</div></main>
      </div>`;
    $('#back').onclick = () => history.back();
    $('#sq').oninput = drawSearch;
    $('#results').onclick = (e) => {
      const it = e.target.closest('[data-hit]');
      if (!it) return;
      S.jumpTo = it.dataset.hit;
      go('chat', it.dataset.conv);
    };
    setTimeout(() => $('#sq')?.focus(), 50);
  }
}
function drawSearch() {
  const q = $('#sq').value.trim().toLowerCase();
  const el = $('#results');
  if (q.length < 2) { el.innerHTML = `<div class="empty">${T('search.min', { n: 2 })}</div>`; return; }
  const hits = [...S.msgs.values()].filter((m) => !m.reaction && !m.id.startsWith('tmp-') && (m.text.toLowerCase().includes(q) || nodeName(m.from).toLowerCase().includes(q)))
    .sort((a, b) => b.ts - a.ts);
  const mark = (t) => { const i = t.toLowerCase().indexOf(q); return i < 0 ? esc(t) : `${esc(t.slice(0, i))}<mark>${esc(t.slice(i, i + q.length))}</mark>${esc(t.slice(i + q.length))}`; };
  el.innerHTML = hits.slice(0, 200).map((m) => `
    <button class="conv" data-hit="${esc(m.id)}" data-conv="${esc(convOf(m))}">
      ${avatar(convOf(m))}
      <div class="conv-body">
        <div class="conv-top"><span class="conv-title">${esc(convTitle(convOf(m)))}</span><span class="conv-time">${esc(dayLabel(m.ts))} ${hm(m.ts)}</span></div>
        <div class="conv-bottom"><span class="conv-preview"><b>${esc(isMine(m) ? T('common.you') : nodeName(m.from))}:</b> ${mark(m.text)}</span></div>
      </div>
    </button>`).join('') + (hits.length > 200 ? `<div class="empty">${T('search.more', { n: hits.length - 200 })}</div>` : '')
    || `<div class="empty">${T('search.none')}</div>`;
}

// ------------------------------------------------------------------ Erwähnungen (@Name) der letzten 7 Tage

export const unreadMentions = () => [...S.msgs.values()].filter((m) => !m.reaction && !isMine(m) && !isOwnOther(m) && !m.dm && mentionsMe(m) && m.ts > ((S.lastRead || {})[convOf(m)] || 0)).length;

export function renderMentionsView() {
  const app = $('#app');
  if ($('.view-mentions', app)) return;
  app.innerHTML = `
    <div class="view view-mentions">
      <header class="bar">
        <button class="icon-btn" id="back" aria-label="${esc(T('common.back'))}">${ICON.back}</button>
        <div class="bar-title"><h2>${T('men.title')}</h2><div class="sub" id="men-sub">${T('men.sub')}</div></div>
        <button class="icon-btn" id="men-refresh" aria-label="${esc(T('common.refresh'))}">${ICON.refresh}</button>
      </header>
      <main class="scroll" id="men-list"><div class="empty">${T('men.searching')}</div></main>
    </div>`;
  $('#back').onclick = () => history.back();
  $('#men-refresh').onclick = loadMentions;
  $('#men-list').onclick = (e) => {
    const it = e.target.closest('[data-men]');
    if (!it) return;
    const m = S.mentions?.find((x) => x.id === it.dataset.men);
    if (!m) return;
    if (!S.msgs.has(m.id)) ingest([m], true); // ältere Nachricht in den Chat holen, damit der Sprung klappt
    S.jumpTo = m.id;
    go('chat', convOf(m));
  };
  loadMentions();
}

async function loadMentions() {
  try {
    const r = await api('/api/mentions?days=7');
    if (S.view !== 'mentions') return;
    S.mentions = r.mentions;
    const lr = S.lastRead || {};
    $('#men-sub').textContent = `${T('men.count', { n: r.mentions.length })}${r.names.length ? ` ${T('men.ofName', { name: r.names[0] })}` : ''}`;
    $('#men-list').innerHTML = r.mentions.map((m) => {
      const k = convOf(m);
      const unread = m.ts > (lr[k] || 0);
      return `
      <button class="conv ${unread ? 'men-unread' : ''}" data-men="${esc(m.id)}">
        ${avatar('dm:' + m.from)}
        <div class="conv-body">
          <div class="conv-top"><span class="conv-title">${esc(nodeName(m.from))} <small class="muted">${T('men.in', { name: esc(convTitle(k)) })}</small></span><span class="conv-time ${unread ? 'accent' : ''}">${esc(dayLabel(m.ts))} ${hm(m.ts)}</span></div>
          <div class="conv-bottom"><span class="conv-preview">${esc(m.text.replace(/@\[([^\]]{1,40})\]/g, '@$1'))}</span>${unread ? `<span class="badge">${T('men.new')}</span>` : ''}</div>
        </div>
      </button>`;
    }).join('') + (r.truncated ? `<div class="empty">${T('men.trunc')}</div>` : '')
      + (r.skipped?.length ? `<div class="hint">${T('men.skipped', { list: esc(r.skipped.join(', ')) })}</div>` : '')
      || `<div class="empty">${r.names.length ? T('men.none') : T('men.noName')}</div>`;
  } catch (e) {
    if (S.view === 'mentions') $('#men-list').innerHTML = `<div class="empty">${esc(permHint(e, 'messages:read'))}</div>`;
  }
}
