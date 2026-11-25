/* MeshLink Chat – Datenmodell: Nachrichten, Nodes, Unterhaltungen, Gelesen-Stand. */

import { LOC, T } from './core/i18n.js';
import { distKm, esc, fmtKm } from './core/util.js';
import { checkVersion, load, S, save } from './core/state.js';
import { api } from './core/api.js';
import { ICON } from './core/icons.js';
import { closeSheet, openSheet } from './ui.js';
import { effectiveScope } from './scope.js';
import { isMuted } from './prefs.js';
import { scheduleRender } from './nav.js';
import { updateCount } from './chat/composer.js';
import { notify } from './push.js';

// ------------------------------------------------------------------ Datenmodell

// Nicht am Namen allein: Kanal-Absender sind nur Text, jeder könnte unter meinem Namen schreiben (eigenes zweites Gerät -> „Eigene Nodes“)
export const isMine = (m) => m.mine === true || (S.me && m.from === S.me) || S.sentIds.has(m.id) || m.local === true;
// Nachricht von einem meiner anderen Nodes (z. B. zweite MeshMonitor-Quelle oder Handy-Companion)
export const isOwnOther = (m) => !isMine(m) && (m.ownOther === true || (m.name && (S.otherNames.has(m.name) || S.extraOwn.has(m.name))));
export const convOf = (m) => (m.dm ? `dm:${isMine(m) ? m.to : m.from}` : `ch:${m.channel ?? 0}`);
export const node = (id) => S.nodes.get(id);
export function nodeName(id) {
  if (!id) return T('common.unknownName');
  if (id.startsWith('name:')) return id.slice(5);
  const n = node(id);
  if (n?.long) return n.long;
  if (S.names.has(id)) return S.names.get(id);
  if (n?.short) return n.short;
  return id.startsWith('mc:') ? id.slice(3, 11) : id;
}
export function shortName(id) {
  const n = node(id);
  if (n?.short && n.short.length <= 4) return n.short;
  const name = nodeName(id).replace(/[^\p{L}\p{N}\s_-]/gu, '').trim();
  const words = name.split(/[\s_-]+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}
export const myName = () => [...S.myNames][0] || (S.me ? nodeName(S.me) : '');
// MeshCore-Erwähnungen @[Name] hervorheben (Text ist bereits escaped)
// Text einer Nachricht: Links klickbar, Koordinaten als Knopf (öffnet die Karte), Erwähnungen hervorgehoben.
// Erst zerlegen, dann jedes Stück einzeln escapen – so kann nichts aus dem Text als HTML durchrutschen.
const TOKEN_RE = /(https?:\/\/[^\s<>"']+)|(-?\d{1,2}\.\d{3,7})\s*[,;]\s*(-?\d{1,3}\.\d{3,7})/g;
function renderMentions(t) {
  const me = myName();
  return esc(t).replace(/@\[([^\]]{1,40})\]/g, (_, n) => `<span class="mention ${me && n === esc(me) ? 'mention-me' : ''}">@${n}</span>`);
}
export function renderText(text) {
  let out = ''; let last = 0;
  for (const m of String(text).matchAll(TOKEN_RE)) {
    let [all, url, la, lo] = m;
    if (url) {
      const trail = /[.,;:!?)\]]+$/.exec(url)?.[0] || ''; // Satzzeichen am Ende gehören nicht zum Link
      url = url.slice(0, url.length - trail.length);
      out += renderMentions(text.slice(last, m.index)) + `<a class="msg-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url.replace(/^https?:\/\//, ''))}</a>`;
      last = m.index + url.length;
      continue;
    }
    const lat = Number(la); const lon = Number(lo);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) continue;
    const d = S.mePos ? ` · ${fmtKm(distKm({ lat: S.mePos[0], lon: S.mePos[1] }, { lat, lon }))}` : '';
    out += renderMentions(text.slice(last, m.index).replace(/📍\s*$/u, '')) + `<button class="geo" data-geo="${lat},${lon}" title="${esc(T('chat.showOnMap'))}">📍 ${esc(la)}, ${esc(lo)}${d}</button>`;
    last = m.index + all.length;
  }
  return out + renderMentions(text.slice(last));
}
export const mentionsMe = (m) => { const me = myName(); return Boolean(me) && m.text.includes(`@[${me}]`); };
export const ECHO_WINDOW_MS = 60000;
export const relayLabel = (r) => r.name || `#${r.hash}`;
// Ab wann Echos einer eigenen Nachricht kommen können: Senden bzw. das letzte Resend (der Server sucht dann wieder 1 Min.)
export const echoSince = (m) => Math.max(m.ts, S.resends?.get(m.id)?.at || 0);
// ------------------------------------------------------------------ Unterhaltungen
export const channelScope = (idx) => S.channels.find((c) => c.index === idx)?.scope || null;
export const channelName = (idx) => S.channels.find((c) => c.index === idx)?.name || (idx === 0 ? T('channel.primary') : T('channel.n', { i: idx }));
export function convTitle(key) {
  return key.startsWith('dm:') ? nodeName(key.slice(3)) : channelName(Number(key.slice(3)));
}
export const targetOf = (m) => (m.replyId != null ? S.msgs.get(S.byPacket.get(String(m.replyId))) || (S.source?.protocol === 'meshcore' ? S.msgs.get(String(m.replyId)) : null) : null);
// Grenzen kommen vom Server (je nach MeshMonitor-Version und eigenem Node-Namen); sonst die alten, strengen Werte
export function maxBytes(key) {
  if (S.source?.protocol !== 'meshcore') return 200;
  const c = S.caps || { dm: 150, channel: 130, scoped: 120 };
  if (key.startsWith('dm:')) return c.dm;
  return effectiveScope(Number(key.slice(3))).scope ? c.scoped : c.channel;
}

