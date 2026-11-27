/* MeshLink Chat – Gesten und Aktionsmenü einer Nachricht. */

import { LOC, T } from '../core/i18n.js';
import { $, esc, hm, QUICK } from '../core/util.js';
import { S, save } from '../core/state.js';
import { ICON } from '../core/icons.js';
import { closeSheet, openSheet, toast } from '../ui.js';
import { canReactTo, channelName, isMine, nodeName, reactionsSupported, relayLabel } from '../data.js';
import { floodResend, msgScope, resend, resendInfo, resetDmPath } from './meta.js';
import { go, scheduleRender } from '../nav.js';
import { renderMessages, renderReplyBar } from './view.js';
import { sendReaction } from './composer.js';
import { showOnMap } from '../map/map.js';

// ------------------------------------------------------------------ Gesten & Aktionsmenü

// Antworten: bei MeshCore als @Erwähnung vorne im Eingabefeld, sonst mit Antwortzeile (Zitat)
function startReply(m) {
  if (S.source?.protocol === 'meshcore') {
    const ta = $('#input');
    if (!isMine(m)) { ta.value = `@[${nodeName(m.from)}] ${ta.value}`; ta.dispatchEvent(new Event('input')); }
  } else { S.replyTo = m.id; renderReplyBar(); }
  $('#input').focus();
}
// Wischen geht nur, wo Antworten etwas bewirkt (bei MeshCore nicht auf eigene Nachrichten)
const canSwipeReply = (m) => m && !m.id.startsWith('tmp-') && !(S.source?.protocol === 'meshcore' && isMine(m));
const SWIPE_START = 14; const SWIPE_ARM = 56; const SWIPE_MAX = 84;

// Info-Blatt: selbst gehörte Repeater (mit SNR), dazu Kopien über einen festen Weg
function heardText(m) {
  const parts = [
    ...(m.heardDirect || []).map((d) => `${d.via ? relayLabel(d.via) : T('heard.directVia')}${d.snr != null ? ` (SNR ${d.snr})` : ''}`),
    ...(m.heard || []).filter((r) => r.snr != null).map((r) => `${relayLabel(r)} (SNR ${r.snr})`),
  ];
  const seen = (m.heard || []).filter((r) => r.snr == null).length;
  if (!parts.length && !seen) return T('info.noRepeater');
  return `${parts.join(', ')}${seen ? `${parts.length ? ' · ' : ''}${T('info.pathOnly', { n: seen })}` : ''}`;
}

