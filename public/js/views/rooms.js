/* MeshLink Chat – Room-Server. */

import { T } from '../core/i18n.js';
import { $, ago, enc, esc, hm, hue } from '../core/util.js';
import { S } from '../core/state.js';
import { api } from '../core/api.js';
import { ICON } from '../core/icons.js';
import { avatar, permHint, toast } from '../ui.js';
import { node, renderText } from '../data.js';
import { go } from '../nav.js';
import { nearBottom } from '../chat/view.js';
import { loginRoute } from './admin.js';

// ------------------------------------------------------------------ Room-Server

export function renderRooms() {
  const app = $('#app');
  if (!$('.view-rooms', app)) {
    app.innerHTML = `
      <div class="view view-rooms">
        <header class="bar">
          <button class="icon-btn" id="back" aria-label="${esc(T('common.back'))}">${ICON.back}</button>
          <div class="bar-title"><h2>${T('rooms.title')}</h2><div class="sub">${T('rooms.sub')}</div></div>
        </header>
        <main class="scroll" id="rooms"><div class="empty">${T('common.loading')}</div></main>
      </div>`;
    $('#back').onclick = () => history.back();
    $('#rooms').onclick = (e) => { const it = e.target.closest('[data-room]'); if (it) go('room', it.dataset.room); };
    api('/api/rooms').then((r) => {
      if (S.view !== 'rooms') return;
      $('#rooms').innerHTML = r.rooms.map((x) => `
        <button class="conv" data-room="${esc(x.id)}">
          ${avatar('dm:' + x.id)}
          <div class="conv-body">
            <div class="conv-top"><span class="conv-title">🏠 ${esc(x.name)}</span><span class="conv-time">${x.loggedIn ? '🔓' : '🔒'}</span></div>
            <div class="conv-bottom"><span class="conv-preview muted">${x.loggedIn ? T('rooms.in') : T('rooms.out')} · ${T('chat.lastHeard', { ago: esc(ago(x.lastSeen)) })}</span></div>
          </div>
        </button>`).join('') || `<div class="empty">${T('rooms.none')}</div>`;
    }).catch((e) => { if (S.view === 'rooms') $('#rooms').innerHTML = `<div class="empty">${esc(permHint(e, 'messages:read'))}</div>`; });
  }
}

export function renderRoom() {
  const app = $('#app');
  const id = S.conv;
  if ($('.view-room', app) && app.dataset.room === id) return;
  app.dataset.room = id;
  const n = node(id);
  app.innerHTML = `
    <div class="view view-chat view-room">
      <header class="bar">
        <button class="icon-btn" id="back" aria-label="${esc(T('common.back'))}">${ICON.back}</button>
        ${avatar('dm:' + id, 'small')}
        <div class="bar-title"><h2>🏠 ${esc(n?.long || n?.short || T('type.room'))}</h2><div class="sub" id="room-sub">${T('common.loading')}</div></div>
      </header>
      <main class="scroll msgs" id="room-posts"></main>
      <footer class="composer-wrap" id="room-foot"></footer>
    </div>`;
  $('#back').onclick = () => history.back();
  S.room = { id, posts: null, loggedIn: null };
  loadRoom(true);
  clearInterval(S.roomTimer);
  S.roomTimer = setInterval(() => { if (S.view === 'room' && !document.hidden) loadRoom(false); else if (S.view !== 'room') clearInterval(S.roomTimer); }, 15000);
}

async function loadRoom(first) {
  const rm = S.room;
  try {
    const [list, posts] = await Promise.all([api('/api/rooms').catch(() => ({ rooms: [] })), api(`/api/rooms/posts?id=${encodeURIComponent(rm.id)}`)]);
    if (S.room !== rm || S.view !== 'room') return;
    rm.loggedIn = Boolean(list.rooms.find((x) => x.id === rm.id)?.loggedIn);
    rm.posts = posts.posts;
    rm.err = null;
  } catch (e) {
    if (S.room !== rm) return;
    rm.posts = rm.posts || [];
    rm.err = permHint(e, 'messages:read');
  }
  drawRoom(first);
}

function drawRoom(first) {
  const rm = S.room;
  const el = $('#room-posts');
  if (!el) return;
  const stick = first || nearBottom(el);
  $('#room-sub').textContent = rm.loggedIn ? T('rooms.subIn') : T('rooms.subOut');
  el.innerHTML = (rm.posts || []).map((p) => `
    <div class="row ${p.mine ? 'mine' : 'theirs'}"><div class="bubble-col"><div class="bubble">
      ${!p.mine && p.name ? `<div class="sender" style="--h:${hue(p.name)}">${esc(p.name)}</div>` : ''}
      <div class="text">${renderText(p.text)}</div><div class="meta">${hm(p.ts)}</div>
    </div></div></div>`).join('') || `<div class="empty chat-empty">${esc(rm.err || T('rooms.noPosts'))}</div>`;
  if (stick) el.scrollTop = el.scrollHeight;
  const foot = $('#room-foot');
  if (rm.loggedIn) {
    if (!$('#room-form')) {
      foot.innerHTML = `<form class="composer" id="room-form"><textarea id="room-in" rows="1" placeholder="${esc(T('rooms.placeholder'))}" enterkeyhint="send"></textarea><button class="send" type="submit" aria-label="${esc(T('common.send'))}">${ICON.send}</button></form>`;
      $('#room-form').onsubmit = async (e) => {
        e.preventDefault();
        const t = $('#room-in').value.trim();
        if (!t) return;
        if (enc.encode(t).length > 140) { toast(T('rooms.tooLong', { n: 140 })); return; }
        try { await api('/api/rooms/post', { method: 'POST', body: { id: rm.id, text: t } }); $('#room-in').value = ''; toast(T('rooms.posted')); setTimeout(() => loadRoom(false), 2500); } catch (err) { toast(permHint(err, 'messages:write')); }
      };
      $('#room-in').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#room-form').requestSubmit(); } };
    }
  } else if (!$('#room-login')) {
    foot.innerHTML = `
      <form class="room-login" id="room-login">
        <input id="room-pw" type="password" placeholder="${esc(T('rooms.pw'))}" autocomplete="off">
        <label class="room-remember"><input type="checkbox" id="room-rem"> ${T('rooms.remember')}</label>
        <div class="node-actions"><button class="pill primary-pill" type="submit">${T('rooms.login')}</button><button class="pill" type="button" id="room-saved">${T('rooms.saved')}</button></div>
        <div class="login-route muted" id="room-route"></div>
      </form>`;
    loginRoute(rm.id).then((r) => { const el = $('#room-route'); if (el && r) el.textContent = `↪ ${T('login.routeLabel', { route: r })}`; });
    const login = async (body) => {
      $('#room-sub').textContent = T('rooms.loggingIn');
      try { await api('/api/rooms/login', { method: 'POST', body: { id: rm.id, ...body } }); toast(T('rooms.loggedIn')); foot.innerHTML = ''; await loadRoom(true); } catch (err) { toast(err.status === 422 ? T('rooms.rejected') : permHint(err, 'messages:write')); drawRoom(false); }
    };
    $('#room-login').onsubmit = (e) => { e.preventDefault(); login({ password: $('#room-pw').value, remember: $('#room-rem').checked }); };
    $('#room-saved').onclick = () => login({ saved: true });
  }
}
