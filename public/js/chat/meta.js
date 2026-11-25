/* MeshLink Chat – Anzeige unter der Nachricht (Scope, Weg, Echos) und Resend. */

import { T } from '../core/i18n.js';
import { esc } from '../core/util.js';
import { S } from '../core/state.js';
import { api } from '../core/api.js';
import { toast } from '../ui.js';
import { ECHO_WINDOW_MS, echoSince, isMine, isOwnOther, nodeName, relayLabel } from '../data.js';
import { scheduleRender } from '../nav.js';
import { sendText } from './composer.js';

// ------------------------------------------------------------------ Anzeige unter der Nachricht: Scope, Weg, Repeater-Echos
// Scope/Region, mit der eine Nachricht gesendet wurde: Name, sonst Kurzcode; 🌐 = ohne Scope
export function msgScope(m) {
  const sc = m.scope;
  if (!sc) return null;
  if (sc.name) return { text: `🔒 ${sc.name}`, title: T('scope.sentWith', { name: sc.name }) };
  if (sc.code === 0) return { text: '🌐', title: T('scope.sentWithout') };
  if (sc.code > 0) return { text: `🔒 #${sc.code.toString(16)}`, title: T('scope.sentUnknown') };
  return null;
}
export function scopeTag(m) {
  const sc = msgScope(m);
  return sc ? `<span class="msg-scope" title="${esc(sc.title)}">${esc(sc.text)}</span>` : '';
}
// Empfangene Nachricht: Weg vom Absender zu uns (Repeater-Kennungen aus dem Paket)
function routeBadge(m) {
  const r = m.route;
  if (!r) return (m.hops != null ? `<span class="hops">${m.hops}↯</span>` : '') + scopeTag(m);
  const n = r.hops.length;
  const fixed = !n && r.route === 'DIRECT';
  const title = n ? T('route.viaTitle', { n, bytes: r.bytes || '?' }) : fixed ? T('route.fixedTitle') : T('route.directTitle');
  return `<button class="heard route" data-heard="${esc(m.id)}" title="${esc(title)}" aria-expanded="${S.expanded.has(m.id)}">↳ ${n ? `${T('common.hops', { n })}${r.bytes ? ` · ${r.bytes}B` : ''}` : fixed ? T('route.fixedShort') : T('common.direct')}</button>${scopeTag(m)}`;
}
function routeList(m) {
  const r = m.route;
  if (!r) return '';
  const rows = r.hops.map((h, i) => `<div class="heard-row"><span class="heard-hop">${i + 1}</span><span class="heard-name">${esc(relayLabel(h))}${h.name ? `<small>${esc(h.hash)}</small>` : ''}</span></div>`).join('');
  const end = (label) => `<div class="heard-row route-end"><span class="heard-hop">•</span><span class="heard-name">${esc(label)}</span></div>`;
  const direct = !r.hops.length ? `<div class="heard-empty">${r.route === 'DIRECT' ? T('route.fixedNote') : T('route.directNote')}</div>` : '';
  return `<div class="heard-list">
    <div class="heard-head">${T('route.toYou')}${r.bytes ? ` · ${T('route.hashBytes', { n: r.bytes })}` : ''}${msgScope(m) ? ` · Scope ${esc(msgScope(m).text)}` : ''}</div>
    ${end(nodeName(m.from))}${rows}${direct}${end(T('common.you'))}
    ${r.hops.length ? `<button class="route-map" data-route-map="${esc(m.id)}">${T('route.showMap')}</button>` : ''}
  </div>`;
}
// ------------------------------------------------------------------ Resend
// "Nochmal senden": echtes Resend über MeshMonitor – gleiche Bytes und gleicher Zeitstempel,
// wer die Nachricht schon hat, verwirft die Kopie. MeshMonitor prüft die Grenzen selbst
// (max. 3×, 30 s Abstand, höchstens 1 Std. alt); die App zeigt den Knopf nur, wenn es passt.
const RESEND_MAX = 3;
export const RESEND_COOLDOWN_MS = 30000;
const RESEND_MAX_AGE_MS = 3600000;
S.resends = new Map(); // msgId -> {n, t} (nur im Speicher)
export function resendInfo(m) {
  if (S.source?.protocol !== 'meshcore' || !isMine(m) || m.reaction || m.id.startsWith('tmp-')) return null;
  const now = Date.now();
  if (now - m.ts > RESEND_MAX_AGE_MS) return null;
  if ((m.dm && m.state === 'delivered') || (m.heard || []).length > 0) return null; // MeshMonitor lehnt beides ab
  const r = S.resends.get(m.id) || { n: 0, t: m.ts };
  if (r.n >= RESEND_MAX) return { state: 'max', tries: r.n };
  if (now - r.t < RESEND_COOLDOWN_MS || r.busy) return { state: 'wait', tries: r.n };
  return { state: 'ready', tries: r.n };
}
export function resendButton(m) {
  const r = resendInfo(m);
  return r?.state === 'ready' ? `<button class="resend" data-resend="${esc(m.id)}" title="${esc(T('resend.title'))}">${T('resend.button')}</button>` : '';
}
export async function resend(id) {
  const m = S.msgs.get(id);
  const info = m && resendInfo(m);
  if (info?.state !== 'ready') { toast(info?.state === 'max' ? T('resend.max', { n: RESEND_MAX }) : T('resend.notNow')); return; }
  const r = { n: info.tries, t: Date.now(), busy: true };
  S.resends.set(id, r); scheduleRender();
  try {
    const res = await api('/api/resend', { method: 'POST', body: { id } });
    r.n = res.resendCount ?? r.n + 1;
    r.at = Date.now();
    toast(T('resend.done', { n: r.n, max: RESEND_MAX }));
    setTimeout(scheduleRender, ECHO_WINDOW_MS + 500); // „…“ wieder zur Zahl werden lassen
  } catch (e) {
    const why = { ALREADY_HEARD: T('resend.whyHeard'), ALREADY_DELIVERED: T('resend.whyDelivered'), RESEND_TOO_OLD: T('resend.whyOld'), MESSAGE_NOT_FOUND: T('resend.whyUnknown'), NOT_OWN_MESSAGE: T('resend.whyNotOwn') }[e.code];
    toast(e.status === 403 ? T('common.noSendPerm') : e.code === 'TX_DISABLED' ? T('common.txDisabled') : T('resend.failed', { why: why || e.message }));
    if (why) r.n = RESEND_MAX; // dauerhaft nicht möglich -> Knopf ausblenden
  }
  r.busy = false; r.t = Date.now();
  scheduleRender();
  setTimeout(scheduleRender, RESEND_COOLDOWN_MS + 500);
}