// ------------------------------------------------------------------ Reaktionen
export const reactionsSupported = () => Boolean(S.source);
// Meshtastic reagiert über die Paket-ID, MeshCore über die Nachrichten-ID von MeshMonitor
export const canReactTo = (m) => Boolean(m && !m.reaction && !m.id.startsWith('tmp-') && (S.source?.protocol === 'meshcore' || m.packetId));

// ------------------------------------------------------------------ Daten vom Server übernehmen
export function applyMeta(meta) {
  checkVersion(meta.appVersion);
  if (meta.source) {
    if (S.source?.id !== meta.source.id || !S.readBy) useReadFor(meta.source.id);
    S.source = meta.source;
  }
  if (meta.me) S.me = meta.me;
  if (meta.myNames) S.myNames = new Set(meta.myNames);
  if (meta.otherNames) S.otherNames = new Set(meta.otherNames);
  if (meta.otherSources) S.otherSources = meta.otherSources;
  if (meta.sources) S.sources = meta.sources;
  if (meta.nodes) S.nodes = new Map(meta.nodes.map((n) => [n.id, n]));
  if (meta.channels) S.channels = meta.channels;
  if ('mePos' in meta) S.mePos = meta.mePos;
  if (meta.version) S.version = meta.version;
  if (meta.caps) { S.caps = meta.caps; updateCount(); }
  if ('admin' in meta) S.admin = Boolean(meta.admin);
  scheduleRender();
}

export function ingest(list, initial = false) {
  const fresh = [];
  for (const m of list) {
    const isNew = !S.msgs.has(m.id);
    S.msgs.set(m.id, m);
    if (m.packetId) S.byPacket.set(String(m.packetId), m.id);
    if (m.name && m.from && !m.from.startsWith('name:')) S.names.set(m.from, m.name);
    if (isNew) {
      resolvePending(m);
      if (!initial) fresh.push(m);
    }
  }
  if (fresh.length) notify(fresh);
  // Optimistische Kopien, deren Original nie zugeordnet werden konnte, nach 3 Min. entfernen (sonst doppelt)
  for (const [tid, t] of S.pending) {
    const tmp = S.msgs.get(tid);
    if (!tmp || (tmp.state === 'sent' && Date.now() - t.ts > 180000)) { S.pending.delete(tid); S.msgs.delete(tid); }
  }
  if (S.msgs.size > 4000) {
    const old = [...S.msgs.values()].filter((m) => !m.id.startsWith('tmp-')).sort((a, b) => a.ts - b.ts).slice(0, S.msgs.size - 3000);
    for (const m of old) { S.msgs.delete(m.id); if (m.packetId) S.byPacket.delete(String(m.packetId)); }
  }
  scheduleRender();
}

// Optimistische Nachrichten entfernen, sobald die echte eintrifft
function resolvePending(m) {
  if (m.id.startsWith('tmp-')) return;
  for (const [tid, t] of S.pending) {
    if ((S.sentIds.has(m.id) || isMine(m)) && m.text === t.text && convOf(m) === t.conv && m.ts >= t.ts - 120000) {
      S.sentIds.add(m.id);
      S.pending.delete(tid);
      S.msgs.delete(tid);
      return;
    }
  }
}

export function conversations() {
  const map = new Map();
  for (const c of S.channels) map.set(`ch:${c.index}`, { key: `ch:${c.index}`, last: null, unread: 0, count: 0 });
  const lr = S.lastRead || {};
  for (const m of S.msgs.values()) {
    if (m.reaction) continue;
    const k = convOf(m);
    if (k === 'dm:' || k === 'dm:null') continue;
    let c = map.get(k);
    if (!c) map.set(k, (c = { key: k, last: null, unread: 0, count: 0 }));
    if (!c.last || m.ts > c.last.ts) c.last = m;
    c.count++;
    if (!isMine(m) && !isOwnOther(m) && m.ts > (lr[k] || 0)) c.unread++;
  }
  for (const c of map.values()) if (isMuted(c.key)) { c.muted = true; c.unread = 0; }
  const all = [...map.values()];
  return {
    channels: all.filter((c) => c.key.startsWith('ch:')).sort(channelOrder()),
    dms: all.filter((c) => c.key.startsWith('dm:')).sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0)),
  };
}

