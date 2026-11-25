/* MeshLink Chat – Chat-Ansicht und Nachrichten. */

import { T } from '../core/i18n.js';
import { $, ago, dayLabel, esc, hm, hue } from '../core/util.js';
import { S } from '../core/state.js';
import { ICON } from '../core/icons.js';
import { avatar, stateIcon } from '../ui.js';
import { convOf, convTitle, isMine, isOwnOther, markRead, node, nodeName, renderText, targetOf } from '../data.js';
import { effectiveScope, openScopePicker, scopeLabel } from '../scope.js';
import { convPref, openConvPrefs } from '../prefs.js';
import { heardBadge, heardList, resendButton, scopeTag } from './meta.js';
import { statusLine } from '../nav.js';
import { insertLocation, setupComposer, toggleEmojiPanel, updateCount } from './composer.js';
import { setupMessageGestures } from './actions.js';

export function renderChat() {
  const app = $('#app');
  const key = S.conv;
  if (!$('.view-chat', app) || app.dataset.conv !== key) {
    app.dataset.conv = key;
    app.innerHTML = `
      <div class="view view-chat">
        <header class="bar">
          <button class="icon-btn" id="back" aria-label="${esc(T('common.back'))}">${ICON.back}</button>
          ${avatar(key, 'small')}
          <div class="bar-title"><h2 id="chat-title"></h2><div class="sub" id="chat-sub"></div></div>
          <button class="icon-btn bell-btn" id="notif-btn" aria-label="${esc(T('chat.notifBtn'))}"></button>
        </header>
        <main class="scroll msgs" id="msgs"></main>
        <button class="jump hidden" id="jump" aria-label="${esc(T('chat.jump'))}">${ICON.down}</button>
        <footer class="composer-wrap">
          <div class="reply-bar hidden" id="reply-bar"></div>
          <form class="composer" id="composer">
            ${key.startsWith('ch:') ? `<button type="button" class="scope-chip hidden" id="scope-chip" aria-label="${esc(T('chat.scopePick'))}"></button>` : ''}
            <button type="button" class="emoji-btn" id="emoji-btn" aria-label="${esc(T('chat.emoji'))}" title="${esc(T('chat.emoji'))}">😊</button>
            <button type="button" class="loc-btn" id="loc-btn" aria-label="${esc(T('chat.loc'))}" title="${esc(T('chat.locTitle'))}">📍</button>
            <textarea id="input" rows="1" placeholder="${esc(T('chat.placeholder'))}" enterkeyhint="send" autocomplete="off"></textarea>
            <span class="count" id="count"></span>
            <button class="send" id="send" type="submit" aria-label="${esc(T('common.send'))}">${ICON.send}</button>
          </form>
        </footer>
      </div>`;
    $('#back').onclick = () => history.back();
    $('#notif-btn').onclick = () => openConvPrefs(key);
    if (key.startsWith('ch:')) {
      const pick = () => { if (S.source?.protocol === 'meshcore') openScopePicker(Number(key.slice(3))); };
      $('#scope-chip').onclick = pick;
      $('#chat-sub').onclick = pick;
    }
    setupComposer();
    $('#emoji-btn').onclick = (e) => { e.preventDefault(); toggleEmojiPanel(); };
    $('#loc-btn').onclick = (e) => { e.preventDefault(); insertLocation(); };
    setupMessageGestures();
    const msgs = $('#msgs');
    msgs.addEventListener('touchstart', () => { S.lineUntil = 0; }, { passive: true });
    msgs.addEventListener('scroll', () => $('#jump').classList.toggle('hidden', nearBottom(msgs)), { passive: true });
    $('#jump').onclick = () => msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'smooth' });
    S.firstChatRender = true;
    S.unreadSince = (S.lastRead || {})[key] || 0; // Stand vor dem Öffnen -> rote Linie
    S.lineUntil = Date.now() + 4000; // so lange zur Linie springen, auch wenn Nachrichten erst nachkommen
  }
  $('#chat-title').textContent = convTitle(key);
  const pref = convPref(key);
  $('#notif-btn').innerHTML = pref === 'mute' ? '<span>🔕</span>' : pref === 'all' ? '<span>📣</span>' : ICON.bell;
  if (key.startsWith('dm:')) {
    const n = node(key.slice(3));
    const bits = [n?.short ? esc(n.short) : null, T('chat.lastHeard', { ago: ago(n?.lastHeard) }), n?.hops != null ? T('common.hops', { n: n.hops }) : null];
    $('#chat-sub').innerHTML = bits.filter(Boolean).join(' · ');
  } else {
    const idx = Number(key.slice(3));
    $('#chat-sub').innerHTML = S.connected
      ? `${T('channel.n', { i: esc(key.slice(3)) })}${S.source?.protocol === 'meshcore' ? ` · <span class="scope-sub ${effectiveScope(idx).from === 'own' ? 'own' : ''}">${esc(scopeLabel(idx, true))}</span>` : ` · ${esc(S.source?.name || '')}`}`
      : statusLine();
    const chip = $('#scope-chip');
    if (chip) {
      chip.classList.toggle('hidden', S.source?.protocol !== 'meshcore');
      chip.textContent = scopeLabel(idx);
      chip.classList.toggle('own', effectiveScope(idx).from === 'own');
    }
  }
  renderMessages();
  renderReplyBar();
  updateCount();
  markRead(key);
}