export function setupMessageGestures() {
  const el = $('#msgs');
  let timer = null; let start = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  // Nachricht nach rechts wischen = Antworten (nur Finger/Stift). Kurz vibrieren, sobald Loslassen antwortet.
  let sw = null; let swipedAt = 0;
  el.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.bubble');
    sw = b && e.pointerType !== 'mouse' ? { row: b.closest('.row'), x: e.clientX, y: e.clientY, on: false, armed: false } : null;
  });
  el.addEventListener('pointermove', (e) => {
    if (!sw) return;
    const dx = e.clientX - sw.x; const dy = e.clientY - sw.y;
    if (!sw.on) {
      if (Math.abs(dy) > 12) { sw = null; return; }
      if (dx < SWIPE_START || dx < Math.abs(dy) * 1.5) return;
      if (!canSwipeReply(S.msgs.get(sw.row.dataset.id))) { sw = null; return; }
      sw.on = true; cancel();
      sw.icon = document.createElement('span');
      sw.icon.className = 'swipe-ic';
      sw.icon.innerHTML = ICON.reply;
      sw.row.prepend(sw.icon);
      sw.row.classList.add('swiping');
    }
    const x = Math.max(0, Math.min(dx - SWIPE_START, SWIPE_MAX));
    sw.row.style.setProperty('--sx', `${x}px`);
    const armed = x >= SWIPE_ARM;
    if (armed !== sw.armed) { sw.armed = armed; sw.row.classList.toggle('swipe-armed', armed); if (armed) navigator.vibrate?.(10); }
  });
  const swipeEnd = () => {
    const s = sw; sw = null;
    if (!s?.on) return;
    swipedAt = Date.now();
    s.row.classList.remove('swiping', 'swipe-armed');
    s.row.style.removeProperty('--sx');
    setTimeout(() => s.icon.remove(), 200);
    const m = S.msgs.get(s.row.dataset.id);
    if (s.armed && m) startReply(m);
  };
  el.addEventListener('pointerup', swipeEnd);
  el.addEventListener('pointercancel', swipeEnd);
  el.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.bubble');
    if (!b || e.button > 0 || e.target.closest('[data-heard], [data-resend], [data-route-map], [data-route-reset], [data-geo], a')) return;
    start = { x: e.clientX, y: e.clientY };
    const id = b.closest('.row').dataset.id;
    timer = setTimeout(() => { timer = null; navigator.vibrate?.(15); openActions(id); }, 420);
  });
  el.addEventListener('pointermove', (e) => { if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel(); });
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('scroll', cancel, { passive: true });
  el.addEventListener('contextmenu', (e) => {
    const b = e.target.closest('.bubble');
    if (!b) return;
    e.preventDefault();
    cancel();
    openActions(b.closest('.row').dataset.id);
  });
  el.addEventListener('click', (e) => {
    const rs = e.target.closest('[data-resend]');
    if (rs) { resend(rs.dataset.resend); return; }
    const geo = e.target.closest('[data-geo]');
    if (geo) {
      const [lat, lon] = geo.dataset.geo.split(',').map(Number);
      const m = S.msgs.get(geo.closest('.row')?.dataset.id);
      const who = m ? (isMine(m) ? T('common.you') : nodeName(m.from)) : T('loc.label');
      showOnMap({ title: `📍 ${T('loc.of', { name: who })}`, numberFrom: 0, points: [{ lat, lon, label: `📍 ${who}`, tag: '📍' }, ...(S.mePos && !(m && isMine(m)) ? [{ me: true, label: T('common.you') }] : [])] });
      return;
    }
    const rr = e.target.closest('[data-route-reset]');
    if (rr) {
      const m = S.msgs.get(rr.dataset.routeReset);
      if (m) resetDmPath(m).then((ok) => ok && toast(T('path.resetOk')));
      return;
    }
    const rm = e.target.closest('[data-route-map]');
    if (rm) {
      const m = S.msgs.get(rm.dataset.routeMap);
      if (m && isMine(m) && m.outRoute?.hops.length) {
        showOnMap({ title: T('out.to', { name: nodeName(m.to) }), numberFrom: 0, points: [
          { me: true, label: T('common.you') },
          ...m.outRoute.hops.map((h) => ({ hash: h.hash, label: relayLabel(h) })),
          { id: m.to, label: nodeName(m.to), tag: '✉' }] });
      } else if (m?.route) {
        showOnMap({ title: T('map.pathFrom', { name: nodeName(m.from) }), numberFrom: 0, points: [
          m.dm ? { id: m.from, label: nodeName(m.from), tag: '✉' } : { name: m.name, label: nodeName(m.from), tag: '✉' },
          ...m.route.hops.map((h) => ({ hash: h.hash, label: relayLabel(h) })),
          { me: true, label: T('common.you') }] });
      }
      return;
    }
    const hb = e.target.closest('[data-heard]');
    if (hb) {
      const id = hb.dataset.heard;
      if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id);
      renderMessages();
      return;
    }
    const chip = e.target.closest('[data-react]');
    if (chip) { sendReaction(chip.dataset.target, chip.dataset.react); return; }
    const q = e.target.closest('[data-jump]');
    if (q) {
      const row = el.querySelector(`[data-id="${CSS.escape(q.dataset.jump)}"]`);
      if (row) { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1200); }
    }
  });
  // Doppeltipp = ❤️ (wie gewohnt in Messengern)
  let lastTap = { id: null, t: 0 };
  el.addEventListener('pointerup', (e) => {
    const b = e.target.closest('.bubble');
    // Nur per Finger/Stift (am PC markiert ein Doppelklick Text) und nie auf Knöpfen, Zitaten oder der Wegliste –
    // eine Reaktion geht ins Mesh und lässt sich nicht zurücknehmen.
    if (!b || !reactionsSupported() || e.pointerType === 'mouse' || Date.now() - swipedAt < 400 || e.target.closest('button, a, .quote, .heard-list')) { lastTap = { id: null, t: 0 }; return; }
    const id = b.closest('.row').dataset.id;
    const now = Date.now();
    if (lastTap.id === id && now - lastTap.t < 300) { lastTap = { id: null, t: 0 }; sendReaction(id, '❤️'); }
    else lastTap = { id, t: now };
  });
}

const ownDmTools = (m) => S.source?.protocol === 'meshcore' && isMine(m) && m.dm && /^mc:[0-9a-f]{64}$/i.test(m.to || '') && !m.reaction;
function openActions(id) {
  const m = S.msgs.get(id);
  if (!m || id.startsWith('tmp-')) return;
  const canReact = canReactTo(m);
  openSheet(`
    ${canReact ? `<div class="emoji-row">${QUICK.map((e) => `<button class="emoji" data-emoji="${e}">${e}</button>`).join('')}<button class="emoji more" data-act="custom" aria-label="${esc(T('actions.otherEmoji'))}">${ICON.plus}</button></div>` : ''}
    <div class="sheet-preview"><b>${esc(isMine(m) ? T('common.you') : nodeName(m.from))}</b> · ${hm(m.ts)}<div>${esc(m.text)}</div></div>
    <button class="sheet-btn" data-act="reply">${T('actions.reply')}</button>
    <button class="sheet-btn" data-act="copy">${T('actions.copy')}</button>
    ${resendInfo(m)?.state === 'ready' ? `<button class="sheet-btn" data-act="resend">${T('actions.resend')}</button>` : ''}
    ${ownDmTools(m) && m.state !== 'delivered' ? `<button class="sheet-btn" data-act="flood">${T('actions.flood')}<small>${T('actions.floodSub')}</small></button>` : ''}
    ${ownDmTools(m) ? `<button class="sheet-btn" data-act="reset">${T('actions.reset')}<small>${T('actions.resetSub')}</small></button>` : ''}
    ${m.dm || isMine(m) ? '' : `<button class="sheet-btn" data-act="dm">${T('actions.dm', { name: esc(nodeName(m.from)) })}</button>`}
    <button class="sheet-btn" data-act="info">${T('actions.details')}</button>
    <button class="sheet-btn cancel" data-close>${T('common.cancel')}</button>`, (e) => {
    const em = e.target.closest('[data-emoji]');
    if (em) { closeSheet(); sendReaction(id, em.dataset.emoji); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'reply') {
      closeSheet();
      startReply(m);
    } else if (act === 'copy') {
      closeSheet();
      navigator.clipboard?.writeText(m.text).then(() => toast(T('actions.copied')), () => toast(T('common.copyFailed')));
    } else if (act === 'dm') {
      closeSheet(); go('chat', `dm:${m.from}`);
    } else if (act === 'resend') {
      closeSheet(); resend(id);
    } else if (act === 'flood') {
      closeSheet(); floodResend(id);
    } else if (act === 'reset') {
      closeSheet(); resetDmPath(m).then((ok) => ok && toast(T('path.resetOk')));
    } else if (act === 'info') {
      openInfo(m);
    } else if (act === 'custom') {
      openCustomEmoji(id);
    }
  });
}

