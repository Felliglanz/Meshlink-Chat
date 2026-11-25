/* MeshLink Chat – Eingabe, Emoji-Auswahl, Senden. */

import { T } from '../core/i18n.js';
import { $, enc, esc } from '../core/util.js';
import { load, S, save } from '../core/state.js';
import { api } from '../core/api.js';
import { toast } from '../ui.js';
import { canReactTo, convOf, ECHO_WINDOW_MS, isMine, maxBytes } from '../data.js';
import { scopeKey } from '../scope.js';
import { RESEND_COOLDOWN_MS } from './meta.js';
import { scheduleRender } from '../nav.js';
import { renderReplyBar } from './view.js';

// ------------------------------------------------------------------ Emoji-Auswahl (für PC; auf dem Handy hat die Tastatur Emojis)

const EMOJI_SETS = [
  [T('emoji.smileys'), '😀 😃 😄 😁 😆 😅 😂 🤣 🙂 😉 😊 😇 🥰 😍 😘 😋 😜 🤪 😎 🤓 🥳 🤩 😏 😒 😔 😢 😭 😤 😠 😱 😳 🥺 🤔 🤫 🤭 🙄 😬 😴 🤯 🤠 😷 🤒 🥶 🥵 🤗 👀'],
  [T('emoji.gestures'), '👍 👎 👌 ✌️ 🤞 🤙 👋 🙏 👏 🙌 💪 🤝 ✋ 👊 🫡 🤷 🙋'],
  [T('emoji.hearts'), '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 ❣️ 💯 ✨ 🔥 ⭐ 🎉 🎊'],
  [T('emoji.radio'), '📡 📶 🔋 🪫 ⚡ 🛰️ 📻 📍 🗺️ 🧭 🏠 🚗 🚲 🥾 ⛰️ 🌲 ☀️ 🌧️ ⛈️ ❄️ 🌙'],
  [T('emoji.other'), '☕ 🍺 🍻 🍕 🎂 ✅ ❌ ⚠️ ❓ ❗ 🆘 🆗 🔧 🛠️ 💡 📷 ⏰ 🎵 🐶 🐱 🦆 🇩🇪'],
];
export function toggleEmojiPanel(force) {
  let panel = $('#emoji-panel');
  if (panel && force !== true) { panel.remove(); return; }
  if (panel) return;
  const recent = load('emojiRecent', []);
  panel = document.createElement('div');
  panel.id = 'emoji-panel';
  panel.className = 'emoji-panel';
  panel.innerHTML = [...(recent.length ? [[T('emoji.recent'), recent.join(' ')]] : []), ...EMOJI_SETS]
    .map(([title, list]) => `<div class="ep-title">${esc(title)}</div><div class="ep-grid">${list.split(' ').filter(Boolean).map((e) => `<button type="button" data-ins="${esc(e)}">${esc(e)}</button>`).join('')}</div>`).join('');
  $('.composer-wrap').appendChild(panel);
  panel.onmousedown = (e) => e.preventDefault(); // Fokus/Cursor im Eingabefeld behalten
  panel.onclick = (e) => {
    const b = e.target.closest('[data-ins]');
    if (!b) return;
    insertAtCursor($('#input'), b.dataset.ins);
    const r = [b.dataset.ins, ...load('emojiRecent', []).filter((x) => x !== b.dataset.ins)].slice(0, 16);
    save('emojiRecent', r);
  };
  setTimeout(() => {
    const close = (e) => {
      if (!$('#emoji-panel')) { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); return; }
      if (e.type === 'keydown' ? e.key === 'Escape' : !e.target.closest('#emoji-panel, #emoji-btn')) {
        $('#emoji-panel')?.remove(); document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
  }, 0);
}
// Eigenen Standort (GPS des Geräts) als Text einfügen – der Nutzer sieht ihn vor dem Senden und kann ihn ändern
export function insertLocation() {
  if (!('geolocation' in navigator)) { toast(T('loc.unsupported')); return; }
  if (!window.isSecureContext) { toast(T('loc.https')); return; }
  toast(T('loc.locating'));
  navigator.geolocation.getCurrentPosition((pos) => {
    const { latitude, longitude, accuracy } = pos.coords;
    const txt = `📍 ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
    const ta = $('#input');
    if (!ta) return;
    const sep = ta.value && !/\s$/.test(ta.value) ? ' ' : '';
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    insertAtCursor(ta, sep + txt);
    toast(T('loc.inserted', { m: Math.round(accuracy) }));
  }, (err) => {
    toast(err.code === 1 ? T('loc.denied') : err.code === 3 ? T('loc.timeout') : T('loc.unavailable'));
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}

function insertAtCursor(ta, text) {
  if (!ta) return;
  const a = ta.selectionStart ?? ta.value.length; const b = ta.selectionEnd ?? a;
  ta.value = ta.value.slice(0, a) + text + ta.value.slice(b);
  ta.selectionStart = ta.selectionEnd = a + text.length;
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

// ------------------------------------------------------------------ Composer & Senden

export function setupComposer() {
  const ta = $('#input');
  const draftKey = `draft:${S.conv}`;
  ta.value = load(draftKey, '');
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`; };
  const saveDraft = (v) => { if (v) save(draftKey, v); else try { localStorage.removeItem(`mc.${draftKey}`); } catch { /* egal */ } };
  ta.addEventListener('input', () => { autosize(); updateCount(); saveDraft(ta.value); });
  ta.addEventListener('keydown', (e) => {
    const touch = matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !touch) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  $('#composer').onsubmit = (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text || enc.encode(text).length > maxBytes(S.conv)) return;
    sendText(text, S.replyTo);
    ta.value = '';
    saveDraft('');
    S.replyTo = null;
    renderReplyBar();
    autosize();
    updateCount();
    ta.focus();
  };
  requestAnimationFrame(autosize);
}

export function updateCount() {
  const ta = $('#input');
  if (!ta) return;
  const n = enc.encode(ta.value.trim()).length;
  const max = maxBytes(S.conv);
  const c = $('#count');
  c.textContent = n > max * 0.6 ? `${n}/${max}` : '';
  c.classList.toggle('over', n > max);
  $('#send').disabled = !n || n > max;
}

function target(key) { return key.startsWith('dm:') ? { to: key.slice(3) } : { channel: Number(key.slice(3)) }; }

export async function sendText(text, replyToId, emoji = false) {
  const key = S.conv;
  const reply = replyToId ? S.msgs.get(replyToId) : null;
  const body = { text, ...target(key) };
  if (key.startsWith('ch:') && S.source?.protocol === 'meshcore') {
    const own = S.scopeOverride[scopeKey(Number(key.slice(3)))];
    if (typeof own === 'string') body.scope = own;
  }
  if (reply?.packetId) body.replyId = reply.packetId;
  if (emoji) body.emoji = true;
  const tid = `tmp-${++S.tmpSeq}`;
  const tmp = {
    id: tid, from: S.me || '__me__', to: body.to || null, channel: body.channel ?? -1, dm: Boolean(body.to),
    text, ts: Date.now(), replyId: body.replyId ?? null, reaction: emoji, emoji: emoji ? text : null, state: 'sending', local: true,
  };
  S.sentIds.add(tid);
  S.pending.set(tid, { text, conv: key, ts: tmp.ts });
  S.msgs.set(tid, tmp);
  scheduleRender();
  try {
    const r = await api('/api/send', { method: 'POST', body });
    if (r.id != null) S.sentIds.add(String(r.id));
    const t = S.msgs.get(tid);
    if (t) t.state = 'sent';
    if (r.id != null && S.msgs.has(String(r.id))) { S.msgs.delete(tid); S.pending.delete(tid); }
    // Knopf "Nochmal" bzw. 📡-Ergebnis rechtzeitig zeigen
    setTimeout(scheduleRender, RESEND_COOLDOWN_MS + 500);
    setTimeout(scheduleRender, ECHO_WINDOW_MS + 500);
  } catch (e) {
    const t = S.msgs.get(tid);
    if (t) t.state = 'failed';
    toast(T('send.failed', { msg: e.message }));
  }
  scheduleRender();
}

export function sendReaction(msgId, emoji) {
  const m = S.msgs.get(msgId);
  if (!canReactTo(m)) { toast(T('react.notPossible')); return; }
  if (S.source?.protocol !== 'meshcore') { sendText(emoji, msgId, true); return; }
  // Gleiche eigene Reaktion schon da? MeshCore kann Reaktionen nicht zurücknehmen.
  const dup = [...S.msgs.values()].some((r) => r.reaction && String(r.replyId) === m.id && r.emoji === emoji && isMine(r));
  if (dup) { toast(T('react.dup')); return; }
  const tid = `tmp-${++S.tmpSeq}`;
  S.msgs.set(tid, { id: tid, from: S.me || '__me__', to: m.dm ? (isMine(m) ? m.to : m.from) : null, channel: m.channel, dm: m.dm, text: emoji, ts: Date.now(), replyId: m.id, reaction: true, emoji, state: 'sending', local: true });
  S.sentIds.add(tid);
  S.pending.set(tid, { text: emoji, conv: convOf(m), ts: Date.now() });
  scheduleRender();
  api('/api/react', { method: 'POST', body: { id: m.id, emoji } }).then(() => { const t = S.msgs.get(tid); if (t) t.state = 'sent'; }).catch((e) => {
    S.msgs.delete(tid); S.pending.delete(tid); scheduleRender();
    const why = { REACTIONS_OUTBOUND_DISABLED: T('react.outboundOff'), DUPLICATE_REACTION: T('react.dup'), INVALID_EMOJI: T('react.invalid'), MESSAGE_NOT_FOUND: T('react.unknownMsg') }[e.code];
    toast(why || (e.status === 403 ? T('common.noSendPerm') : T('react.failed', { msg: e.message })));
  });
}