export function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 120; }

export function renderMessages() {
  const el = $('#msgs');
  const key = S.conv;
  const stick = S.firstChatRender || nearBottom(el);
  const list = [...S.msgs.values()].filter((m) => !m.reaction && convOf(m) === key).sort((a, b) => a.ts - b.ts);
  const reacts = new Map();
  for (const m of S.msgs.values()) {
    if (!m.reaction || m.replyId == null) continue;
    const k = String(m.replyId);
    if (!reacts.has(k)) reacts.set(k, []);
    reacts.get(k).push(m);
  }
  const isCh = key.startsWith('ch:');
  let html = '';
  let lastDay = '';
  let prev = null;
  const isNew = (m) => m.ts > S.unreadSince && !isMine(m) && !isOwnOther(m);
  const firstNew = S.unreadSince ? list.find(isNew) : null;
  const newCount = firstNew ? list.filter(isNew).length : 0;
  for (const m of list) {
    const day = dayLabel(m.ts);
    if (day !== lastDay) { html += `<div class="day"><span>${esc(day)}</span></div>`; lastDay = day; prev = null; }
    if (m === firstNew) { html += `<div class="unread-line" id="unread-line"><span>${T('chat.newMsgs', { n: newCount })}</span></div>`; prev = null; }
    const other = isOwnOther(m);
    const mine = isMine(m) || other;
    const grouped = prev && prev.from === m.from && m.ts - prev.ts < 5 * 60000;
    const tgt = targetOf(m);
    const rs = [...(m.packetId ? reacts.get(String(m.packetId)) || [] : []), ...(S.source?.protocol === 'meshcore' ? reacts.get(m.id) || [] : [])];
    const chips = new Map();
    for (const r of rs) {
      const c = chips.get(r.emoji) || { n: 0, mine: false, who: [] };
      c.n++; c.mine ||= isMine(r); c.who.push(isMine(r) ? T('common.you') : nodeName(r.from));
      chips.set(r.emoji, c);
    }
    html += `
      <div class="row ${mine ? 'mine' : 'theirs'} ${other ? 'own-other' : ''} ${grouped ? 'grouped' : ''}" data-id="${esc(m.id)}">
        ${!mine && isCh ? (grouped ? '<div class="avatar-spacer"></div>' : avatar('dm:' + m.from, 'tiny')) : ''}
        <div class="bubble-col">
          <div class="bubble">
            ${!mine && isCh && !grouped ? `<div class="sender" style="--h:${hue('dm:' + m.from)}">${esc(nodeName(m.from))}</div>` : ''}
            ${other && !grouped ? `<div class="via">${T('chat.via', { name: esc(m.name) })}</div>` : ''}
            ${tgt ? `<div class="quote" data-jump="${esc(tgt.id)}"><b>${esc(isMine(tgt) ? T('common.you') : nodeName(tgt.from))}</b><span>${esc(tgt.text)}</span></div>` : m.replyId != null ? `<div class="quote"><span class="muted">${T('chat.replyOld')}</span></div>` : ''}
            <div class="text">${renderText(m.text)}</div>
            ${heardList(m)}
            <div class="meta">${heardBadge(m)}${isMine(m) || isOwnOther(m) ? scopeTag(m) : ''}${resendButton(m)}${m.hops != null && !mine && S.source?.protocol !== 'meshcore' ? `<span class="hops">${m.hops}↯</span>` : ''}${hm(m.ts)}${mine ? stateIcon(m.state) : ''}</div>
          </div>
          ${chips.size ? `<div class="reacts">${[...chips].map(([e, c]) => `<button class="chip ${c.mine ? 'chip-mine' : ''}" data-react="${esc(e)}" data-target="${esc(m.id)}" title="${esc(c.who.join(', '))}">${esc(e)}${c.n > 1 ? `<span>${c.n}</span>` : ''}</button>`).join('')}</div>` : ''}
        </div>
      </div>`;
    prev = m;
  }
  if (!list.length) html = `<div class="empty chat-empty">${T('chat.empty')}</div>`;
  el.innerHTML = html;
  if (S.jumpTo) {
    const row = el.querySelector(`[data-id="${CSS.escape(S.jumpTo)}"]`);
    S.jumpTo = null;
    if (row) { S.lineUntil = 0; S.firstChatRender = false; row.scrollIntoView({ block: 'center' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1500); $('#jump').classList.toggle('hidden', nearBottom(el)); return; }
  }
  const line = S.lineUntil > Date.now() && $('#unread-line');
  if (line) { el.scrollTop += line.getBoundingClientRect().top - el.getBoundingClientRect().top - 8; S.lineUntil = 0; }
  else if (stick) el.scrollTop = el.scrollHeight;
  S.firstChatRender = false;
  $('#jump').classList.toggle('hidden', nearBottom(el));
}

export function renderReplyBar() {
  const bar = $('#reply-bar');
  const m = S.replyTo && S.msgs.get(S.replyTo);
  if (!m) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.innerHTML = `<div class="reply-inner"><b>${isMine(m) ? T('chat.replyToYou') : T('chat.replyTo', { name: esc(nodeName(m.from)) })}</b><span>${esc(m.text)}</span></div><button class="icon-btn" id="reply-x" aria-label="${esc(T('chat.replyCancel'))}">${ICON.close}</button>`;
  $('#reply-x').onclick = () => { S.replyTo = null; renderReplyBar(); };
}