// Reihenfolge der Kanäle in der Liste: eigene Wahl je Gerät (nur eine Anzeige-Einstellung im Browser)
const CH_SORTS = ['device', 'recent', 'most', 'alpha'];
export const chSortLabel = (k) => ({ device: T('list.sortDevice'), recent: T('list.sortRecent'), most: T('list.sortMost'), alpha: T('list.sortAlpha') })[k];
export const chSort = () => (CH_SORTS.includes(S.chSort) ? S.chSort : 'device');
function channelOrder() {
  const idx = (c) => Number(c.key.slice(3));
  const byIdx = (a, b) => idx(a) - idx(b);
  const recent = (a, b) => (b.last?.ts || 0) - (a.last?.ts || 0) || byIdx(a, b);
  const name = (c) => convTitle(c.key).replace(/^#/, '');
  return {
    device: byIdx,
    recent,
    most: (a, b) => b.count - a.count || recent(a, b),
    alpha: (a, b) => name(a).localeCompare(name(b), LOC, { sensitivity: 'base', numeric: true }) || byIdx(a, b),
  }[chSort()];
}
export function openChannelSort() {
  const cur = chSort();
  openSheet(`
    <div class="sheet-title">${T('list.sortTitle')}</div>
    ${CH_SORTS.map((k) => `<button class="sheet-btn scope-opt ${k === cur ? 'active' : ''}" data-sort="${k}"><span>${esc(chSortLabel(k))}${k === 'most' ? `<small>${esc(T('list.sortMostSub'))}</small>` : ''}</span>${k === cur ? `<i>${ICON.check}</i>` : ''}</button>`).join('')}
    <button class="sheet-btn cancel" data-close>${T('common.close')}</button>`, (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    S.chSort = b.dataset.sort;
    save('chSort', S.chSort);
    closeSheet();
    scheduleRender();
  });
}

// Gelesen-Stand der Quelle wählen. Der alte, gemeinsame Stand (vor 1.4.2) geht einmalig an die erste Quelle.
function useReadFor(src) {
  if (!S.readBy) {
    S.readBy = {};
    const old = load('lastRead', null);
    if (old) S.readBy[src] = old;
    save('readBy', S.readBy);
    try { localStorage.removeItem('mc.lastRead'); } catch { /* egal */ }
  }
  S.readFresh = !S.readBy[src]; // Quelle zum ersten Mal auf diesem Gerät -> Verlauf gilt als gelesen (siehe readHistoryIfFresh)
  S.lastRead = S.readBy[src] || null;
}
export function saveRead() {
  if (!S.source) return;
  S.readBy = { ...(S.readBy || {}), [S.source.id]: S.lastRead || {} };
  save('readBy', S.readBy);
}
// Erster Start bzw. neue Quelle: Verlauf nicht als ungelesen markieren (außer ein anderes Gerät weiß es besser)
export function readHistoryIfFresh() {
  if (!S.readFresh) return;
  S.readFresh = false;
  const lr = { ...(S.lastRead || {}) };
  for (const m of S.msgs.values()) { const k = convOf(m); if (!(k in lr)) lr[k] = Date.now(); }
  S.lastRead = lr;
  saveRead();
}

export function markRead(key) {
  if (!key || document.hidden) return;
  const old = (S.lastRead || {})[key] || 0;
  let max = 0;
  let had = !old;
  for (const m of S.msgs.values()) {
    if (convOf(m) !== key) continue;
    if (m.ts > max) max = m.ts;
    if (m.ts > old && !isMine(m)) had = true;
  }
  const ts = Math.max(max, Date.now());
  S.lastRead = { ...(S.lastRead || {}), [key]: ts };
  saveRead();
  if (had) shareRead({ [key]: ts }); // nur wenn wirklich etwas Neues gelesen wurde
  updateBadge();
}
// Gelesen-Stand mit den anderen Geräten abgleichen (der Server hält ihn nur im Speicher)
export function shareRead(read) { api('/api/read', { method: 'POST', body: { read } }).catch(() => {}); }
export function mergeRead(read) {
  const lr = { ...(S.lastRead || {}) };
  let changed = false;
  for (const [k, v] of Object.entries(read || {})) if (v > (lr[k] || 0)) { lr[k] = v; changed = true; }
  if (!changed) return;
  S.lastRead = lr; saveRead();
  scheduleRender();
}

export function updateBadge() {
  if (!('setAppBadge' in navigator)) return;
  const { channels, dms } = conversations();
  const n = [...channels, ...dms].reduce((s, c) => s + c.unread, 0);
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}