function openCustomEmoji(id) {
  openSheet(`
    <form class="custom-emoji" id="ce"><input id="ce-in" maxlength="16" placeholder="${esc(T('actions.emojiPh'))}" autocomplete="off"><button class="sheet-btn primary" type="submit">${T('common.send')}</button></form>
    <button class="sheet-btn cancel" data-close>${T('common.cancel')}</button>`);
  const inp = $('#ce-in');
  setTimeout(() => inp.focus(), 50);
  $('#ce').onsubmit = (e) => {
    e.preventDefault();
    const raw = inp.value.trim();
    const v = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter().segment(raw)][0]?.segment : [...raw][0];
    closeSheet();
    if (v) sendReaction(id, v);
  };
}

function openInfo(m) {
  const row = (k, v) => (v == null || v === '' ? '' : `<div class="info-row"><span>${k}</span><b>${esc(v)}</b></div>`);
  openSheet(`
    <div class="info">
      ${row(T('pk.rFrom'), `${nodeName(m.from)} (${m.from})`)}
      ${m.dm ? row(T('info.to'), `${nodeName(m.to)} (${m.to})`) : row(T('pk.tChannel'), `${channelName(m.channel)} (${m.channel})`)}
      ${row(T('live.time'), new Date(m.ts).toLocaleString(LOC))}
      ${row('Hops', m.hops)}
      ${row('Scope', msgScope(m) ? `${msgScope(m).text}${m.scope?.code ? ` (Code ${m.scope.code.toString(16)})` : m.scope?.code === 0 ? ` ${T('info.noScope')}` : ''}` : null)}
      ${row(T('info.hashSize'), m.route?.bytes ? T('info.hashPer', { n: m.route.bytes }) : null)}
      ${row('SNR', m.snr)}
      ${row('RSSI', m.rssi)}
      ${row('Status', ({ sent: m.dm ? (Date.now() - m.ts < 10 * 60000 ? T('info.sentWait') : T('info.sentNoAck')) : T('info.sentChannel'), delivered: `${T('info.delivered')}${m.rtt != null ? ` ${T('info.rtt', { s: (m.rtt / 1000).toLocaleString(LOC, { maximumFractionDigits: 1 }) })}` : ''}`, pending: T('info.pending'), failed: T('info.failed') })[m.state] || m.state)}
      ${row(T('info.packetId'), m.packetId)}
      ${isMine(m) && (!m.dm || (m.heard || []).length || (m.heardDirect || []).length) && S.source?.protocol === 'meshcore' ? row(T('info.heardBy'), heardText(m)) : ''}
    </div>
    <button class="sheet-btn cancel" data-close>${T('common.close')}</button>`);
}

export function openOwnNodes() {
  const auto = [...S.otherNames];
  openSheet(`
    <div class="sheet-preview"><b>${T('own.title')}</b><div>${T('own.text', { src: esc(S.source?.name || T('own.mainSource')) })}</div></div>
    ${auto.length ? `<div class="info"><div class="info-row"><span>${T('own.auto')}</span><b>${auto.map(esc).join(', ')}</b></div></div>` : ''}
    <form id="own-form" class="own-form">
      <textarea id="own-in" rows="4" placeholder="${T('own.ph')}">${esc([...S.extraOwn].join('\n'))}</textarea>
      <button class="sheet-btn primary" type="submit">${T('common.save')}</button>
    </form>
    <button class="sheet-btn cancel" data-close>${T('common.cancel')}</button>`);
  $('#own-form').onsubmit = (e) => {
    e.preventDefault();
    const names = $('#own-in').value.split('\n').map((x) => x.trim()).filter(Boolean);
    S.extraOwn = new Set(names); save('extraOwn', names);
    closeSheet(); toast(T('common.saved')); scheduleRender();
  };
}