// Eigene Kanalnachricht (und eigene DM, sobald MeshMonitor Repeater kennt): von welchen Repeatern hörbar weitergesendet (📡)
export function heardBadge(m) {
  if (!isMine(m) && !isOwnOther(m) && S.source?.protocol === 'meshcore') return routeBadge(m);
  if (S.source?.protocol !== 'meshcore' || !isMine(m) || m.id.startsWith('tmp-')) return '';
  const n = (m.heard || []).length;
  if (m.dm && !n) {
    // DM ohne gehörte Repeater: nach der Zustellung den Weg zum Empfänger zeigen (sonst nichts – stört nur)
    const o = m.outRoute;
    if (!o) return '';
    const k = o.hops.length;
    return `<button class="heard route" data-heard="${esc(m.id)}" title="${esc(T('heard.outTitle'))}" aria-expanded="${S.expanded.has(m.id)}">↪ ${k ? T('common.hops', { n: k }) : o.flood ? 'Flood' : T('common.direct')}</button>`;
  }
  const waiting = !n && Date.now() - echoSince(m) < ECHO_WINDOW_MS;
  const title = n ? T('heard.byTitle', { n }) : waiting ? T('heard.waiting') : T('heard.none');
  return `<button class="heard ${n ? '' : 'heard-none'} ${waiting ? 'heard-wait' : ''}" data-heard="${esc(m.id)}" title="${esc(title)}" aria-expanded="${S.expanded.has(m.id)}">📡 ${waiting ? '…' : n}</button>`;
}
export function heardList(m) {
  if (!S.expanded.has(m.id)) return '';
  if (!isMine(m)) return routeList(m);
  const list = m.heard || [];
  const out = m.dm ? outRouteList(m) : '';
  if (!list.length && out) return out;
  if (!list.length) return `<div class="heard-list"><div class="heard-empty">${Date.now() - echoSince(m) < ECHO_WINDOW_MS ? T('heard.waiting') : T('heard.noneLong')}</div></div>`;
  return `${out}<div class="heard-list">
    <div class="heard-head">${T('heard.via', { n: list.length })}</div>
    ${list.map((r) => `<div class="heard-row"><span class="heard-hop" title="${esc(T('heard.posTitle'))}">${r.hops}</span><span class="heard-name">${esc(relayLabel(r))}${r.name ? `<small>${esc(r.hash)}</small>` : ''}</span><span class="heard-snr">${r.snr != null ? `SNR ${esc(r.snr)}` : r.hops === 1 ? T('common.direct') : ''}</span></div>`).join('')}
  </div>`;
}
// Zugestellte eigene DM: Weg zum Empfänger, wie ihn der Empfänger mit der Bestätigung zurückgemeldet hat
function outRouteList(m) {
  const o = m.outRoute;
  if (!o) return '';
  const to = nodeName(m.to);
  const end = (label) => `<div class="heard-row route-end"><span class="heard-hop">•</span><span class="heard-name">${esc(label)}</span></div>`;
  const rows = o.hops.map((h, i) => `<div class="heard-row"><span class="heard-hop">${i + 1}</span><span class="heard-name">${esc(relayLabel(h))}${h.name ? `<small>${esc(h.hash)}</small>` : ''}</span></div>`).join('');
  const note = o.hops.length ? '' : `<div class="heard-empty">${o.flood ? T('out.floodNote') : T('out.directNote')}</div>`;
  return `<div class="heard-list">
    <div class="heard-head">${T('out.to', { name: esc(to) })}${o.bytes ? ` · ${T('route.hashBytes', { n: o.bytes })}` : ''}</div>
    ${end(T('common.you'))}${rows}${note}${end(to)}
    <div class="heard-empty">${T('out.reported', { name: esc(to) })}</div>
    ${o.hops.length ? `<button class="route-map" data-route-map="${esc(m.id)}">${T('route.showMap')}</button>` : ''}
    ${o.hops.length ? `<button class="route-map" data-route-reset="${esc(m.id)}">${T('out.reset')}</button>` : ''}
  </div>`;
}
// Pfad zum Empfänger einer DM zurücksetzen (wie auf der Node-Seite); danach geht die nächste DM per Flood
export async function resetDmPath(m) {
  try {
    await api('/api/node/reset-path', { method: 'POST', body: { id: m.to } });
    return true;
  } catch (e) {
    toast(e.status === 403 ? T('common.noPerm', { perm: 'nodes:write' }) : T('path.resetFailed', { msg: e.message }));
    return false;
  }
}
export async function floodResend(id) {
  const m = S.msgs.get(id);
  if (!m || !m.dm || S.conv !== `dm:${m.to}`) return;
  if (!(await resetDmPath(m))) return;
  toast(T('path.resetFlooding'));
  await sendText(m.text);
}
