'use strict';
/* MeshLink Chat Frontend – Vanilla JS, keine Abhängigkeiten. */

const $ = (s, el = document) => el.querySelector(s);

// ------------------------------------------------------------------ Sprache
// Der Server bettet das Wörterbuch der gewählten Sprache in die Seite ein (public/i18n/<code>.json, schon mit
// Englisch/Deutsch aufgefüllt). T(schlüssel, { name: … }) liefert den Text; {name} wird ersetzt, Mehrzahl über { n }.
// Platzhalter werden NICHT escaped – in HTML also esc(…) übergeben.
const I18N = (() => { try { return JSON.parse(document.getElementById('i18n').textContent); } catch { return {}; } })();
const LANG = I18N.lang || document.documentElement.lang || 'en';
const DICT = I18N.dict || {};
// Zahlen- und Datumsformat: passende Browser-Variante (z. B. de-AT, en-US), sonst die aus der Sprachdatei
const LOC = (() => {
  const want = (navigator.languages || []).find((l) => l.toLowerCase().split('-')[0] === LANG.split('-')[0]);
  for (const l of [want, DICT._meta?.locale, LANG]) { try { if (l) return Intl.getCanonicalLocales(l)[0]; } catch { /* nächste */ } }
  return 'en';
})();
const PLURAL = new Intl.PluralRules(LOC);
function T(key, p = {}) {
  let v = DICT[key];
  if (v == null) return key;
  if (typeof v === 'object') v = v[PLURAL.select(Number(p.n) || 0)] ?? v.other ?? '';
  return String(v).replace(/\{(\w+)\}/g, (all, k) => (p[k] == null ? all : String(p[k])));
}
// Eigene Wahl als Cookie (liest der Server beim Laden der Seite); null = wie der Browser
function setLanguage(code) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = code ? `ml_lang=${encodeURIComponent(code)}; Path=/; Max-Age=31536000; SameSite=Strict${secure}` : `ml_lang=; Path=/; Max-Age=0; SameSite=Strict${secure}`;
  location.reload();
}
const ownLanguage = () => /(?:^|;\s*)ml_lang=([^;]+)/.exec(document.cookie)?.[1] || null;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '✅'];
const enc = new TextEncoder();
// Eigene Version (aus der Script-URL). Weicht die Server-Version ab, wurde neu ausgerollt -> neu laden.
const APP_VERSION = (() => { try { return new URL(document.currentScript.src).searchParams.get('v'); } catch { return null; } })();
function checkVersion(v) {
  if (!v || v === APP_VERSION) return;
  let last = null;
  try { last = sessionStorage.getItem('mc.reloadedFor'); sessionStorage.setItem('mc.reloadedFor', v); } catch { /* egal */ }
  if (last !== v) location.reload();
}

function load(k, d) { try { const v = localStorage.getItem('mc.' + k); return v ? JSON.parse(v) : d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem('mc.' + k, JSON.stringify(v)); } catch { /* egal */ } }

const S = {
  me: '', source: null, nodes: new Map(), channels: [],
  msgs: new Map(), byPacket: new Map(), names: new Map(), myNames: new Set(), otherNames: new Set(), otherSources: [],
  extraOwn: new Set(load('extraOwn', [])),
  expanded: new Set(),
  connected: false, error: null, sse: false,
  view: 'boot', conv: null, replyTo: null,
  sentIds: new Set(), pending: new Map(),
  lastRead: null, // Gelesen-Stand der aktuellen Quelle: {chat: ms}
  readBy: load('readBy', null), // je Quelle: {quelle: {chat: ms}} – Kanalnummern gibt es in jeder Quelle
  chSort: load('chSort', 'device'), // Reihenfolge der Kanäle (nur dieses Gerät)
  notify: load('notify', false),
  es: null, booted: false, tmpSeq: 0,
};

// ------------------------------------------------------------------ API

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = {};
  try { j = await res.json(); } catch { /* leer */ }
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw Object.assign(new Error(T('common.notLoggedIn')), { status: 401 }); }
  if (!res.ok) throw Object.assign(new Error(j.error || T('common.errorStatus', { status: res.status })), { status: res.status, code: j.code || null, retryAfter: j.retryAfter ?? null });
  return j;
}

// ------------------------------------------------------------------ Datenmodell

// Nicht am Namen allein: Kanal-Absender sind nur Text, jeder könnte unter meinem Namen schreiben (eigenes zweites Gerät -> „Eigene Nodes“)
const isMine = (m) => m.mine === true || (S.me && m.from === S.me) || S.sentIds.has(m.id) || m.local === true;
// Nachricht von einem meiner anderen Nodes (z. B. zweite MeshMonitor-Quelle oder Handy-Companion)
const isOwnOther = (m) => !isMine(m) && (m.ownOther === true || (m.name && (S.otherNames.has(m.name) || S.extraOwn.has(m.name))));
const convOf = (m) => (m.dm ? `dm:${isMine(m) ? m.to : m.from}` : `ch:${m.channel ?? 0}`);
const node = (id) => S.nodes.get(id);
function nodeName(id) {
  if (!id) return T('common.unknownName');
  if (id.startsWith('name:')) return id.slice(5);
  const n = node(id);
  if (n?.long) return n.long;
  if (S.names.has(id)) return S.names.get(id);
  if (n?.short) return n.short;
  return id.startsWith('mc:') ? id.slice(3, 11) : id;
}
function shortName(id) {
  const n = node(id);
  if (n?.short && n.short.length <= 4) return n.short;
  const name = nodeName(id).replace(/[^\p{L}\p{N}\s_-]/gu, '').trim();
  const words = name.split(/[\s_-]+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}
const myName = () => [...S.myNames][0] || (S.me ? nodeName(S.me) : '');
// MeshCore-Erwähnungen @[Name] hervorheben (Text ist bereits escaped)
// Text einer Nachricht: Links klickbar, Koordinaten als Knopf (öffnet die Karte), Erwähnungen hervorgehoben.
// Erst zerlegen, dann jedes Stück einzeln escapen – so kann nichts aus dem Text als HTML durchrutschen.
const TOKEN_RE = /(https?:\/\/[^\s<>"']+)|(-?\d{1,2}\.\d{3,7})\s*[,;]\s*(-?\d{1,3}\.\d{3,7})/g;
function renderMentions(t) {
  const me = myName();
  return esc(t).replace(/@\[([^\]]{1,40})\]/g, (_, n) => `<span class="mention ${me && n === esc(me) ? 'mention-me' : ''}">@${n}</span>`);
}
function renderText(text) {
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
const mentionsMe = (m) => { const me = myName(); return Boolean(me) && m.text.includes(`@[${me}]`); };
const ECHO_WINDOW_MS = 60000;
const relayLabel = (r) => r.name || `#${r.hash}`;
// Ab wann Echos einer eigenen Nachricht kommen können: Senden bzw. das letzte Resend (der Server sucht dann wieder 1 Min.)
const echoSince = (m) => Math.max(m.ts, S.resends?.get(m.id)?.at || 0);

// ------------------------------------------------------------------ Anzeige unter der Nachricht: Scope, Weg, Repeater-Echos
// Scope/Region, mit der eine Nachricht gesendet wurde: Name, sonst Kurzcode; 🌐 = ohne Scope
function msgScope(m) {
  const sc = m.scope;
  if (!sc) return null;
  if (sc.name) return { text: `🔒 ${sc.name}`, title: T('scope.sentWith', { name: sc.name }) };
  if (sc.code === 0) return { text: '🌐', title: T('scope.sentWithout') };
  if (sc.code > 0) return { text: `🔒 #${sc.code.toString(16)}`, title: T('scope.sentUnknown') };
  return null;
}
function scopeTag(m) {
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
const RESEND_COOLDOWN_MS = 30000;
const RESEND_MAX_AGE_MS = 3600000;
S.resends = new Map(); // msgId -> {n, t} (nur im Speicher)
function resendInfo(m) {
  if (S.source?.protocol !== 'meshcore' || !isMine(m) || m.reaction || m.id.startsWith('tmp-')) return null;
  const now = Date.now();
  if (now - m.ts > RESEND_MAX_AGE_MS) return null;
  if ((m.dm && m.state === 'delivered') || (m.heard || []).length > 0) return null; // MeshMonitor lehnt beides ab
  const r = S.resends.get(m.id) || { n: 0, t: m.ts };
  if (r.n >= RESEND_MAX) return { state: 'max', tries: r.n };
  if (now - r.t < RESEND_COOLDOWN_MS || r.busy) return { state: 'wait', tries: r.n };
  return { state: 'ready', tries: r.n };
}
function resendButton(m) {
  const r = resendInfo(m);
  return r?.state === 'ready' ? `<button class="resend" data-resend="${esc(m.id)}" title="${esc(T('resend.title'))}">${T('resend.button')}</button>` : '';
}
async function resend(id) {
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
function heardBadge(m) {
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
function heardList(m) {
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
async function resetDmPath(m) {
  try {
    await api('/api/node/reset-path', { method: 'POST', body: { id: m.to } });
    return true;
  } catch (e) {
    toast(e.status === 403 ? T('common.noPerm', { perm: 'nodes:write' }) : T('path.resetFailed', { msg: e.message }));
    return false;
  }
}
async function floodResend(id) {
  const m = S.msgs.get(id);
  if (!m || !m.dm || S.conv !== `dm:${m.to}`) return;
  if (!(await resetDmPath(m))) return;
  toast(T('path.resetFlooding'));
  await sendText(m.text);
}
// ------------------------------------------------------------------ Unterhaltungen
const channelScope = (idx) => S.channels.find((c) => c.index === idx)?.scope || null;
const channelName = (idx) => S.channels.find((c) => c.index === idx)?.name || (idx === 0 ? T('channel.primary') : T('channel.n', { i: idx }));
function convTitle(key) {
  return key.startsWith('dm:') ? nodeName(key.slice(3)) : channelName(Number(key.slice(3)));
}
const targetOf = (m) => (m.replyId != null ? S.msgs.get(S.byPacket.get(String(m.replyId))) || (S.source?.protocol === 'meshcore' ? S.msgs.get(String(m.replyId)) : null) : null);
// Grenzen kommen vom Server (je nach MeshMonitor-Version und eigenem Node-Namen); sonst die alten, strengen Werte
function maxBytes(key) {
  if (S.source?.protocol !== 'meshcore') return 200;
  const c = S.caps || { dm: 150, channel: 130, scoped: 120 };
  if (key.startsWith('dm:')) return c.dm;
  return effectiveScope(Number(key.slice(3))).scope ? c.scoped : c.channel;
}

// ------------------------------------------------------------------ Scope (Region) je Kanal
// Eigene Wahl gilt nur für Nachrichten aus dieser App, auf diesem Gerät; MeshMonitor bleibt unverändert.
S.scopeOverride = load('scopeOverride', {});
const scopeKey = (idx) => `${S.source?.id || ''}:${idx}`;
function effectiveScope(idx) {
  const own = S.scopeOverride[scopeKey(idx)];
  if (typeof own === 'string') return { scope: own, from: 'own' };
  const ch = channelScope(idx);
  if (ch) return { scope: ch, from: 'channel' };
  const def = S.scopeInfo?.defaultScope;
  if (def) return { scope: def, from: 'default' };
  return { scope: '', from: S.scopeInfo?.readable ? 'none' : 'unknown' };
}
function scopeLabel(idx, long = false) {
  const e = effectiveScope(idx);
  if (e.from === 'unknown') return long ? T('scope.sourceDefaultLong') : T('scope.defaultShort');
  const base = e.scope ? `🔒 ${e.scope}` : T('scope.none');
  if (!long) return base;
  return `${base}${e.from === 'own' ? ` · ${T('scope.own')}` : e.from === 'default' ? ` · ${T('scope.sourceDefault')}` : ''}`;
}
async function loadScopes() {
  if (S.source?.protocol !== 'meshcore') return;
  try { S.scopeInfo = await api('/api/scopes'); scheduleRender(); } catch { /* egal */ }
}

function openScopePicker(idx) {
  const cur = S.scopeOverride[scopeKey(idx)];
  const ch = channelScope(idx);
  const def = S.scopeInfo?.defaultScope;
  const known = [...new Set([...(S.scopeInfo?.regions || []), ...S.channels.map((c) => c.scope).filter(Boolean), def].filter(Boolean))].sort((a, b) => a.localeCompare(b, LOC));
  const opt = (val, label, sub = '') => {
    const active = val === null ? typeof cur !== 'string' : cur === val;
    return `<button class="sheet-btn scope-opt ${active ? 'active' : ''}" data-scope="${val === null ? '__inherit' : esc(val)}"><span>${label}${sub ? `<small>${sub}</small>` : ''}</span>${active ? `<i>${ICON.check}</i>` : ''}</button>`;
  };
  openSheet(`
    <div class="sheet-title">${T('scope.title', { name: esc(channelName(idx)) })}</div>
    ${opt(null, T('scope.inherit'), ch ? T('scope.inheritChannel', { scope: esc(ch) }) : def ? T('scope.inheritDefault', { scope: esc(def) }) : T('scope.inheritNone'))}
    ${opt('', T('scope.optNone'), T('scope.optNoneSub'))}
    ${known.map((r) => opt(r, `🔒 ${esc(r)}`)).join('')}
    <form class="custom-emoji" id="scope-form"><input id="scope-in" maxlength="63" placeholder="${esc(T('scope.customPh'))}" autocomplete="off" autocapitalize="off"><button class="sheet-btn primary" type="submit">${T('common.apply')}</button></form>
    <div class="hint">${T('scope.hint')}</div>
    <button class="sheet-btn cancel" data-close>${T('common.close')}</button>`, (e) => {
    const b = e.target.closest('[data-scope]');
    if (!b) return;
    setScope(idx, b.dataset.scope === '__inherit' ? null : b.dataset.scope);
  });
  $('#scope-form').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#scope-in').value.trim().replace(/^#/, '').replace(/[^0-9A-Za-z-]/g, '');
    if (v) setScope(idx, v);
  };
}
function setScope(idx, val) {
  const o = { ...S.scopeOverride };
  if (val === null) delete o[scopeKey(idx)]; else o[scopeKey(idx)] = val;
  S.scopeOverride = o; save('scopeOverride', o);
  closeSheet();
  toast(T('scope.sendingWith', { label: scopeLabel(idx) }));
  scheduleRender();
}
// ------------------------------------------------------------------ Benachrichtigung je Chat (pro Gerät)
// 'all' = jede Nachricht melden (Kanäle), 'mute' = stumm: kein Zähler, kein Hinweis, kein Push. Ohne Eintrag: Standard.
S.convPrefs = load('convPrefs', {});
const prefKey = (key) => `${S.source?.id || ''}|${key}`;
const convPref = (key) => S.convPrefs[prefKey(key)] || null;
const isMuted = (key) => convPref(key) === 'mute';
function openConvPrefs(key) {
  const cur = convPref(key);
  const isCh = key.startsWith('ch:');
  const pushOn = Boolean(S.pushEndpoint);
  const opt = (val, label, sub) => `<button class="sheet-btn scope-opt ${cur === val ? 'active' : ''}" data-pref="${val || 'std'}"><span>${label}<small>${sub}</small></span>${cur === val ? `<i>${ICON.check}</i>` : ''}</button>`;
  openSheet(`
    <div class="sheet-title">${T('prefs.title', { name: esc(convTitle(key)) })}</div>
    ${opt(null, T('prefs.std'), isCh ? T('prefs.stdChannel') : T('prefs.stdDm'))}
    ${isCh ? opt('all', T('prefs.all'), T('prefs.allSub')) : ''}
    ${opt('mute', T('prefs.mute'), T('prefs.muteSub'))}
    <div class="hint">${T('common.thisDeviceOnly')}${pushOn ? '' : ` ${T('prefs.pushOff')}`}</div>
    <button class="sheet-btn cancel" data-close>${T('common.close')}</button>`, (e) => {
    const b = e.target.closest('[data-pref]');
    if (!b) return;
    const o = { ...S.convPrefs };
    if (b.dataset.pref === 'std') delete o[prefKey(key)]; else o[prefKey(key)] = b.dataset.pref;
    S.convPrefs = o; save('convPrefs', o);
    closeSheet();
    toast({ std: T('prefs.toastStd'), all: T('prefs.toastAll'), mute: T('prefs.toastMute') }[b.dataset.pref]);
    if (S.pushEndpoint) subscribePush().catch(() => {}); // Einstellung an den Server geben (für Push)
    scheduleRender();
  });
}

// ------------------------------------------------------------------ Repeater-Wächter (pro Gerät, über Push)
S.watch = load('watch', { on: false, hours: 6, volts: null });
const WATCH_HOURS = [1, 3, 6, 12, 24];
const WATCH_VOLTS = [null, 3.5, 3.6, 3.7];
function openWatch() {
  const w = S.watch;
  const favs = [...S.nodes.values()].filter((n) => n.fav && (n.type === 2 || n.type === 3));
  const pushOn = Boolean(S.pushEndpoint);
  const pills = (list, cur, attr, fmt) => list.map((v) => `<button class="pill ${cur === v ? 'primary-pill' : ''}" data-${attr}="${v ?? ''}">${fmt(v)}</button>`).join('');
  openSheet(`
    <div class="sheet-title">${T('watch.title')}</div>
    <div class="watch-intro">${T('watch.intro')}</div>
    <button class="sheet-btn ${w.on ? 'primary' : 'outline'}" data-w="toggle">${w.on ? T('watch.isOn') : T('watch.enable')}</button>
    <div class="watch-row"><small>${T('watch.silentFor')}</small><div class="node-actions">${pills(WATCH_HOURS, w.hours, 'wh', (v) => T('watch.hours', { n: v }))}</div></div>
    <div class="watch-row"><small>${T('watch.batteryBelow')}</small><div class="node-actions">${pills(WATCH_VOLTS, w.volts, 'wv', (v) => (v ? `${nf(v, 1)} V` : T('common.off')))}</div></div>
    <div class="hint">${favs.length ? T('watch.watching', { list: favs.map((n) => esc(n.long || n.short)).join(', ') }) : T('watch.noFavs')} ${T('watch.batNote')}${pushOn ? '' : ` ${T('watch.pushOff')}`}</div>
    <button class="sheet-btn cancel" data-close>${T('common.done')}</button>`, (e) => {
    const b = e.target.closest('[data-w], [data-wh], [data-wv]');
    if (!b) return;
    const nw = { ...S.watch };
    if (b.dataset.w === 'toggle') nw.on = !nw.on;
    if (b.dataset.wh) nw.hours = Number(b.dataset.wh);
    if ('wv' in b.dataset) nw.volts = b.dataset.wv ? Number(b.dataset.wv) : null;
    S.watch = nw; save('watch', nw);
    if (S.pushEndpoint) subscribePush().catch(() => toast(T('watch.notSaved')));
    if (b.dataset.w === 'toggle' && nw.on && !S.pushEndpoint) toast(T('watch.needsPush'));
    openWatch();
  });
}

// ------------------------------------------------------------------ Reaktionen
const reactionsSupported = () => Boolean(S.source);
// Meshtastic reagiert über die Paket-ID, MeshCore über die Nachrichten-ID von MeshMonitor
const canReactTo = (m) => Boolean(m && !m.reaction && !m.id.startsWith('tmp-') && (S.source?.protocol === 'meshcore' || m.packetId));

// ------------------------------------------------------------------ Daten vom Server übernehmen
function applyMeta(meta) {
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

function ingest(list, initial = false) {
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

function conversations() {
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
const chSortLabel = (k) => ({ device: T('list.sortDevice'), recent: T('list.sortRecent'), most: T('list.sortMost'), alpha: T('list.sortAlpha') })[k];
const chSort = () => (CH_SORTS.includes(S.chSort) ? S.chSort : 'device');
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
function openChannelSort() {
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
function saveRead() {
  if (!S.source) return;
  S.readBy = { ...(S.readBy || {}), [S.source.id]: S.lastRead || {} };
  save('readBy', S.readBy);
}
// Erster Start bzw. neue Quelle: Verlauf nicht als ungelesen markieren (außer ein anderes Gerät weiß es besser)
function readHistoryIfFresh() {
  if (!S.readFresh) return;
  S.readFresh = false;
  const lr = { ...(S.lastRead || {}) };
  for (const m of S.msgs.values()) { const k = convOf(m); if (!(k in lr)) lr[k] = Date.now(); }
  S.lastRead = lr;
  saveRead();
}

function markRead(key) {
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
function shareRead(read) { api('/api/read', { method: 'POST', body: { read } }).catch(() => {}); }
function mergeRead(read) {
  const lr = { ...(S.lastRead || {}) };
  let changed = false;
  for (const [k, v] of Object.entries(read || {})) if (v > (lr[k] || 0)) { lr[k] = v; changed = true; }
  if (!changed) return;
  S.lastRead = lr; saveRead();
  scheduleRender();
}

function updateBadge() {
  if (!('setAppBadge' in navigator)) return;
  const { channels, dms } = conversations();
  const n = [...channels, ...dms].reduce((s, c) => s + c.unread, 0);
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

// ------------------------------------------------------------------ Formatierung

const hue = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; };
const pad = (n) => String(n).padStart(2, '0');
const hm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function dayLabel(ts) {
  const d = new Date(ts); const t = new Date();
  const y = new Date(); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return T('common.today');
  if (d.toDateString() === y.toDateString()) return T('common.yesterday');
  return d.toLocaleDateString(LOC, { weekday: 'short', day: '2-digit', month: '2-digit', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
}
function listTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? hm(ts) : d.toLocaleDateString(LOC, { day: '2-digit', month: '2-digit' });
}
function ago(ts) {
  if (!ts) return T('common.unknown');
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return T('ago.now');
  if (s < 3600) return T('ago.minutes', { n: Math.round(s / 60) });
  if (s < 86400) return T('ago.hours', { n: Math.round(s / 3600) });
  return T('ago.days', { n: Math.round(s / 86400) });
}
function stateIcon(st) {
  if (!st) return '';
  if (/fail|error|nak|timeout/.test(st)) return `<span class="st st-fail" title="${esc(T('state.failed'))}">!</span>`;
  if (/deliver|ack|confirm|received|read/.test(st)) return `<span class="st st-ok" title="${esc(T('state.delivered'))}">✓✓</span>`;
  if (/sent|transmit|broadcast/.test(st)) return `<span class="st" title="${esc(T('state.sent'))}">✓</span>`;
  return `<span class="st st-wait" title="${esc(T('state.pending'))}">◷</span>`;
}
// Art eines Kanals (MeshCore): Hashtag-Kanal (Name mit #, Schlüssel aus dem Namen), privat (eigener Schlüssel)
// oder Public (bekannter Schlüssel). Weiß der Server es genau (kind), gilt das; sonst entscheidet der Name.
function channelKind(idx) {
  if (S.source?.protocol !== 'meshcore') return 'hashtag';
  const c = S.channels.find((x) => x.index === idx);
  if (c?.kind === 'hashtag' || c?.kind === 'private' || c?.kind === 'public') return c.kind;
  const name = String(c?.name || '').trim();
  if (name.startsWith('#')) return 'hashtag';
  return /^public$/i.test(name) || (!name && idx === 0) ? 'public' : 'private';
}
const KIND_LABEL = () => ({ hashtag: T('channel.kindHashtag'), private: T('channel.kindPrivate'), public: T('channel.kindPublic') });
function avatar(id, cls = '') {
  if (id.startsWith('ch:')) {
    const kind = channelKind(Number(id.slice(3)));
    // Feste Farbe je Art (grün = Hashtag, lila = privat), damit man die Art auf einen Blick sieht
    return `<div class="avatar ch-${kind} ${cls}" style="--h:${kind === 'private' ? 270 : 140}" title="${esc(KIND_LABEL()[kind])}">${{ hashtag: ICON.hash, private: ICON.lock, public: ICON.globe }[kind]}</div>`;
  }
  return `<div class="avatar ${cls}" style="--h:${hue(id)}">${esc(shortName(id.replace(/^dm:/, '')).slice(0, cls === 'tiny' ? 3 : 4))}</div>`;
}

const ICON = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M4 12l16-8-6 16-2.5-6.5z" class="fill"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6" class="fill"/><circle cx="12" cy="12" r="1.6" class="fill"/><circle cx="12" cy="19" r="1.6" class="fill"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-5 4v-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/></svg>',
  people: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 4.5a3.2 3.2 0 0 1 0 6.2M18 14.3c2 .9 3 3 3 5.7"/></svg>',
  radio: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.5"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7"/></svg>',
  logout: '<svg viewBox="0 0 24 24"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10"/></svg>',
  map: '<svg viewBox="0 0 24 24"><path d="M9 4L3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M4 20V4M4 20h16M8 16v-4M12 16V8M16 16v-6"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" class="drawer-chev"><path d="M9 6l6 6-6 6"/></svg>',
  pulse: '<svg viewBox="0 0 24 24"><path d="M3 12h4l2.5-6 4.5 12 2.5-6H21"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z"/></svg>',
  megaphone: '<svg viewBox="0 0 24 24"><path d="M4 10v4h3l8 4V6l-8 4z"/><path d="M18 9.5a3.5 3.5 0 0 1 0 5M8 14.5V19"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.2 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.2-3.6-8.5s1.2-6.2 3.6-8.5z"/></svg>',
  sort: '<svg viewBox="0 0 24 24"><path d="M7 4v16M3.5 16.5L7 20l3.5-3.5M17 20V4M13.5 7.5L17 4l3.5 3.5"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7"/><circle cx="12" cy="15.5" r="1.3" class="fill"/></svg>',
  hash: '<svg viewBox="0 0 24 24"><path d="M9.5 4L7.5 20M16.5 4l-2 16M4.5 9h15.5M4 15h15.5"/></svg>',
  terminal: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7 10l3 2.5L7 15M12.5 15.5H17"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/><circle cx="12" cy="12" r="6.2"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.2"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" class="fill"/></svg>',
};

// ------------------------------------------------------------------ Rendering

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

// Breiter Bildschirm (PC/Tablet quer): links dauerhaft die Chatliste, rechts die aktuelle Ansicht
const wideMq = window.matchMedia('(min-width: 1000px)');
const isWide = () => wideMq.matches;
const inApp = () => !['boot', 'login', 'offline'].includes(S.view); // angemeldet und Daten geladen
wideMq.addEventListener?.('change', () => {
  if (!inApp()) return; // Login-/Offline-Seite nicht leeren
  $('#side').innerHTML = '';
  $('#app').innerHTML = '';
  delete $('#app').dataset.conv;
  const focus = S.mapFocus;
  leaveMap(); // Karte hängt am alten DOM -> neu aufbauen, gezeigten Weg behalten
  S.mapFocus = focus;
  render();
});

function renderEmptyMain() {
  const app = $('#app');
  if ($('.view-empty', app)) return;
  app.innerHTML = `<div class="view view-empty"><div class="empty-main"><img src="/icons/icon.svg" alt=""><b>MeshLink Chat</b><span>${T('main.pick')}</span></div></div>`;
}

function render() {
  const side = $('#side');
  if (isWide() && inApp()) {
    renderList(side);
    side.querySelectorAll('[data-conv]').forEach((b) => b.classList.toggle('active', S.view === 'chat' && b.dataset.conv === S.conv));
    if (S.view === 'list') { renderEmptyMain(); return; }
  } else if (side.innerHTML) side.innerHTML = '';
  if (S.view === 'list') renderList();
  else if (S.view === 'chat') renderChat();
  else if (S.view === 'contacts') renderContacts();
  else if (S.view === 'map') renderMap();
  else if (S.view === 'node') renderNode();
  else if (S.view === 'rooms') renderRooms();
  else if (S.view === 'room') renderRoom();
  else if (S.view === 'search') renderSearch();
  else if (S.view === 'stats') renderStats();
  else if (S.view === 'repeaters') renderRepeaters();
  else if (S.view === 'packets') renderPackets();
  else if (S.view === 'mentions') renderMentionsView();
  else if (S.view === 'admin') renderAdmin();
  ensureNav();
}

function statusLine() {
  if (!S.sse) return `<span class="dot dot-warn"></span>${T('status.connecting')}`;
  if (!S.connected) return `<span class="dot dot-bad"></span>${T('status.mmDown')}`;
  return `<span class="dot dot-ok"></span>${esc(S.source?.name || T('status.connected'))}`;
}

// Chatliste: Filter (je Gerät gemerkt) und Suchtext (nur bis zum Neuladen)
const LIST_FILTERS = ['all', 'unread', 'fav', 'dm', 'ch'];
S.listFilter = load('listFilter', 'all');
S.listQ = '';
const isFavConv = (key) => key.startsWith('dm:') && Boolean(node(key.slice(3))?.fav);

// Untere Leiste: Chats · Kontakte · Karte · Repeater (nur MeshCore) · Mehr (= Menü). In den Hauptansichten;
// nicht im Chat, in der Verwaltung usw. Breiter Bildschirm: unten in der linken Spalte unter der Chatliste.
const NAV_VIEWS = ['list', 'contacts', 'map', 'repeaters'];
function navHtml(active) {
  const unread = (() => { const { channels, dms } = conversations(); return channels.filter((c) => c.unread).length + dms.filter((c) => c.unread).length; })();
  const tabs = [['list', 'chat', T('nav.chats'), unread], ['contacts', 'people', T('nav.contacts')], ['map', 'map', T('nav.map')]];
  if (S.source?.protocol === 'meshcore') tabs.push(['repeaters', 'radio', T('nav.repeaters')]);
  tabs.push(['more', 'menu', T('nav.more')]);
  return tabs.map(([k, ic, label, n]) => `<button class="${active === k ? 'on' : ''}" data-nav="${k}"${active === k ? ' aria-current="page"' : ''}><span class="ic">${ICON[ic]}</span><span>${esc(label)}</span>${n ? `<span class="nav-dot">${n > 99 ? '99+' : n}</span>` : ''}</button>`).join('');
}
function ensureNav() {
  const wide = isWide() && inApp();
  const host = wide ? $('#side .view-list') : NAV_VIEWS.includes(S.view) ? $('#app > .view') : null;
  document.querySelectorAll('.bottom-nav').forEach((n) => { if (n.parentElement !== host) { n.parentElement?.classList.remove('has-nav'); n.remove(); } });
  if (!host) return;
  let nav = $(':scope > .bottom-nav', host);
  if (!nav) {
    nav = document.createElement('nav');
    nav.className = 'bottom-nav';
    nav.onclick = (e) => {
      const b = e.target.closest('[data-nav]');
      if (!b) return;
      const to = b.dataset.nav;
      if (to === 'more') { openDrawer(); return; }
      if (to === S.view && !(wide && S.view === 'chat')) return;
      go(to, null, S.view !== 'list' && S.view !== 'chat'); // Tab zu Tab ersetzt den Verlauf, „Zurück“ führt zur Chatliste
    };
    host.appendChild(nav);
    host.classList.add('has-nav');
  }
  const html = navHtml(S.view === 'chat' ? 'list' : S.view);
  if (nav.innerHTML !== html) nav.innerHTML = html;
}

function renderList(app = $('#app')) {
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
          <div class="conv-top"><span class="conv-title">${esc(convTitle(c.key))}${c.muted ? ` <small class="conv-flag" title="${esc(T('list.mutedFlag'))}">🔕</small>` : convPref(c.key) === 'all' ? ` <small class="conv-flag" title="${esc(T('list.allFlag'))}">📣</small>` : ''}</span><span class="conv-time ${c.unread ? 'accent' : ''}">${listTime(l?.ts)}</span></div>
          <div class="conv-bottom"><span class="conv-preview">${preview}</span>${c.unread ? `<span class="badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}</div>
        </div>
      </button>`;
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

function renderChat() {
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

function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 120; }

function renderMessages() {
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

function renderReplyBar() {
  const bar = $('#reply-bar');
  const m = S.replyTo && S.msgs.get(S.replyTo);
  if (!m) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.innerHTML = `<div class="reply-inner"><b>${isMine(m) ? T('chat.replyToYou') : T('chat.replyTo', { name: esc(nodeName(m.from)) })}</b><span>${esc(m.text)}</span></div><button class="icon-btn" id="reply-x" aria-label="${esc(T('chat.replyCancel'))}">${ICON.close}</button>`;
  $('#reply-x').onclick = () => { S.replyTo = null; renderReplyBar(); };
}

// ------------------------------------------------------------------ Kontakte

const TYPE = { 1: { label: T('type.companion'), icon: '👤' }, 2: { label: T('type.repeater'), icon: '📡' }, 3: { label: T('type.room'), icon: '🏠' }, 4: { label: T('type.sensor'), icon: '🌡️' } };
const typeOf = (n) => TYPE[n?.type] || null;
const canDm = (n) => !n?.type || n.type === 1; // Repeater/Rooms/Sensoren nehmen keine normalen DMs

function renderContacts() {
  const app = $('#app');
  if (!$('.view-contacts', app)) {
    S.contactTab = S.contactTab || (([...S.nodes.values()].some((n) => n.fav)) ? 'fav' : 'all');
    app.innerHTML = `
      <div class="view view-contacts">
        <header class="bar">
          <button class="icon-btn" id="back" aria-label="${esc(T('common.back'))}">${ICON.back}</button>
          <div class="search">${ICON.search}<input id="q" type="search" placeholder="${esc(T('contacts.search'))}" autocomplete="off"></div>
        </header>
        <div class="segments" role="tablist">
          <button class="seg" data-tab="fav" role="tab">${ICON.star} ${T('contacts.favs')} <span id="cnt-fav"></span></button>
          <button class="seg" data-tab="all" role="tab">${T('contacts.all')} <span id="cnt-all"></span></button>
          <button class="seg" data-tab="rpt" role="tab">📡 ${T('contacts.rpt')} <span id="cnt-rpt"></span></button>
        </div>
        <main class="scroll" id="nodes"></main>
      </div>`;
    $('#back').onclick = () => history.back();
    $('#q').oninput = renderContactList;
    $('.segments').onclick = (e) => {
      const t = e.target.closest('[data-tab]');
      if (t) { S.contactTab = t.dataset.tab; renderContactList(); $('#nodes').scrollTop = 0; }
    };
    $('#nodes').onclick = (e) => {
      const f = e.target.closest('[data-fav]');
      if (f) { e.stopPropagation(); toggleFav(f.dataset.fav); return; }
      const it = e.target.closest('[data-node]');
      if (it) openContact(it.dataset.node);
    };
  }
  renderContactList();
}

function renderContactList() {
  const q = ($('#q')?.value || '').trim().toLowerCase();
  const all = [...S.nodes.values()].filter((n) => n.id !== S.me);
  const groups = { fav: all.filter((n) => n.fav), all, rpt: all.filter((n) => n.type === 2 || n.type === 3) };
  for (const k of Object.keys(groups)) $(`#cnt-${k}`).textContent = groups[k].length;
  document.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.contactTab));
  let list = groups[S.contactTab] || all;
  if (q) list = list.filter((n) => `${n.long} ${n.short} ${n.id}`.toLowerCase().includes(q));
  list = S.contactTab === 'fav'
    ? list.sort((a, b) => (a.long || a.short).localeCompare(b.long || b.short, LOC))
    : list.sort((a, b) => (b.lastHeard || 0) - (a.lastHeard || 0));
  const total = list.length;
  list = list.slice(0, 400);
  $('#nodes').innerHTML = list.map((n) => {
    const t = typeOf(n);
    return `
    <button class="conv" data-node="${esc(n.id)}">
      ${avatar('dm:' + n.id)}
      <div class="conv-body">
        <div class="conv-top"><span class="conv-title">${esc(n.long || n.short || n.id)}</span><span class="conv-time">${t ? `${t.icon}` : ''}</span></div>
        <div class="conv-bottom"><span class="conv-preview muted">${t ? `${t.label} · ` : ''}${esc(ago(n.lastHeard))}${n.hops != null ? ` · ${T('common.hops', { n: n.hops })}` : ''}</span></div>
      </div>
      ${S.source?.protocol === 'meshcore' ? `<span class="fav-toggle ${n.fav ? 'on' : ''}" role="button" tabindex="0" data-fav="${esc(n.id)}" aria-label="${esc(n.fav ? T('contacts.unfav') : T('contacts.fav'))}">${n.fav ? '★' : '☆'}</span>` : n.fav ? '<span class="fav-toggle on">★</span>' : ''}
    </button>`;
  }).join('') + (total > list.length ? `<div class="empty">${T('contacts.more', { n: total - list.length })}</div>` : '')
    || `<div class="empty">${S.contactTab === 'fav' ? T('contacts.noFavs') : T('contacts.none')}</div>`;
}

// Favorit umschalten: sofort anzeigen, bei Fehler zurücknehmen. Gilt in MeshMonitor und auf dem Companion.
async function toggleFav(id) {
  const n = node(id);
  if (!n) return;
  const fav = !n.fav;
  n.fav = fav;
  scheduleRender();
  try {
    await api('/api/node/favorite', { method: 'POST', body: { id, fav } });
    toast(T(fav ? 'fav.added' : 'fav.removed', { name: n.long || n.short || 'Node' }));
  } catch (e) {
    n.fav = !fav;
    scheduleRender();
    toast(e.status === 403 ? T('fav.noPerm') : T('fav.failed', { msg: e.message }));
  }
}

function openContact(id) {
  const n = node(id);
  if (!n) return;
  const t = typeOf(n);
  const row = (k, v) => (v == null || v === '' ? '' : `<div class="info-row"><span>${k}</span><b>${esc(v)}</b></div>`);
  openSheet(`
    <div class="contact-head">${avatar('dm:' + n.id)}<div><b>${esc(n.long || n.short || n.id)}</b><div class="muted">${t ? `${t.icon} ${t.label}` : 'Node'}${n.fav ? ` · ★ ${T('fav.label')}` : ''}</div></div></div>
    <div class="info">
      ${row(T('node.lastHeard'), n.lastHeard ? `${ago(n.lastHeard)} (${new Date(n.lastHeard).toLocaleString(LOC)})` : null)}
      ${row('Hops', n.hops)}
      ${row('SNR', n.snr)}
      ${row('ID', n.id.length > 24 ? `${n.id.slice(0, 19)}…` : n.id)}
    </div>
    ${canDm(n) ? `<button class="sheet-btn primary" data-act="dm">${T('contact.send')}</button>` : ''}
    <button class="sheet-btn" data-act="details">${nodeKind(n) ? T('contact.detailsStatus') : T('contact.details')}</button>
    ${S.source?.protocol === 'meshcore' ? `<button class="sheet-btn" data-act="fav">${n.fav ? T('contact.unfav') : T('contact.fav')}</button>` : ''}
    <button class="sheet-btn cancel" data-close>${T('common.close')}</button>`, (e) => {
    if (e.target.closest('[data-act="fav"]')) { closeSheet(); toggleFav(n.id); }
    if (e.target.closest('[data-act="dm"]')) { closeSheet(); go('chat', `dm:${n.id}`, S.view === 'contacts'); }
    if (e.target.closest('[data-act="details"]')) { closeSheet(); go('node', n.id); }
  });
}

// ------------------------------------------------------------------ Emoji-Auswahl (für PC; auf dem Handy hat die Tastatur Emojis)

const EMOJI_SETS = [
  [T('emoji.smileys'), '😀 😃 😄 😁 😆 😅 😂 🤣 🙂 😉 😊 😇 🥰 😍 😘 😋 😜 🤪 😎 🤓 🥳 🤩 😏 😒 😔 😢 😭 😤 😠 😱 😳 🥺 🤔 🤫 🤭 🙄 😬 😴 🤯 🤠 😷 🤒 🥶 🥵 🤗 👀'],
  [T('emoji.gestures'), '👍 👎 👌 ✌️ 🤞 🤙 👋 🙏 👏 🙌 💪 🤝 ✋ 👊 🫡 🤷 🙋'],
  [T('emoji.hearts'), '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 ❣️ 💯 ✨ 🔥 ⭐ 🎉 🎊'],
  [T('emoji.radio'), '📡 📶 🔋 🪫 ⚡ 🛰️ 📻 📍 🗺️ 🧭 🏠 🚗 🚲 🥾 ⛰️ 🌲 ☀️ 🌧️ ⛈️ ❄️ 🌙'],
  [T('emoji.other'), '☕ 🍺 🍻 🍕 🎂 ✅ ❌ ⚠️ ❓ ❗ 🆘 🆗 🔧 🛠️ 💡 📷 ⏰ 🎵 🐶 🐱 🦆 🇩🇪'],
];
function toggleEmojiPanel(force) {
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
function insertLocation() {
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

// ------------------------------------------------------------------ Room-Server

function renderRooms() {
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

function renderRoom() {
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
      </form>`;
    const login = async (body) => {
      $('#room-sub').textContent = T('rooms.loggingIn');
      try { await api('/api/rooms/login', { method: 'POST', body: { id: rm.id, ...body } }); toast(T('rooms.loggedIn')); foot.innerHTML = ''; await loadRoom(true); } catch (err) { toast(err.status === 422 ? T('rooms.rejected') : permHint(err, 'messages:write')); drawRoom(false); }
    };
    $('#room-login').onsubmit = (e) => { e.preventDefault(); login({ password: $('#room-pw').value, remember: $('#room-rem').checked }); };
    $('#room-saved').onclick = () => login({ saved: true });
  }
}

// ------------------------------------------------------------------ Suche (nur in den geladenen Nachrichten)

function renderSearch() {
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

// ------------------------------------------------------------------ Statistik (Tag, Tage, Monat)

const PACKET_LABELS = {
  ADVERT: T('pkt.advert'), GRP_TXT: T('pkt.grpTxt'), TXT_MSG: T('pkt.txtMsg'), ACK: T('pkt.ack'), PATH: T('pkt.path'), REQ: T('pkt.req'), RESPONSE: T('pkt.response'),
  ANON_REQ: T('pkt.anonReq'), TRACE: T('pkt.trace'), GRP_DATA: T('pkt.grpData'), MULTIPART: T('pkt.multipart'), CONTROL: T('pkt.control'), RAW_CUSTOM: T('pkt.rawCustom'),
};
const nf = (v, d = 0) => Number(v).toLocaleString(LOC, { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtBytes = (b) => (b >= 1048576 ? `${nf(b / 1048576, 1)} MB` : b >= 1024 ? `${nf(b / 1024, 1)} kB` : `${nf(b)} B`);

// Zeitraum der Statistik: heute, gestern, letzte 7 Tage (Grenzen in der Zeitzone des Geräts).
// Bewusst nicht länger: In belebten Netzen wären das zehntausende Nachrichten – zu viel Last für kleine Geräte.
const STAT_RANGES = [['today', T('common.today')], ['yesterday', T('common.yesterday')], ['7', T('stats.days7')]];
const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
function statRange(sel) {
  const today = dayStart(new Date());
  let from; let to; let days = 1; let label;
  if (sel === 'today') { from = today; to = new Date(); label = T('stats.todayLabel'); }
  else if (sel === 'yesterday') { from = addDays(today, -1); to = today; label = T('stats.yesterdayLabel', { date: from.toLocaleDateString(LOC, { weekday: 'short', day: '2-digit', month: '2-digit' }) }); }
  else { days = 7; from = addDays(today, -6); to = new Date(); label = T('stats.weekLabel', { date: from.toLocaleDateString(LOC, { day: '2-digit', month: '2-digit' }) }); }
  // Balken: Stunden bei einem Tag, sonst Tage (jeweils echte lokale Grenzen, auch bei Zeitumstellung)
  const starts = [];
  if (days === 1) { for (let h = 0; h < 24; h++) { const t = new Date(from); t.setHours(h, 0, 0, 0); if (t < to) starts.push(t.getTime()); } }
  else for (let i = 0; i < days; i++) starts.push(addDays(from, i).getTime());
  return { from: from.getTime(), to: to.getTime(), starts, unit: days === 1 ? 'hour' : 'day', label, live: sel !== 'yesterday' };
}

function renderStats() {
  const app = $('#app');
  if ($('.view-stats', app)) return;
  if (!STAT_RANGES.some(([k]) => k === S.statSel)) S.statSel = 'today';
  app.innerHTML = `
    <div class="view view-stats">
      <header class="bar">
        <button class="icon-btn" id="back" aria-label="${esc(T('common.back'))}">${ICON.back}</button>
        <div class="bar-title"><h2>${T('stats.title')}</h2><div class="sub" id="stats-sub"></div></div>
        <button class="bar-pill" id="stats-pdf" title="${esc(T('stats.pdfTitle'))}">⤓ PDF</button>
        <button class="icon-btn" id="stats-refresh" aria-label="${esc(T('common.refresh'))}">${ICON.refresh}</button>
      </header>
      <div class="segments" id="stats-range">
        ${STAT_RANGES.map(([k, l]) => `<button class="seg" data-range="${k}">${l}</button>`).join('')}
      </div>
      <main class="scroll node-page stats-page" id="stats-body"></main>
    </div>`;
  $('#back').onclick = () => history.back();
  $('#stats-refresh').onclick = () => loadStats(true);
  $('#stats-pdf').onclick = printStats;
  $('#stats-body').onclick = onStatsClick;
  $('#stats-range').onclick = (e) => { const b = e.target.closest('[data-range]'); if (b) setStatRange(b.dataset.range); };
  setStatRange(S.statSel);
  clearInterval(S.statsTimer);
  S.statsTimer = setInterval(() => { if (S.view !== 'stats') clearInterval(S.statsTimer); else if (!document.hidden && S.statRange?.live) loadStats(false); }, 60000);
}

function setStatRange(sel) {
  S.statSel = sel;
  document.querySelectorAll('#stats-range [data-range]').forEach((b) => b.classList.toggle('active', b.dataset.range === sel));
  S.stats = null;
  $('#stats-body').innerHTML = `<div class="empty">${T('stats.counting')}${sel === '7' ? `<br><small>${T('stats.firstSlow')}</small>` : ''}</div>`;
  loadStats(true);
}

let statsSeq = 0;
async function loadStats(showBusy) {
  const r = statRange(S.statSel);
  S.statRange = r;
  const seq = ++statsSeq;
  if (showBusy && $('#stats-sub')) $('#stats-sub').textContent = `${r.label} · ${T('stats.loadingShort')}`;
  try {
    const st = await api(`/api/stats?from=${r.from}&to=${r.to}&b=${r.starts.join(',')}`);
    if (S.view !== 'stats' || seq !== statsSeq) return;
    S.stats = st;
    drawStats();
  } catch (e) {
    if (S.view !== 'stats' || seq !== statsSeq) return;
    $('#stats-sub').textContent = `${r.label} · ${T('stats.error')}`;
    if (!S.stats) $('#stats-body').innerHTML = `<div class="empty">${esc(permHint(e, 'messages:read'))}</div>`;
    else toast(T('stats.notUpdated', { msg: e.message }));
  }
}

// Bezeichnung eines Balkens (Stunde bzw. Tag)
const bucketLabel = (t, unit) => (unit === 'hour'
  ? T('stats.hourRange', { from: pad(new Date(t).getHours()), to: pad((new Date(t).getHours() + 1) % 24 || 24) })
  : new Date(t).toLocaleDateString(LOC, { weekday: 'short', day: '2-digit', month: '2-digit' }));

// Balken je Stunde bzw. Tag. Antippen/Überfahren zeigt den Wert in der Kopfzeile.
function bucketBars(values, starts, unit, noun) {
  const max = Math.max(1, ...values);
  const now = Date.now();
  const n = values.length;
  const bars = values.map((v, i) => {
    const end = starts[i + 1] ?? (unit === 'hour' ? starts[i] + 3600000 : addDays(new Date(starts[i]), 1).getTime());
    const cls = starts[i] > now ? 'future' : end > now ? 'now' : '';
    const tip = `${bucketLabel(starts[i], unit)}: ${nf(v)}`;
    return `<div class="hbar ${cls}" data-tip="${esc(tip)}" title="${esc(tip)} ${esc(noun)}"><i style="height:${v ? Math.max(4, (v / max) * 100) : 0}%"></i></div>`;
  }).join('');
  let axis;
  if (unit === 'hour') axis = `<span>0</span><span>6</span><span>12</span><span>18</span><span>${T('stats.axisEnd')}</span>`;
  else {
    const d = (i) => new Date(starts[i]).toLocaleDateString(LOC, { day: '2-digit', month: '2-digit' });
    axis = `<span>${d(0)}</span>${n > 6 ? `<span>${d(Math.floor((n - 1) / 2))}</span>` : ''}<span>${d(n - 1)}</span>`;
  }
  return `<div class="hbars ${n > 20 ? 'dense' : ''}" role="img" aria-label="${esc(T(unit === 'hour' ? 'stats.perHourAria' : 'stats.perDayAria', { noun }))}">${bars}</div><div class="hbars-axis">${axis}</div>`;
}
// Rangliste mit Balken (Länge = Anteil am größten Wert)
function rankList(rows, empty) {
  if (!rows.length) return `<div class="muted">${esc(empty)}</div>`;
  const max = Math.max(1, ...rows.map((r) => r.n));
  return `<div class="rank">${rows.map((r, i) => `
    <div class="rank-row" ${r.node ? `data-stat-node="${esc(r.node)}"` : ''}>
      <span class="rank-pos">${i + 1}</span>
      <div class="rank-main"><div class="rank-label"><span>${esc(r.label)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span><b>${nf(r.n)}</b></div><div class="rank-bar"><i style="width:${Math.max(2, (r.n / max) * 100)}%"></i></div></div>
    </div>`).join('')}</div>`;
}

function drawStats() {
  const st = S.stats;
  const el = $('#stats-body');
  const R = S.statRange;
  if (!st || !el || !R) return;
  const m = st.msgs; const p = st.packets && !st.packets.error ? st.packets : null;
  for (const c of m.channels) c.name = c.name || channelName(c.index); // Kanal ohne Namen: „Primär“/„Kanal n“ in der App-Sprache
  const unit = R.unit; const multi = unit === 'day';
  $('#stats-sub').textContent = `${R.label} · ${T('stats.asOf', { time: hm(st.generated) })}`;
  const tile = (label, value, sub = '') => `<div class="tile"><small>${esc(label)}</small><b>${value}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>`;
  const mapBtn = (i) => `<button class="pill" data-stat-map="${i}">${T('stats.map')}</button>`;
  S.statFocus = [];
  const focus = (f) => S.statFocus.push(f) - 1;
  const rec = (icon, title, main, sub, btn = '') => `<div class="record"><span class="record-icon">${icon}</span><div class="record-main"><small>${esc(title)}</small><b>${esc(main)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>${btn}</div>`;
  const hopsTxt = (h) => (h == null ? '' : ` · ${h === 0 ? T('common.direct') : T('common.hops', { n: h })}`);
  const msgN = (n) => T('stats.msgs', { n, num: nf(n) });
  const you = T('common.you');
  const days = st.starts.length;
  const daysSoFar = multi ? Math.max(1, st.starts.filter((t) => t <= st.generated).length) : 1;

  // Paket-Log: deckt es den Zeitraum ab?
  const cov = p?.coverageFrom ?? null;
  const covGone = cov && cov >= st.to; // für diesen Zeitraum gar keine Pakete mehr
  const covText = cov ? new Date(cov).toLocaleString(LOC, { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const pk = p && !covGone ? p : null;

  const records = [];
  if (m.channels[0]) records.push(rec('🏆', T('stats.topChannel'), m.channels[0].name, `${msgN(m.channels[0].n)}${m.channel ? ` · ${T('stats.pctOfChannel', { pct: nf((m.channels[0].n / m.channel) * 100) })}` : ''}`));
  if (m.topSenders[0]) records.push(rec('💬', T('stats.topSender'), m.topSenders[0].name, msgN(m.topSenders[0].n)));
  m.farthest.forEach((f, i) => records.push(rec(i ? '📍' : '🛰️', i ? T('stats.rankDist', { i: i + 1 }) : T('stats.farthest'), f.name, `${T('stats.airline', { km: fmtKm(f.km) })}${hopsTxt(f.hops)}`,
    mapBtn(focus({ title: `${f.name} → ${you}`, numberFrom: 0, points: [{ id: f.id, label: f.name, tag: '✉' }, { me: true, label: you }] })))));
  if (m.longest) records.push(rec('🪜', T('stats.longest'), T('stats.hopsFrom', { n: m.longest.hops, name: m.longest.name }), `${multi ? `${bucketLabel(m.longest.ts, 'day')} · ` : ''}${m.longest.path.join(' › ')}`, mapBtn(focus({ title: T('map.pathFrom', { name: m.longest.name }), numberFrom: 0, points: m.longest.points }))));
  if (pk?.farDirect) records.push(rec('📡', T('stats.farDirect'), pk.farDirect.name, `${T('stats.airline', { km: fmtKm(pk.farDirect.km) })}${pk.farDirect.snr != null ? ` · SNR ${nf(pk.farDirect.snr, 1)} dB` : ''} · ${PACKET_LABELS[pk.farDirect.type] || pk.farDirect.type}`,
    mapBtn(focus({ title: T('stats.toYouDirect', { name: pk.farDirect.name }), numberFrom: 0, points: [{ id: pk.farDirect.id, label: pk.farDirect.name, tag: '📡' }, { me: true, label: you }] }))));
  if (pk?.maxHops?.hops) records.push(rec('🔁', T('stats.maxHops'), T('common.hops', { n: pk.maxHops.hops }), `${PACKET_LABELS[pk.maxHops.type] || pk.maxHops.type} · ${pk.maxHops.path.join(' › ')}`, mapBtn(focus({ title: T('stats.packetOver', { n: pk.maxHops.hops }), numberFrom: 1, points: pk.maxHops.points }))));
  if (m.busiest) records.push(rec('⏰', multi ? T('stats.busiestDay') : T('stats.busiestHour'), bucketLabel(m.busiest.start, unit), msgN(m.busiest.n)));
  if (m.longText) records.push(rec('📝', T('stats.longText'), m.longText.name, T('stats.bytes', { n: m.longText.bytes, num: nf(m.longText.bytes) })));

  const types = { 1: T('stats.typeCompanions'), 2: T('stats.typeRepeaters'), 3: T('stats.typeRooms'), 4: T('stats.typeSensors'), 0: T('stats.typeOther') };
  const hopHist = pk ? pk.hopHist.map((n, h) => ({ label: h === 0 ? T('stats.hop0') : h === 8 ? T('stats.hop8') : T('common.hops', { n: h }), n })).filter((r) => r.n) : [];
  const warn = [
    m.truncated ? T('stats.warnTrunc') : '',
    m.skipped?.length || m.dmSkipped ? T('stats.warnSkipped', { list: [...(m.skipped || []), ...(m.dmSkipped ? [T('list.dms')] : [])].join(', ') }) : '',
    pk?.truncated ? T('stats.warnPkTrunc', { n: nf(100000) }) : '',
  ].filter(Boolean);
  const covNote = p && cov ? `<div class="note">${covGone
    ? T('stats.covGone', { date: esc(covText) })
    : T('stats.covFrom', { date: esc(covText) })}
    <small>${T('stats.covSetting')}</small></div>` : '';

  const gen = new Date(st.generated);
  el.innerHTML = `
    <div class="print-head">
      <div><b>MeshLink Chat · ${T('stats.title')}</b><span>${esc(R.label)}</span></div>
      <small>${esc(S.source?.name || '')}${S.source?.name ? ' · ' : ''}${T('stats.asOfFull', { date: esc(gen.toLocaleDateString(LOC, { day: '2-digit', month: '2-digit', year: 'numeric' })), time: esc(hm(st.generated)) })}</small>
    </div>
    <section class="tiles">
      ${tile(T('stats.tileMsgs'), nf(m.total), multi ? T('stats.avgDaySent', { avg: nf(m.total / daysSoFar, 1), sent: nf(m.mine) }) : T('stats.recvSent', { recv: nf(m.received), sent: nf(m.mine) }))}
      ${pk ? tile(T('stats.tilePk'), nf(pk.total), multi && !cov ? T('stats.avgDayBytes', { avg: nf(pk.total / daysSoFar), bytes: fmtBytes(pk.bytes) }) : `${T('stats.payload', { bytes: fmtBytes(pk.bytes) })}${cov ? ` ${T('stats.partial')}` : ''}`) : tile(T('list.dms'), nf(m.dm), T('stats.inChannels', { n: nf(m.channel) }))}
      ${tile(T('stats.tileSenders'), nf(m.senders), multi ? T('stats.inDays', { n: days }) : T('stats.wrote'))}
      ${st.nodes ? tile(T('stats.tileNodes'), nf(st.nodes.heard), T('stats.ofKnown', { n: nf(st.nodes.known) })) : tile(T('stats.tileMentions'), nf(m.mentions), T('stats.ofYou'))}
    </section>
    ${warn.map((w) => `<div class="banner">${esc(w)}</div>`).join('')}
    <section class="card">
      <div class="card-head"><b>${multi ? T('stats.msgsPerDay') : T('stats.msgsPerHour')}</b><small class="chart-tip" data-default="${esc(T('stats.total', { n: nf(m.total) }))}">${T('stats.total', { n: nf(m.total) })}</small></div>
      ${bucketBars(m.perBucket, st.starts, unit, T('stats.nounMsgs'))}
    </section>
    <section class="card">
      <div class="card-head"><b>${T('stats.records')}</b></div>
      ${records.join('') || `<div class="muted">${T('stats.quiet')}</div>`}
      ${!m.hasMyPos ? `<div class="hint">${T('stats.needPos')}</div>` : ''}
    </section>
    <section class="card">
      <div class="card-head"><b>${T('list.channels')}</b><small>${T('stats.nMsgs', { n: nf(m.channel) })}</small></div>
      ${rankList(m.channels.map((c) => ({ label: c.name, n: c.n })), T('stats.noChMsgs'))}
    </section>
    <section class="card">
      <div class="card-head"><b>${T('stats.topSenders')}</b><small>${T('stats.active', { n: nf(m.senders) })}</small></div>
      ${rankList(m.topSenders.map((x) => ({ label: x.name, n: x.n })), T('stats.nobody'))}
    </section>
    <section class="card">
      <div class="card-head"><b>${T('stats.detail')}</b></div>
      <div class="stat-grid">
        <div><small>${T('stats.inCh')}</small><b>${nf(m.channel)}</b></div>
        <div><small>${T('list.dms')}</small><b>${nf(m.dm)}</b></div>
        <div><small>${T('stats.mentionsOfYou')}</small><b>${nf(m.mentions)}</b></div>
        ${m.reactions != null ? `<div><small>${T('stats.reactions')}</small><b>${nf(m.reactions)}</b></div>` : ''}
        ${m.hops ? `<div><small>${T('stats.avgHops')}</small><b>${nf(m.hops.avg, 1)}</b></div><div><small>${T('stats.directRecv')}</small><b>${nf((m.hops.direct / m.hops.n) * 100)} %</b></div>` : ''}
        ${m.hashBytes.map((h) => `<div><small>${T('route.hashBytes', { n: h.bytes })}</small><b>${nf(h.n)}</b></div>`).join('')}
      </div>
      ${m.emojis.length ? `<div class="stat-chips"><small>${T('stats.reactions')}:</small>${m.emojis.map((x) => `<span>${esc(x.e)} ${nf(x.n)}</span>`).join('')}</div>` : ''}
      ${m.scopes.length ? `<div class="stat-chips"><small>Scopes${m.scopesPartial ? ` ${T('stats.asKnown')}` : ''}:</small>${m.scopes.map((x) => `<span>${esc(x.label || T('scope.none'))} ${nf(x.n)}</span>`).join('')}</div>` : ''}
      ${m.reactions == null ? `<div class="hint">${T('stats.reactNote')}</div>` : ''}
    </section>
    ${covNote}
    ${pk ? `
    <section class="card">
      <div class="card-head"><b>${multi ? T('stats.pkPerDay') : T('stats.pkPerHour')}</b><small class="chart-tip" data-default="${esc(T('stats.total', { n: nf(pk.total) }))}">${T('stats.total', { n: nf(pk.total) })}</small></div>
      ${bucketBars(pk.perBucket, st.starts, unit, T('stats.nounPk'))}
    </section>
    <section class="card">
      <div class="card-head"><b>${T('stats.radio')}</b></div>
      <div class="stat-grid">
        ${pk.snr ? `<div><small>${T('stats.snrAvg')}</small><b>${nf(pk.snr.avg, 1)} dB</b></div><div><small>${T('stats.snrRange')}</small><b>${nf(pk.snr.max, 1)} / ${nf(pk.snr.min, 1)} dB</b></div>` : ''}
        ${pk.rssi ? `<div><small>${T('stats.rssiAvg')}</small><b>${nf(pk.rssi.avg)} dBm</b></div>` : ''}
        ${pk.routes.map((r) => `<div><small>${r.name === 'FLOOD' ? T('stats.floodPk') : r.name === 'DIRECT' ? T('stats.directPk') : esc(r.name)}</small><b>${nf(r.n)}</b></div>`).join('')}
        <div><small>${T('pkt.advert')}</small><b>${nf(pk.adverts)}</b></div>
        <div><small>${T('stats.advertNodes')}</small><b>${nf(pk.advertNodes)}</b></div>
        <div><small>${T('stats.relayCount')}</small><b>${nf(pk.relayCount)}</b></div>
      </div>
    </section>
    <section class="card">
      <div class="card-head"><b>${T('stats.pkTypes')}</b></div>
      ${rankList(pk.types.map((t) => ({ label: PACKET_LABELS[t.name] || t.name, sub: PACKET_LABELS[t.name] ? t.name : '', n: t.n })), T('stats.noPk'))}
    </section>
    <section class="card">
      <div class="card-head"><b>${T('stats.howFar')}</b></div>
      ${rankList(hopHist, T('stats.noPk'))}
    </section>
    <section class="card">
      <div class="card-head"><b>${T('stats.lastHop')}</b><small>${T('stats.lastHopSub')}</small></div>
      ${rankList(pk.lastHop.map((r) => ({ label: r.name || `#${r.hash}`, sub: r.snr != null ? T('stats.bestSnr', { v: nf(r.snr, 1) }) : '', n: r.n, node: r.id })), T('stats.noRelay'))}
    </section>
    <section class="card">
      <div class="card-head"><b>${T('stats.relays')}</b><small>${T('stats.relaysSub')}</small></div>
      ${rankList(pk.relays.map((r) => ({ label: r.name || `#${r.hash}`, n: r.n, node: r.id })), T('stats.noRelay'))}
    </section>` : st.packets?.error ? `<section class="card"><div class="muted">${st.packets.error === 'forbidden' ? T('stats.pkForbidden') : T('stats.pkError', { msg: esc(st.packets.error) })}</div></section>` : ''}
    ${st.nodes ? `
    <section class="card">
      <div class="card-head"><b>${T('stats.heardNodes')}</b><small>${T(multi ? 'stats.sinceStart' : 'stats.sinceMidnight', { n: nf(st.nodes.heard) })}</small></div>
      <div class="stat-grid">${Object.entries(st.nodes.byType).map(([t, n]) => `<div><small>${esc(types[t] || types[0])}</small><b>${nf(n)}</b></div>`).join('') || `<div><small>${T('stats.noneYet')}</small><b>0</b></div>`}</div>
    </section>` : ''}
    <div class="hint">${T('stats.footer', { src: esc(st.source) })}</div>`;
}

function onStatsClick(e) {
  const bar = e.target.closest('.hbar');
  if (bar) {
    const tip = bar.closest('.card').querySelector('.chart-tip');
    const on = !bar.classList.contains('sel');
    bar.parentElement.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
    bar.classList.toggle('sel', on);
    tip.textContent = on ? bar.dataset.tip : tip.dataset.default;
    return;
  }
  const mb = e.target.closest('[data-stat-map]');
  if (mb) { showOnMap(S.statFocus[Number(mb.dataset.statMap)]); return; }
  const nd = e.target.closest('[data-stat-node]');
  if (nd) go('node', nd.dataset.statNode);
}

// Statistik als PDF: über den Druckdialog des Browsers ("Als PDF speichern") – keine Bibliothek, nichts auf dem Server.
// Eigenes Druck-Layout (style.css @media print): hell, ohne Knöpfe, Karten nicht über Seitenumbrüche zerteilt.
// Der Dokumenttitel wird kurz zum Dateinamen-Vorschlag.
function printStats() {
  if (!S.stats || !S.statRange) { toast(T('stats.stillLoading')); return; }
  const title = document.title;
  const d = new Date(S.statRange.from); // lokales Datum (nicht UTC – sonst kurz nach Mitternacht der Vortag)
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const tag = { today: T('stats.fileToday'), yesterday: T('stats.fileYesterday'), 7: T('stats.fileWeek') }[S.statSel] || T('stats.title');
  document.title = T('stats.fileName', { tag, day });
  document.body.classList.add('print-stats');
  const done = () => { document.title = title; document.body.classList.remove('print-stats'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  try { window.print(); } catch { toast(T('stats.noPrint')); }
  // Browser ohne afterprint: Titel später zurück (die Klasse wirkt nur beim Drucken, darf also bleiben)
  setTimeout(() => { if (document.title !== title && !matchMedia('print').matches) document.title = title; }, 60000);
}

// ------------------------------------------------------------------ Erwähnungen (@Name) der letzten 7 Tage

const unreadMentions = () => [...S.msgs.values()].filter((m) => !m.reaction && !isMine(m) && !isOwnOther(m) && !m.dm && mentionsMe(m) && m.ts > ((S.lastRead || {})[convOf(m)] || 0)).length;

function renderMentionsView() {
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

// ------------------------------------------------------------------ Repeater-Übersicht (Favoriten)

function renderRepeaters() {
  const app = $('#app');
  if ($('.view-repeaters', app)) return;
  app.innerHTML = `
    <div class="view view-repeaters">
      <header class="bar">
        <button class="icon-btn" id="back" aria-label="${esc(T('common.back'))}">${ICON.back}</button>
        <div class="bar-title"><h2>${T('rp.title')}</h2><div class="sub" id="rp-sub">${T('rp.sub')}</div></div>
        <button class="bar-pill" id="rp-watch" title="${esc(T('watch.title'))}">${T('rp.watchBtn')}</button>
      </header>
      <main class="scroll node-page" id="rp-body"><div class="empty">${T('common.loading')}</div></main>
    </div>`;
  $('#back').onclick = () => history.back();
  $('#rp-watch').onclick = openWatch;
  $('#rp-body').onclick = (e) => { const t = e.target.closest('[data-rp]'); if (t) go('node', t.dataset.rp); };
  loadRepeaters();
  clearInterval(S.rpTimer);
  S.rpTimer = setInterval(() => { if (S.view !== 'repeaters') clearInterval(S.rpTimer); else if (!document.hidden) loadRepeaters(); }, 60000);
}

async function loadRepeaters() {
  try {
    const r = await api('/api/repeaters');
    if (S.view !== 'repeaters') return;
    drawRepeaters(r);
  } catch (e) {
    if (S.view === 'repeaters') $('#rp-body').innerHTML = `<div class="empty">${esc(permHint(e, 'nodes:read'))}</div>`;
  }
}

// Kurzform für die Übersicht: ↓ empfangen · ↑ gesendet
const rpTraffic = (tr, k) => (tr.recv?.[k] || tr.sent?.[k] ? `↓ ${trafficNum(tr.recv?.[k])} · ↑ ${trafficNum(tr.sent?.[k])}` : '–');
function drawRepeaters(r) {
  const now = Date.now();
  const limit = (S.watch.hours || 6) * 3600000;
  $('#rp-watch').classList.toggle('on', Boolean(S.watch.on));
  const rows = [...r.repeaters].sort((a, b) => (a.lastHeard || 0) - (b.lastHeard || 0)); // Sorgenkinder zuerst
  const bad = rows.filter((x) => !x.lastHeard || now - x.lastHeard > limit).length;
  $('#rp-sub').textContent = rows.length ? `${T('rp.count', { n: rows.length })} · ${bad ? T('rp.silent', { n: bad }) : T('rp.allActive')}` : T('rp.sub');
  const val = (st, k, f) => (st?.[k] ? f(st[k].v) : '–');
  $('#rp-body').innerHTML = rows.map((x) => {
    const age = x.lastHeard ? now - x.lastHeard : Infinity;
    const lamp = age < 2 * 3600000 ? 'ok' : age < limit ? 'warn' : 'bad';
    const bat = x.status?.battery;
    const lowBat = bat && S.watch.volts && bat.v < S.watch.volts;
    return `
    <section class="card rp-card" data-rp="${esc(x.id)}">
      <div class="rp-head"><span class="lamp lamp-${lamp}" title="${esc({ ok: T('rp.lampOk'), warn: T('rp.lampWarn'), bad: T('rp.lampBad') }[lamp])}"></span><b>${x.type === 3 ? '🏠 ' : ''}${esc(x.name)}</b><small>${esc(ago(x.lastHeard))}</small></div>
      <div class="stat-grid">
        <div class="${lowBat ? 'rp-low' : ''}"><small>${T('node.battery')}</small><b>${val(x.status, 'battery', (v) => `${nf(v, 2)} V`)}</b></div>
        <div><small>${T('node.noise')}</small><b>${val(x.status, 'noise', (v) => `${fmtNum(v)} dB`)}</b></div>
        <div><small>${T('node.lastSnr')}</small><b>${val(x.status, 'snr', (v) => `${fmtNum(v)} dB`)}</b></div>
        <div><small>${T('node.uptime')}</small><b>${val(x.status, 'uptime', (v) => dur(v))}</b></div>
        ${x.status?.traffic ? `<div><small>${T('traffic.pkHour')}</small><b>${rpTraffic(x.status.traffic, 'hour')}</b></div><div><small>${T('traffic.pk24')}</small><b>${rpTraffic(x.status.traffic, 'day')}</b></div>` : ''}
      </div>
      <div class="rp-foot">${x.status?.ts ? T('rp.statusAgo', { ago: esc(ago(x.status.ts)) }) : T('rp.noStatus')}${x.hops != null ? ` · ${T('common.hops', { n: x.hops })}` : ''}${x.snr != null ? ` · SNR ${esc(x.snr)}` : ''}</div>
    </section>`;
  }).join('') || `<div class="empty">${T('rp.none')}</div>`;
  if (r.telemetryForbidden) $('#rp-body').insertAdjacentHTML('beforeend', `<div class="hint">${T('rp.telemetryForbidden')}</div>`);
  else if (rows.length && rows.every((x) => !x.status?.ts)) $('#rp-body').insertAdjacentHTML('beforeend', `<div class="hint">${T('rp.statusHint')}</div>`);
}

// ------------------------------------------------------------------ Advert

function openAdvert() {
  openSheet(`
    <div class="sheet-title">${T('advert.title')}</div>
    <button class="sheet-btn scope-opt" data-advert="zero_hop"><span>📍 Zero-Hop<small>${T('advert.zeroSub')}</small></span></button>
    <button class="sheet-btn scope-opt" data-advert="flood"><span>📢 Flood<small>${T('advert.floodSub')}</small></span></button>
    <div class="hint">${T('advert.hint', { name: esc(myName() || '') })}</div>
    <button class="sheet-btn cancel" data-close>${T('common.cancel')}</button>`, async (e) => {
    const b = e.target.closest('[data-advert]');
    if (!b) return;
    const mode = b.dataset.advert;
    closeSheet();
    try {
      await api('/api/advert', { method: 'POST', body: { mode } });
      toast(mode === 'flood' ? T('advert.sentFlood') : T('advert.sentZero'));
    } catch (err) {
      toast(err.status === 403 ? T('advert.noPerm')
        : err.code === 'TX_DISABLED' ? T('advert.txDisabled')
          : err.status === 429 ? T('advert.tooMany')
            : T('advert.failed', { msg: err.message }));
    }
  });
}

// ------------------------------------------------------------------ Karte

const MAP_RANGES = [[1, '24 h'], [3, T('common.days', { n: 3 })], [7, T('common.days', { n: 7 })], [30, T('common.days', { n: 30 })]];
const MAP_COLORS = { 1: '#2f7dd1', 2: '#1f9d6b', 3: '#d9822b', 4: '#8a62c9' };
let leafletLoading = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletLoading) return leafletLoading;
  const v = APP_VERSION ? `?v=${APP_VERSION}` : '';
  leafletLoading = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = `/vendor/leaflet/leaflet.css${v}`;
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = `/vendor/leaflet/leaflet.js${v}`;
    js.onload = () => resolve();
    js.onerror = () => { leafletLoading = null; reject(new Error(T('map.loadFailed'))); };
    document.head.appendChild(js);
  });
  return leafletLoading;
}

// ------------------------------------------------------------------ Paket-Analyzer
// Liest MeshMonitors Paket-Log seitenweise (gefiltert von MeshMonitor) und zerlegt jedes Paket Byte für Byte.
// Nur im Speicher dieser Seite: höchstens 500 Pakete, beim Verlassen weg.
const PK_TYPES = [
  [null, T('pk.tAll')], [4, T('pk.tAdvert')], [5, T('pk.tChannel')], [2, 'DM'], [3, 'ACK'], [8, T('pk.tPath')], [9, 'Trace'],
  [0, T('pk.tReq')], [1, T('pk.tResp')], [7, T('pk.tAnon')], [6, T('pk.tGrpData')], [10, T('pk.tMulti')], [11, T('pk.tControl')],
];
const PK_TYPE_NAME = ['REQ', 'RESPONSE', 'TXT_MSG', 'ACK', 'ADVERT', 'GRP_TXT', 'GRP_DATA', 'ANON_REQ', 'PATH', 'TRACE', 'MULTIPART', 'CONTROL', null, null, null, 'RAW_CUSTOM'];
const PK_ROUTE_LABEL = { 0: T('pk.rFloodScope'), 1: 'Flood', 2: T('pk.rDirect'), 3: T('pk.rDirectScope') };
const PK_ROUTES = [['', T('pk.rAny')], ['1', PK_ROUTE_LABEL[1]], ['2', PK_ROUTE_LABEL[2]], ['0', PK_ROUTE_LABEL[0]], ['3', PK_ROUTE_LABEL[3]]];
const PK_ROUTE_SHORT = { 0: 'F·S', 1: 'F', 2: 'D', 3: 'D·S' };
const PK_MAX = 500;
const PK_PAGE = 50;
const PK_FIELD_COLORS = {
  hdr: '#7b61ff', tc: '#8f9b96', plen: '#c99a00', path: '#00a3a3', key: '#3a8fd6', ts: '#e0482f', sig: '#8a8f8d', flag: '#ff4fa3',
  pos: '#2e9d5b', name: '#d9822b', dst: '#3a8fd6', src: '#e0482f', mac: '#9a7b4f', enc: '#6b7a74', ack: '#c99a00', snr: '#ff4fa3', misc: '#6b7a74',
};
S.pk = { list: [], total: null, f: { type: null, route: '', via: '', from: '', q: '' }, live: load('pkLive', true), timer: null, busy: false, end: false, err: null };

const pkKind = (p) => p.kind || PK_TYPE_NAME[p.type] || (p.type != null ? `0x${p.type.toString(16)}` : '?');
function pkTypeLabel(p) {
  const t = PK_TYPES.find(([v]) => v === p.type);
  return t ? t[1] : pkKind(p);
}
const pkColor = (p) => liveKind(pkKind(p))[0];
// Kennung (Hash-Präfix) -> Node-Name, nur wenn eindeutig (Repeater/Room bevorzugt)
function pkHashName(h, anyType = false) {
  if (!h) return null;
  const all = [...(S.nodes?.values?.() || [])].filter((n) => n.id?.startsWith('mc:') && n.id.slice(3).toLowerCase().startsWith(h));
  const rep = anyType ? [] : all.filter((n) => n.type === 2 || n.type === 3);
  const one = rep.length === 1 ? rep[0] : all.length === 1 ? all[0] : null;
  return one ? one.long || one.short || null : null;
}
function pkFrom(p) {
  if (!p.name && p.type === 4 && p.raw && !p._adv) { // Advert: Name/Schlüssel stehen unverschlüsselt in den Rohdaten
    p._adv = true;
    const d = pkDecode(p.raw);
    p.name = d?.fields.find((f) => f.cls === 'name')?.value || null;
    if (!p.from) { const k = d?.fields.find((f) => f.pk)?.pk; if (k) p.from = `mc:${k}`; }
  }
  if (p.name) return p.name;
  const n = p.from ? node(p.from) : null;
  if (n) return n.long || n.short;
  if (p.src) return pkHashName(p.src, true) || `#${p.src}`;
  return null;
}
const pkHop = (h) => pkHashName(h) || `#${h}`;

// ---- Decoder: Rohdaten -> Felder mit Byte-Bereich (für die farbige Hex-Ansicht)
function pkHexBytes(hex) {
  const out = new Uint8Array(Math.floor((hex || '').length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
const pkHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
function pkDecode(raw) {
  const b = pkHexBytes(raw);
  if (!b.length) return null;
  const fields = [];
  const errors = [];
  let o = 0;
  const add = (len, label, value, cls) => {
    if (len <= 0) return null;
    if (o + len > b.length) { errors.push(T('pk.tooShort', { label })); len = b.length - o; if (len <= 0) return null; }
    const bytes = b.subarray(o, o + len);
    fields.push({ o, len, label, value, cls });
    o += len;
    return bytes;
  };
  const u16 = (x, i) => x[i] | (x[i + 1] << 8);
  const u32 = (x, i) => (x[i] | (x[i + 1] << 8) | (x[i + 2] << 16) | (x[i + 3] << 24)) >>> 0;
  const h = b[0];
  const route = h & 3; const type = (h >> 2) & 15; const ver = h >> 6;
  add(1, 'Header', `${PK_TYPE_NAME[type] || T('pk.typeN', { n: `0x${type.toString(16)}` })} · ${PK_ROUTE_LABEL[route]} · ${T('pk.version', { v: ver + 1 })}`, 'hdr');
  if (route === 0 || route === 3) {
    const tc = add(4, T('pk.fTransport'), '', 'tc');
    if (tc?.length === 4) fields[fields.length - 1].value = `${u16(tc, 0)} / ${u16(tc, 2)} – ${T('pk.scopeId')}`;
  }
  let hops = 0; let hs = 1;
  if (o < b.length) {
    const pl = b[o];
    hs = (pl >> 6) + 1; hops = pl & 63;
    add(1, T('pk.fPathLen'), type === 9 ? T('pk.snrValues', { n: hops }) : `${T('common.hops', { n: hops })} · ${T('route.hashBytes', { n: hs })}`, 'plen');
    for (let i = 0; i < hops; i++) {
      if (type === 9) { // Trace: im Pfad sammeln die Repeater ihre SNR-Werte (int8, ×4)
        const x = add(1, `SNR ${i + 1}`, '', 'snr');
        if (x) fields[fields.length - 1].value = `${nf(((x[0] << 24) >> 24) / 4, 2)} dB`;
      } else {
        const x = add(hs, `Hop ${i + 1}`, '', 'path');
        if (x) { const hx = pkHex(x); const nm = pkHashName(hx); fields[fields.length - 1].value = `${hx}${nm ? ` · ${nm}` : ''}`; fields[fields.length - 1].hash = hx; }
      }
    }
  } else errors.push(T('pk.endsEarly'));
  const payloadAt = o;
  const rest = () => b.length - o;
  const hashField = (label, cls, anyType) => {
    const x = add(1, label, '', cls);
    if (x) { const hx = pkHex(x); const nm = pkHashName(hx, anyType); fields[fields.length - 1].value = `${hx}${nm ? ` · ${nm}?` : ''}`; }
  };
  if (type === 4) { // ADVERT – unverschlüsselt
    const k = add(32, T('pk.fPubKey'), '', 'key');
    if (k) { const n = node(`mc:${pkHex(k)}`); fields[fields.length - 1].value = `${pkHex(k).slice(0, 16)}…${n ? ` · ${n.long || n.short}` : ''}`; fields[fields.length - 1].pk = pkHex(k); }
    const ts = add(4, T('pk.fTimestamp'), '', 'ts');
    if (ts?.length === 4) { const t = u32(ts, 0); fields[fields.length - 1].value = t ? new Date(t * 1000).toLocaleString(LOC) : '0'; }
    add(64, T('pk.fSig'), T('pk.sigNote'), 'sig');
    if (rest() > 0) {
      const fl = b[o];
      const kind = ['–', 'Chat', T('type.repeater'), T('type.room'), T('type.sensor')][fl & 15] || T('pk.typeN', { n: fl & 15 });
      add(1, 'Flags', `${kind}${fl & 0x10 ? ` · ${T('pk.fPos')}` : ''}${fl & 0x20 ? ' · Feature 1' : ''}${fl & 0x40 ? ' · Feature 2' : ''}${fl & 0x80 ? ` · ${T('pk.fName')}` : ''}`, 'flag');
      if (fl & 0x10) {
        const ll = add(8, T('pk.fPos'), '', 'pos');
        if (ll?.length === 8) { const dv = new DataView(ll.buffer, ll.byteOffset, 8); fields[fields.length - 1].value = `${(dv.getInt32(0, true) / 1e6).toFixed(5)}, ${(dv.getInt32(4, true) / 1e6).toFixed(5)}`; }
      }
      if (fl & 0x20) add(2, 'Feature 1', '', 'misc');
      if (fl & 0x40) add(2, 'Feature 2', '', 'misc');
      if (fl & 0x80 && rest() > 0) {
        const nb = b.subarray(o);
        const end = nb.indexOf(0);
        add(end < 0 ? nb.length : end + 1, T('pk.fName'), new TextDecoder().decode(end < 0 ? nb : nb.subarray(0, end)), 'name');
      }
    }
  } else if (type === 3) {
    add(4, 'ACK-Code', T('pk.ackNote'), 'ack');
  } else if (type === 5 || type === 6) {
    // Wert nur setzen, wenn das Feld wirklich angelegt wurde (abgeschnittenes Paket: sonst träfe es das vorige Feld)
    const ch = add(1, T('pk.fChHash'), '', 'dst');
    if (ch) fields[fields.length - 1].value = `${pkHex(ch)} – ${T('pk.chHashNote')}`;
    add(2, 'MAC', T('pk.macNote'), 'mac');
    add(rest(), T('pk.fEnc'), T('pk.nBytes', { n: rest() }), 'enc');
  } else if (type === 0 || type === 1 || type === 2 || type === 8) {
    hashField(T('pk.fDst'), 'dst', true);
    hashField(T('pk.fSrc'), 'src', true);
    add(2, 'MAC', T('pk.macNote'), 'mac');
    add(rest(), T('pk.fEnc'), T('pk.nBytes', { n: rest() }), 'enc');
  } else if (type === 7) {
    hashField(T('pk.fDst'), 'dst', false);
    const k = add(32, T('pk.fSrcKey'), '', 'key');
    if (k) { const n = node(`mc:${pkHex(k)}`); fields[fields.length - 1].value = `${pkHex(k).slice(0, 16)}…${n ? ` · ${n.long || n.short}` : ''}`; fields[fields.length - 1].pk = pkHex(k); }
    add(2, 'MAC', T('pk.macNote'), 'mac');
    add(rest(), T('pk.fEnc'), T('pk.nBytes', { n: rest() }), 'enc');
  } else if (type === 9) {
    const tag = add(4, 'Tag', '', 'misc');
    if (tag?.length === 4) fields[fields.length - 1].value = `${u32(tag, 0)} – ${T('pk.traceTag')}`;
    add(4, 'Auth-Code', '', 'mac');
    const fl = add(1, 'Flags', '', 'flag');
    const ths = fl ? 1 << (fl[0] & 3) : 1;
    if (fl) fields[fields.length - 1].value = T('route.hashBytes', { n: ths });
    for (let i = 0; rest() > 0 && i < 64; i++) {
      const x = add(Math.min(ths, rest()), `Route ${i + 1}`, '', 'path');
      if (x) { const hx = pkHex(x); const nm = pkHashName(hx); fields[fields.length - 1].value = `${hx}${nm ? ` · ${nm}` : ''}`; fields[fields.length - 1].hash = hx; }
    }
  } else if (type === 10) {
    const x = add(1, T('pk.fPart'), '', 'flag');
    if (x) fields[fields.length - 1].value = T('pk.partNote', { n: x[0] >> 4, inner: PK_TYPE_NAME[x[0] & 15] || x[0] & 15 });
    add(rest(), T('pk.fContent'), T('pk.nBytes', { n: rest() }), 'misc');
  } else if (type === 11) {
    const x = add(1, T('pk.fSubtype'), '', 'flag');
    if (x) fields[fields.length - 1].value = ({ 0x80: T('pk.discReq'), 0x90: T('pk.discResp') })[x[0] & 0xf0] || `0x${(x[0] & 0xf0).toString(16)}`;
    add(rest(), T('pk.fData'), T('pk.nBytes', { n: rest() }), 'misc');
  } else add(rest(), T('pk.fPayload'), T('pk.nBytes', { n: rest() }), 'misc');
  return { type, route, ver, hops, hs, fields, errors, total: b.length, payloadAt, key: raw.slice(payloadAt * 2) };
}

// Gleicher Inhalt mehrfach gehört (über verschiedene Wege): Schlüssel = Payload ohne Header/Pfad
function pkGroupKey(p) {
  if (!p.raw) return null;
  if (p._key === undefined) p._key = p.type === 9 ? null : pkDecode(p.raw)?.key || null;
  return p._key;
}
function pkCopies(p) {
  const k = pkGroupKey(p);
  return k ? S.pk.list.filter((x) => x !== p && pkGroupKey(x) === k) : [];
}

// ---- Seite
function renderPackets() {
  const app = $('#app');
  if ($('.view-packets', app)) return;
  const f = S.pk.f;
  app.innerHTML = `
    <div class="view view-packets">
      <header class="bar">
        <button class="icon-btn" id="back" aria-label="${esc(T('common.back'))}">${ICON.back}</button>
        <div class="bar-title"><h2>${T('pk.title')}</h2><div class="sub" id="pk-sub">${T('common.loading')}</div></div>
        <button class="bar-pill ${S.pk.live ? 'on' : ''}" id="pk-live" title="${esc(T('pk.liveTitle'))}">⚡ Live</button>
        <button class="icon-btn" id="pk-refresh" aria-label="${esc(T('common.refresh'))}">${ICON.refresh}</button>
      </header>
      <div class="segments" id="pk-types">${PK_TYPES.map(([v, l]) => `<button class="seg ${f.type === v ? 'active' : ''}" data-type="${v ?? ''}">${v != null ? `<i class="pk-dot" style="background:${liveKind(PK_TYPE_NAME[v])[0]}"></i>` : ''}${esc(l)}</button>`).join('')}</div>
      <div class="pk-filter">
        <input id="pk-q" type="search" placeholder="${esc(T('pk.searchPh'))}" value="${esc(f.q || f.via)}" autocomplete="off" enterkeyhint="search">
        <select id="pk-route" aria-label="Route">${PK_ROUTES.map(([v, l]) => `<option value="${v}" ${f.route === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      </div>
      <div class="pk-chips" id="pk-chips"></div>
      <main class="scroll" id="pk-list"></main>
    </div>`;
  $('#back').onclick = () => history.back();
  $('#pk-refresh').onclick = () => pkLoad(true);
  $('#pk-live').onclick = () => { S.pk.live = !S.pk.live; save('pkLive', S.pk.live); $('#pk-live').classList.toggle('on', S.pk.live); if (S.pk.live) pkPoll(); };
  $('#pk-types').onclick = (e) => {
    const b = e.target.closest('[data-type]');
    if (!b) return;
    f.type = b.dataset.type === '' ? null : Number(b.dataset.type);
    document.querySelectorAll('#pk-types .seg').forEach((x) => x.classList.toggle('active', x === b));
    pkLoad(true);
  };
  $('#pk-route').onchange = (e) => { f.route = e.target.value; pkLoad(true); };
  let qt = null;
  $('#pk-q').oninput = (e) => {
    clearTimeout(qt);
    qt = setTimeout(() => {
      const v = e.target.value.trim();
      // reine Hex-Kennung (1–3 Bytes) = „über Repeater“, sonst Volltextsuche bei MeshMonitor
      if (/^(?:[0-9a-f]{2}){1,3}$/i.test(v)) { f.via = v.toLowerCase(); f.q = ''; } else { f.q = v; f.via = ''; }
      pkLoad(true);
    }, 450);
  };
  $('#pk-chips').onclick = (e) => {
    const c = e.target.closest('[data-unset]');
    if (!c) return;
    f[c.dataset.unset] = '';
    if (c.dataset.unset === 'via' || c.dataset.unset === 'q') $('#pk-q').value = '';
    pkLoad(true);
  };
  $('#pk-list').onclick = (e) => {
    if (e.target.closest('#pk-more')) { pkLoad(false); return; }
    const r = e.target.closest('[data-pk]');
    if (r) openPacket(r.dataset.pk);
  };
  pkLoad(true);
  clearInterval(S.pk.timer);
  S.pk.timer = setInterval(() => {
    if (S.view !== 'packets') { clearInterval(S.pk.timer); S.pk.timer = null; S.pk.list = []; return; }
    if (S.pk.live && !document.hidden) pkPoll();
  }, 4000);
}

function pkQuery(extra = {}) {
  const f = S.pk.f;
  const q = new URLSearchParams({ limit: String(PK_PAGE) });
  if (f.type != null) q.set('type', String(f.type));
  if (f.route !== '') q.set('route', f.route);
  if (f.via) q.set('via', f.via);
  if (f.from) q.set('from', f.from);
  if (f.q) q.set('q', f.q);
  for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
  return q;
}
let pkSeq = 0;
async function pkLoad(reset) {
  const seq = ++pkSeq;
  if (reset) { S.pk.list = []; S.pk.end = false; S.pk.total = null; $('#pk-list').innerHTML = `<div class="empty">${T('pk.loading')}</div>`; }
  pkChips();
  S.pk.busy = true;
  try {
    const r = await api(`/api/packets?${pkQuery({ offset: S.pk.list.length })}`);
    if (S.view !== 'packets' || seq !== pkSeq) return;
    if (r.unsupported) { $('#pk-list').innerHTML = `<div class="empty">${T('pk.unsupported')}</div>`; return; }
    const have = new Set(S.pk.list.map((p) => p.id));
    S.pk.list.push(...r.packets.filter((p) => !have.has(p.id)));
    S.pk.total = r.total;
    S.pk.end = r.packets.length < PK_PAGE || S.pk.list.length >= PK_MAX;
    S.pk.err = null;
    pkDraw();
  } catch (e) {
    if (S.view !== 'packets' || seq !== pkSeq) return;
    S.pk.err = e;
    if (!S.pk.list.length) $('#pk-list').innerHTML = `<div class="empty">${esc(permHint(e, 'packetmonitor:read'))}</div>`;
    else toast(T('pk.loadFailed', { msg: e.message }));
  } finally { if (seq === pkSeq) S.pk.busy = false; }
}
// Live: nur Neues seit dem jüngsten Paket holen und oben einfügen (Scroll-Position bleibt stehen)
async function pkPoll() {
  if (S.pk.busy || S.view !== 'packets' || !S.pk.list.length) return;
  const newest = Math.max(...S.pk.list.map((p) => p.t || 0));
  const seq = pkSeq;
  try {
    const r = await api(`/api/packets?${pkQuery({ after: newest })}`);
    if (S.view !== 'packets' || seq !== pkSeq || !r.packets?.length) return;
    const have = new Set(S.pk.list.map((p) => p.id));
    const fresh = r.packets.filter((p) => !have.has(p.id));
    if (!fresh.length) return;
    const el = $('#pk-list');
    const before = el.scrollHeight; const top = el.scrollTop;
    S.pk.list.unshift(...fresh);
    if (S.pk.list.length > PK_MAX) { S.pk.list.length = PK_MAX; S.pk.end = true; }
    if (S.pk.total != null) S.pk.total += fresh.length;
    fresh.forEach((p) => { p._new = true; });
    pkDraw();
    if (top > 10) el.scrollTop = top + (el.scrollHeight - before);
  } catch { /* nächster Versuch in 4 s */ }
}
function pkChips() {
  const f = S.pk.f;
  const chips = [];
  if (f.via) chips.push(['via', T('pk.chipVia', { name: pkHop(f.via) })]);
  if (f.from) chips.push(['from', T('pk.chipFrom', { name: pkFrom({ from: `mc:${f.from}` }) || f.from.slice(0, 8) })]);
  if (f.q) chips.push(['q', T('pk.chipQ', { q: f.q })]);
  const el = $('#pk-chips');
  if (el) el.innerHTML = chips.map(([k, l]) => `<button class="pk-chip" data-unset="${k}">${esc(l)} <span aria-hidden="true">✕</span></button>`).join('');
}
function pkRow(p) {
  const color = pkColor(p);
  const from = pkFrom(p);
  const hops = p.hops ?? p.path.length;
  const copies = pkCopies(p).length;
  let line2 = '';
  if (p.text) line2 = `💬 ${esc(p.text)}`;
  else if (p.path.length && p.type !== 9) line2 = p.path.map((h) => esc(pkHop(h))).join(' › ');
  else if (p.type === 9 && p.path.length) line2 = esc(T('pk.traceWith', { n: p.path.length }));
  else line2 = hops === 0 ? `<span class="muted">${T('pk.heardDirect')}</span>` : '';
  const t = new Date(p.t);
  return `<button class="pk-row ${p._new ? 'pk-new' : ''}" data-pk="${esc(p.id)}">
    <span class="pk-type" style="--c:${color}">${esc(pkTypeLabel(p))}</span>
    <span class="pk-main">
      <span class="pk-l1"><b>${esc(from || '–')}</b><span class="pk-route" title="${esc(PK_ROUTE_LABEL[p.route] || p.routeName || '')}">${esc(PK_ROUTE_SHORT[p.route] || '')}${hops ? ` · ${T('common.hops', { n: hops })}` : ''}</span>${copies ? `<span class="pk-copies" title="${esc(T('pk.copiesTitle', { n: copies + 1 }))}">×${copies + 1}</span>` : ''}</span>
      <span class="pk-l2">${line2}</span>
    </span>
    <span class="pk-side"><span>${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}</span><small>${p.snr != null ? `${nf(p.snr, 1)} dB` : ''}${p.rssi != null ? ` · ${p.rssi}` : ''}</small></span>
  </button>`;
}
function pkDraw() {
  const el = $('#pk-list');
  if (!el) return;
  const n = S.pk.list.length;
  const sub = $('#pk-sub');
  if (sub) sub.textContent = n ? `${S.pk.total != null ? T('pk.countOf', { n, num: nf(n), total: nf(S.pk.total) }) : T('pk.count', { n, num: nf(n) })}${S.pk.live ? ' · live' : ''}` : T('pk.none');
  if (!n) { el.innerHTML = `<div class="empty">${T('pk.noneFilter')}</div>`; return; }
  // Kurze Typ-Übersicht der geladenen Pakete
  const counts = new Map();
  for (const p of S.pk.list) { const l = pkTypeLabel(p); counts.set(l, (counts.get(l) || 0) + 1); }
  const mix = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const bar = `<div class="pk-mix" title="${esc(T('pk.mixTitle'))}">${mix.map(([l, c]) => `<i style="flex:${c};background:${liveKind(PK_TYPE_NAME[PK_TYPES.find(([, x]) => x === l)?.[0]] || l)[0]}" title="${esc(l)}: ${c}"></i>`).join('')}</div>
    <div class="pk-mix-legend">${mix.slice(0, 6).map(([l, c]) => `<span>${esc(l)} <b>${nf(c)}</b></span>`).join('')}</div>`;
  el.innerHTML = bar + S.pk.list.map(pkRow).join('') + (S.pk.end
    ? `<div class="pk-end">${n >= PK_MAX ? T('pk.max', { n: PK_MAX }) : T('pk.end')}</div>`
    : `<button class="pk-more" id="pk-more">${T('pk.more')}</button>`);
  S.pk.list.forEach((p) => { delete p._new; });
}

// ---- Detail: Zusammenfassung + Byte-Aufschlüsselung
function openPacket(id) {
  const p = S.pk.list.find((x) => String(x.id) === String(id));
  if (!p) return;
  const d = p.raw ? pkDecode(p.raw) : null;
  const color = pkColor(p);
  const from = pkFrom(p);
  const hops = p.hops ?? p.path.length;
  const row = (k, v) => (v ? `<div class="lp-row"><span>${esc(k)}</span><b>${v}</b></div>` : '');
  const way = p.type === 9 ? null : [from || '?', ...p.path.map(pkHop), T('common.you')];
  const copies = pkCopies(p);
  const hex = d ? d.fields.map((fl, i) => `<span class="pk-f" data-fi="${i}" style="--c:${PK_FIELD_COLORS[fl.cls] || '#888'}">${p.raw.slice(fl.o * 2, (fl.o + fl.len) * 2).replace(/(..)/g, '$1 ').trim()}</span>`).join(' ') : '';
  const table = d ? d.fields.map((fl, i) => `<button class="pk-frow" data-fi="${i}" style="--c:${PK_FIELD_COLORS[fl.cls] || '#888'}"><i></i><span class="pk-fo">${fl.o}${fl.len > 1 ? `–${fl.o + fl.len - 1}` : ''}</span><span class="pk-fl">${esc(fl.label)}</span><span class="pk-fv">${esc(fl.value || T('pk.nBytes', { n: fl.len }))}</span></button>`).join('') : '';
  openSheet(`
    <div class="map-pop live-pkt pk-detail">
      <div class="lp-head"><i style="background:${color}"></i><b>${esc(pkTypeLabel(p))}</b><small>${esc(pkKind(p))}</small><span>${esc(new Date(p.t).toLocaleString(LOC))}</span></div>
      ${row(T('pk.rFrom'), esc(from || T('common.unknown')))}
      ${p.text ? row(T('pk.rText'), esc(p.text)) : ''}
      ${way ? row(T('pk.rPath'), way.map(esc).join(' › ')) : ''}
      ${row('Hops', `${nf(hops)}${hops === 0 ? ` (${T('pk.heardDirect')})` : ''} · ${esc(PK_ROUTE_LABEL[p.route] || p.routeName || '?')}`)}
      ${row(T('pk.rAtYou'), [p.snr != null ? `SNR ${nf(p.snr, 2)} dB` : '', p.rssi != null ? `RSSI ${p.rssi} dBm` : ''].filter(Boolean).join(' · '))}
      ${row(T('pk.rSize'), d ? esc(T('pk.sizeFull', { total: d.total, payload: d.total - d.payloadAt })) : p.size != null ? esc(T('pk.sizePayload', { n: p.size })) : '')}
      ${copies.length ? `<div class="pk-sec">${T('pk.copiesMore', { n: copies.length })}</div>${copies.slice(0, 8).map((c) => `<button class="pk-copy" data-pk-open="${esc(c.id)}"><span>${esc(new Date(c.t).toLocaleTimeString(LOC))}</span><b>${c.path.length ? c.path.map((h) => esc(pkHop(h))).join(' › ') : T('common.direct')}</b><small>${c.snr != null ? `${nf(c.snr, 1)} dB` : ''}</small></button>`).join('')}` : ''}
      <div class="pk-actions">
        ${p.type !== 9 && p.path.length ? `<button class="route-map" data-pk-act="map">${T('pk.mapBtn')}</button>` : ''}
        ${p.path.length && p.type !== 9 ? `<button class="route-map" data-pk-act="via">${T('pk.onlyVia', { name: esc(pkHop(p.path[p.path.length - 1])) })}</button>` : ''}
        ${p.from ? `<button class="route-map" data-pk-act="from">${T('pk.onlyFrom', { name: esc(from || T('pk.thisSender')) })}</button>` : ''}
      </div>
      ${d ? `<div class="pk-sec">${T('pk.breakdown')} <small>${T('pk.breakdownSub', { n: d.total })}</small></div>
        <div class="pk-hex" id="pk-hex">${hex}</div>
        <div class="pk-fields">${table}</div>
        ${d.errors.length ? `<div class="lp-note">⚠ ${esc(d.errors.join(' · '))}</div>` : ''}
        ${[2, 0, 1, 5, 6, 7, 8].includes(d.type) ? `<div class="lp-note">${T('pk.e2e')}</div>` : ''}
        <button class="route-map" data-pk-act="copy">${T('pk.copyRaw')}</button>`
      : `<div class="lp-note">${T('pk.noRaw')}</div>`}
    </div>
    <button class="sheet-btn cancel" data-close>${T('common.close')}</button>`, (e) => {
    const fr = e.target.closest('[data-fi]');
    if (fr) {
      const i = fr.dataset.fi;
      const on = !fr.classList.contains('hl');
      document.querySelectorAll('.pk-detail [data-fi]').forEach((x) => x.classList.toggle('hl', on && x.dataset.fi === i));
      if (on && fr.classList.contains('pk-frow')) document.querySelector(`#pk-hex [data-fi="${i}"]`)?.scrollIntoView({ block: 'nearest' });
      if (on && fr.classList.contains('pk-f')) document.querySelector(`.pk-fields [data-fi="${i}"]`)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    const o = e.target.closest('[data-pk-open]');
    if (o) { openPacket(o.dataset.pkOpen); return; }
    const act = e.target.closest('[data-pk-act]')?.dataset.pkAct;
    if (act === 'copy') { navigator.clipboard?.writeText(p.raw).then(() => toast(T('pk.copied')), () => toast(T('common.copyFailed'))); return; }
    if (act === 'map') {
      closeSheet();
      showOnMap({ title: T('pk.mapTitle', { type: pkTypeLabel(p), from: from || '?' }), numberFrom: 0, points: [
        ...(p.from ? [{ id: p.from, label: from, tag: '✉' }] : p.src ? [{ hash: p.src, label: from || `#${p.src}`, tag: '✉' }] : []),
        ...p.path.map((h) => ({ hash: h, label: pkHop(h) })), { me: true, label: T('common.you') }] });
      return;
    }
    if (act === 'via' || act === 'from') {
      closeSheet();
      if (act === 'via') { S.pk.f.via = p.path[p.path.length - 1]; S.pk.f.q = ''; const q = $('#pk-q'); if (q) q.value = S.pk.f.via; } else S.pk.f.from = p.from.slice(3);
      pkLoad(true);
    }
  });
}

function leaveMap() {
  if (S.mapFull) { S.mapFull = false; document.body.classList.remove('map-full-on'); if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); }
  if (S.view === 'map') { S.mapFocus = null; S.traceBuild = null; }
  clearInterval(S.live?.timer); if (S.live) { S.live.timer = null; S.live.active = 0; }
  clearInterval(S.mapTimer);
  S.mapTimer = null;
  if (S.map) { S.map.remove(); S.map = null; }
}

function renderMap() {
  const app = $('#app');
  if ($('.view-map', app)) return;
  S.mapDays = load('mapDays', 1);
  S.mapLinksOn = load('mapLinks', true);
  app.innerHTML = `
    <div class="view view-map">
      <header class="bar">
        <button class="icon-btn" id="back" aria-label="${esc(T('common.back'))}">${ICON.back}</button>
        <div class="bar-title"><h2>${T('map.title')}</h2><div class="sub" id="map-sub">${T('common.loading')}</div></div>
        ${S.source?.protocol === 'meshcore' ? `<button class="bar-pill${S.live.on ? ' on' : ''}" id="live-btn" title="${esc(T('map.liveTitle'))}">⚡ Live</button><button class="bar-pill" id="trace-btn" title="${esc(T('map.traceTitle'))}">🧭 Trace</button>` : ''}
      </header>
      <div class="segments" id="map-range">${MAP_RANGES.map(([d, l]) => `<button class="seg" data-days="${d}">${l}</button>`).join('')}<button class="seg" data-links="1" title="${esc(T('map.linksTitle'))}">${T('map.links')}</button></div>
      <div class="map-focus hidden" id="map-focus"></div>
      <div class="map" id="map"></div>
      <div class="map-legend live-legend${S.live.on ? '' : ' hidden'}" id="live-legend"></div>
      <div class="map-legend"><span><i style="background:#c8372d"></i>${T('common.you')}</span>${[1, 2, 3, 4].map((t) => `<span><i style="background:${MAP_COLORS[t]}"></i>${esc(TYPE[t]?.label || '')}</span>`).join('')}<span><b class="lg-line"></b>${T('map.lgSeen')}</span><span><b class="lg-line lg-dash"></b>${T('map.lgDirect')}</span><span><b class="lg-line lg-dot"></b>${T('map.lgNb')}</span></div>
    </div>`;
  $('#back').onclick = () => history.back();
  $('#map-range').onclick = (e) => {
    const b = e.target.closest('[data-days], [data-links]');
    if (!b) return;
    if (b.dataset.links) { S.mapLinksOn = !S.mapLinksOn; save('mapLinks', S.mapLinksOn); drawMap(false); return; }
    S.mapDays = Number(b.dataset.days); save('mapDays', S.mapDays);
    drawMap(!S.mapFocus);
    refreshMap(false);
  };
  const lbtn = $('#live-btn');
  if (lbtn) lbtn.onclick = () => { S.live.on = !S.live.on; save('mapLive', S.live.on); lbtn.classList.toggle('on', S.live.on); if (S.live.on) liveStart(); else liveStop(); };
  const tbtn = $('#trace-btn');
  if (tbtn) tbtn.onclick = () => { if (S.traceBuild?.busy) return; S.traceBuild = S.traceBuild ? null : { hops: [], busy: false }; if (S.traceBuild) S.mapFocus = null; drawMap(false); };
  $('#map-focus').onclick = (e) => {
    if (e.target.closest('[data-close-focus]')) { S.mapFocus = null; S.mapFocusAll = false; drawMap(true); return; }
    if (e.target.closest('[data-focus-all]')) {
      S.mapFocusAll = !S.mapFocusAll;
      if (S.mapFocusAll && S.live.resume) { S.live.resume = false; if (S.live.on && !S.live.timer) liveStart(); }
      else if (!S.mapFocusAll && S.live.timer) { liveStop(); S.live.resume = true; }
      drawMap(false);
      return;
    }
    const tb = e.target.closest('[data-tb]')?.dataset.tb;
    if (!tb || !S.traceBuild || S.traceBuild.busy) return;
    if (tb === 'undo') { S.traceBuild.hops.pop(); drawMap(false); }
    else if (tb === 'cancel') { S.traceBuild = null; drawMap(false); }
    else if (tb === 'send') sendCustomTrace();
  };
  initMap().catch((e) => { const sub = $('#map-sub'); if (sub) sub.textContent = e.message; });
}

// ------------------------------------------------------------------ Kartenstil & Vollbild
// MeshMonitor liefert über die API keine Kartenstile (die Liste steckt fest in seiner Oberfläche) – also dieselben
// freien Kachel-Dienste direkt hier. Die Kacheln lädt das Gerät selbst; gespeichert wird nur die Wahl (auf dem Gerät).
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const ESRI_ATTR = 'Tiles &copy; Esri';
const ESRI = (svc) => `https://server.arcgisonline.com/ArcGIS/rest/services/${svc}/MapServer/tile/{z}/{y}/{x}`;
// Nur Dienste ohne API-Schlüssel (CARTO verlangt inzwischen einen). native = tiefste echte Zoomstufe; darüber vergrößert Leaflet.
const MAP_STYLES = {
  auto: { name: T('ms.auto'), sub: T('ms.autoSub'), url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: OSM_ATTR, auto: true },
  osm: { name: 'OpenStreetMap', sub: T('ms.osmSub'), url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: OSM_ATTR },
  night: { name: T('ms.night'), sub: T('ms.nightSub'), url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: OSM_ATTR, invert: true, dark: true },
  dgray: { name: T('ms.dgray'), sub: T('ms.dgraySub'), url: ESRI('Canvas/World_Dark_Gray_Base'), labels: ESRI('Canvas/World_Dark_Gray_Reference'), attr: ESRI_ATTR, native: 16, dark: true },
  lgray: { name: T('ms.lgray'), sub: T('ms.lgraySub'), url: ESRI('Canvas/World_Light_Gray_Base'), labels: ESRI('Canvas/World_Light_Gray_Reference'), attr: ESRI_ATTR, native: 16 },
  hot: { name: 'Humanitarian', sub: T('ms.hotSub'), url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', attr: `${OSM_ATTR}, ${T('ms.hotAttr')}`, sd: 'abc' },
  sat: { name: T('ms.sat'), sub: 'Esri World Imagery', url: ESRI('World_Imagery'), attr: ESRI_ATTR, native: 18, dark: true },
  topo: { name: T('ms.topo'), sub: T('ms.topoSub'), url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', attr: `${OSM_ATTR}, &copy; <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a>`, sd: 'abc', native: 17 },
};
function applyMapStyle() {
  const L = window.L;
  if (!S.map) return;
  const key = MAP_STYLES[load('mapStyle', 'auto')] ? load('mapStyle', 'auto') : 'auto';
  const st = MAP_STYLES[key];
  if (S.tileLayer) S.map.removeLayer(S.tileLayer);
  if (S.labelLayer) { S.map.removeLayer(S.labelLayer); S.labelLayer = null; }
  const o = { maxZoom: 19, maxNativeZoom: st.native || 19, subdomains: st.sd || 'abc', referrerPolicy: 'strict-origin' }; // OSM: ohne Referer 403
  S.tileLayer = L.tileLayer(st.url, { ...o, attribution: st.attr }).addTo(S.map);
  S.tileLayer.bringToBack();
  if (st.labels) S.labelLayer = L.tileLayer(st.labels, o).addTo(S.map); // Ortsnamen als eigene Ebene darüber
  const v = $('.view-map');
  v?.classList.toggle('tiles-auto', Boolean(st.auto));
  v?.classList.toggle('tiles-invert', Boolean(st.invert));
  v?.classList.toggle('tiles-dark', Boolean(st.dark));
}
function openMapStyle() {
  const cur = load('mapStyle', 'auto');
  openSheet(`<div class="sheet-title">${T('map.style')}</div>
    ${Object.entries(MAP_STYLES).map(([k, st]) => `<button class="sheet-btn scope-opt ${k === cur ? 'active' : ''}" data-mapstyle="${k}"><span>${esc(st.name)}<small>${esc(st.sub)}</small></span>${k === cur ? `<i>${ICON.check}</i>` : ''}</button>`).join('')}
    <div class="hint" style="padding:6px 12px">${T('map.styleHint')}</div>
    <button class="sheet-btn cancel" data-close>${T('common.close')}</button>`, (e) => {
    const b = e.target.closest('[data-mapstyle]');
    if (!b) return;
    save('mapStyle', b.dataset.mapstyle);
    applyMapStyle();
    closeSheet();
  });
}
// Knöpfe oben rechts auf der Karte: Kartenstil und Vollbild
function addMapTools() {
  const L = window.L;
  const Tools = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const box = L.DomUtil.create('div', 'leaflet-bar map-tools');
      box.innerHTML = `<a href="#" role="button" data-mt="style" title="${esc(T('map.style'))}" aria-label="${esc(T('map.style'))}"><svg viewBox="0 0 24 24"><path d="M12 3 2 8l10 5 10-5-10-5Z"/><path d="m2 13 10 5 10-5"/></svg></a>
        <a href="#" role="button" data-mt="full" title="${esc(T('map.full'))}" aria-label="${esc(T('map.full'))}"><svg viewBox="0 0 24 24" class="mt-open"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg><svg viewBox="0 0 24 24" class="mt-close"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg></a>`;
      L.DomEvent.disableClickPropagation(box);
      box.onclick = (e) => {
        const a = e.target.closest('[data-mt]');
        if (!a) return;
        e.preventDefault();
        if (a.dataset.mt === 'style') openMapStyle(); else toggleMapFull();
      };
      return box;
    },
  });
  new Tools().addTo(S.map);
}
// Vollbild: die Karte füllt den ganzen Bildschirm (ohne Kopf, Zeitraum und Legende). Wo der Browser es kann, zusätzlich
// echtes Vollbild (ohne Browser-Leisten; auf dem iPhone nicht möglich – dort nur die App-Fläche). Zurück: Knopf,
// Zurück-Geste/-Taste oder Esc.
function toggleMapFull(on = !S.mapFull) {
  const v = $('.view-map');
  if (!v || on === Boolean(S.mapFull)) return;
  S.mapFull = on;
  v.classList.toggle('map-full', on);
  document.body.classList.toggle('map-full-on', on);
  if (on) {
    history.pushState({ view: 'map', mapFull: true }, '');
    const de = document.documentElement;
    if (de.requestFullscreen && !document.fullscreenElement) de.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  } else {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    if (history.state?.mapFull) { S.mapFullPop = true; history.back(); }
  }
  setTimeout(() => S.map?.invalidateSize(), 60);
  setTimeout(() => S.map?.invalidateSize(), 400);
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && S.mapFull) toggleMapFull(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.mapFull) toggleMapFull(false); });

async function initMap() {
  await loadLeaflet();
  if (S.view !== 'map' || !$('#map') || S.map) return;
  const L = window.L;
  S.map = L.map('map', { zoomControl: true, attributionControl: true, worldCopyJump: true }).setView([51.16, 10.45], 6);
  applyMapStyle();
  addMapTools();
  S.linkLayer = L.layerGroup().addTo(S.map);
  S.mapLayer = L.layerGroup().addTo(S.map);
  S.focusLayer = L.layerGroup().addTo(S.map);
  // Live-Pakete über allem (auch über den Node-Punkten), aber nicht klickbar
  S.map.createPane('livePane');
  S.map.getPane('livePane').style.zIndex = 650;
  S.map.getPane('livePane').style.pointerEvents = 'none';
  S.liveLayer = L.layerGroup().addTo(S.map);
  S.map.on('zoomend', rescaleMap);
  // Leaflet hält Klicks im Popup zurück -> Knöpfe direkt beim Öffnen verdrahten
  S.map.on('popupopen', (e) => {
    const el = e.popup.getElement();
    const dm = el?.querySelector('[data-map-dm]');
    if (dm) dm.onclick = () => go('chat', `dm:${dm.dataset.mapDm}`);
    const det = el?.querySelector('[data-map-node]');
    if (det) det.onclick = () => go('node', det.dataset.mapNode);
  });
  await refreshMap(true);
  S.mapTimer = setInterval(() => { if (!document.hidden) refreshMap(false); }, 60000);
  if (S.live.on && S.source?.protocol === 'meshcore') {
    if (S.mapFocus && !S.mapFocusAll) S.live.resume = true; // kommt mit Fokus (Weg, Reach …): erst nach dem Schließen
    else liveStart();
  }
}

// ------------------------------------------------------------------ Live-Pakete auf der Karte
// Jedes gehörte Paket fliegt als Punkt vom Absender über die Repeater (soweit Position bekannt) zu dir.
// Daten: Paket-Log von MeshMonitor über den MeshLink-Chat-Server (alle 3 s, nur solange Live an ist und die Karte offen).
const LIVE_KINDS = {
  ADVERT: ['#7b61ff', T('pk.tAdvert')], GRP_TXT: ['#00a3a3', T('pk.tChannel')], TXT_MSG: ['#e0482f', 'DM'], ACK: ['#8f9b96', 'ACK'],
  PATH: ['#c99a00', T('pk.tPath')], TRACE: ['#ff4fa3', 'Trace'], REQ: ['#3a8fd6', T('live.query')], RESPONSE: ['#3a8fd6', T('live.query')], ANON_REQ: ['#3a8fd6', T('live.query')],
};
const liveKind = (k) => LIVE_KINDS[k] || ['#6b7a74', T('stats.typeOther')];
S.live = { on: load('mapLive', false), after: 0, timer: null, active: 0, recent: [], noPos: 0 };

function liveStart() {
  clearInterval(S.live.timer);
  S.live.after = 0; S.live.recent = []; S.live.noPos = 0; S.live.first = true; S.live.err = null;
  $('#live-legend')?.classList.remove('hidden');
  drawLiveLegend();
  livePoll();
  S.live.timer = setInterval(() => { if (S.view !== 'map' || !S.map) { liveStop(); return; } if (!document.hidden) livePoll(); }, 3000);
}
function liveStop() {
  clearInterval(S.live.timer); S.live.timer = null;
  S.liveLayer?.clearLayers(); S.live.ghosts = [];
  S.map?.closePopup();
  $('#live-legend')?.classList.add('hidden');
}
async function livePoll() {
  if (S.live.busy) return;
  S.live.busy = true;
  try {
    const r = await api(`/api/live?after=${S.live.after}`);
    const first = S.live.first; S.live.first = false;
    S.live.after = r.seq || 0;
    S.live.err = r.error ? `MeshMonitor: ${r.error}` : null;
    // Beim Einschalten nichts Altes nachspielen; danach die Pakete über die 3 s verteilt wie empfangen
    const list = first ? [] : r.flights || [];
    const t0 = list.length ? list[0].t : 0;
    for (const f of list) setTimeout(() => { if (S.live.timer) liveFly(f); }, Math.min(2800, Math.max(0, f.t - t0)));
  } catch (e) { S.live.err = e.status === 403 ? T('live.noPerm') : e.message; }
  S.live.busy = false;
  drawLiveLegend();
}
// Absender eines Pakets: voller Schlüssel (Advert) oder 1-Byte-Kennung – nur, wenn sie eindeutig ist
function liveOrigin(f) {
  if (f.from) return mapPoint({ id: f.from });
  if (!f.src) return null;
  const c = (S.mapData?.nodes || []).filter((x) => x.id.startsWith('mc:') && x.id.slice(3).toLowerCase().startsWith(f.src));
  return c.length === 1 ? c[0] : null;
}
function liveFly(f) {
  const L = window.L;
  if (!L || !S.map || !S.liveLayer) return;
  const now = Date.now();
  S.live.recent.push({ t: now, kind: f.kind });
  const raw = [liveOrigin(f), ...f.path.map((h) => mapPoint({ hash: h })), mapPoint({ me: true })];
  const pts = [];
  for (const p of raw) {
    if (!p || p.lat == null) continue;
    const last = pts[pts.length - 1];
    if (!last || last[0] !== p.lat || last[1] !== p.lon) pts.push([p.lat, p.lon]);
  }
  if (pts.length < 2 || S.live.active >= 30) { S.live.noPos++; return; }
  S.live.active++;
  const [color] = liveKind(f.kind);
  const opt = { pane: 'livePane', interactive: false };
  const sc = mapScale();
  const lw = Math.max(1.8, 3 * sc.line);
  const casing = L.polyline([pts[0]], { ...opt, color: '#fff', weight: lw + 2.5, opacity: 0.6, lineCap: 'round' }).addTo(S.liveLayer);
  const line = L.polyline([pts[0]], { ...opt, color, weight: lw, opacity: 0.95, lineCap: 'round' }).addTo(S.liveLayer);
  const head = L.circleMarker(pts[0], { ...opt, radius: Math.max(3.5, 5 * sc.dot + 1), color: '#fff', weight: 1.5, fillColor: color, fillOpacity: 1 }).addTo(S.liveLayer);
  const segMs = Math.max(180, Math.min(600, 2400 / (pts.length - 1)));
  const start = performance.now();
  let rippled = 0; // bis zu welchem Punkt schon eine Welle lief
  const step = (ts) => {
    if (!S.map) return;
    const pos = Math.max(0, (ts - start) / segMs); // erster Frame kann minimal vor "start" liegen
    const i = Math.min(pts.length - 2, Math.floor(pos));
    const k = Math.min(1, pos - i);
    const a = pts[i]; const b = pts[i + 1];
    const cur = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    const drawn = [...pts.slice(0, i + 1), cur];
    line.setLatLngs(drawn); casing.setLatLngs(drawn);
    head.setLatLng(cur);
    while (rippled < i) liveRipple(pts[++rippled], color); // Repeater erreicht: kleine Welle
    if (pos < pts.length - 1) { requestAnimationFrame(step); return; }
    liveRipple(pts[pts.length - 1], color, true);
    // angekommen: kurz aufleuchten, dann zur blassen, antippbaren Spur werden
    head.setStyle({ radius: head.getRadius() * 1.5 });
    const fadeStart = performance.now();
    const fade = (t2) => {
      const k2 = Math.min(1, (t2 - fadeStart) / 900);
      if (!S.map) return;
      line.setStyle({ opacity: 0.95 - 0.6 * k2 }); casing.setStyle({ opacity: 0.7 * (1 - k2) }); head.setStyle({ opacity: 1 - k2, fillOpacity: 1 - k2 });
      if (k2 < 1) { requestAnimationFrame(fade); return; }
      S.liveLayer?.removeLayer(casing); S.liveLayer?.removeLayer(head);
      S.live.active = Math.max(0, S.live.active - 1);
      liveGhost(f, line, pts);
    };
    requestAnimationFrame(fade);
  };
  requestAnimationFrame(step);
}

// „Stein ins Wasser“: zwei dünne Ringe laufen auseinander und verblassen (reines CSS, ~1,2 s, dann weg).
// Kein Klickziel, liegt in der Live-Ebene; bei „Bewegung reduzieren“ im System aus.
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
function liveRipple(ll, color, end = false) {
  const L = window.L;
  if (!L || !S.liveLayer || reduceMotion?.matches) return;
  const size = Math.round((end ? 40 : 32) + 20 * mapScale().dot);
  const icon = L.divIcon({ className: 'live-ripple', iconSize: [0, 0], html: `<i style="--c:${color};--s:${size}px"></i><i style="--c:${color};--s:${size}px"></i>` });
  const mk = L.marker(ll, { icon, pane: 'livePane', interactive: false, keyboard: false }).addTo(S.liveLayer);
  setTimeout(() => S.liveLayer?.removeLayer(mk), 1800);
}

// Nachlauf: die Spur bleibt ~12 s blass stehen und lässt sich antippen (breite unsichtbare Trefferlinie fürs Handy).
// Antippen zeigt, was für ein Paket es war; solange das Fenster offen ist, bleibt die Spur stehen.
const LIVE_GHOST_MS = 12000;
function liveGhost(f, line, pts) {
  const L = window.L;
  // Trefferlinie UNTER den Node-Punkten (normale Ebene): Nodes bleiben antippbar, die Spur daneben auch
  const hit = L.polyline(pts, { color: '#000', opacity: 0.001, weight: 16, lineCap: 'round', bubblingMouseEvents: false }).addTo(S.liveLayer);
  const g = { f, line, hit, until: Date.now() + LIVE_GHOST_MS, open: false };
  S.live.ghosts = (S.live.ghosts || []).filter((x) => S.liveLayer?.hasLayer(x.line));
  S.live.ghosts.push(g);
  while (S.live.ghosts.length > 60) liveDropGhost(S.live.ghosts[0]);
  hit.on('click', (e) => {
    g.open = true;
    g.w = g.w || line.options.weight;
    line.setStyle({ opacity: 1, weight: g.w * 1.6 });
    line.bringToFront();
    L.popup({ className: 'live-pop', maxWidth: 260, autoPanPadding: [16, 16] }).setLatLng(e.latlng).setContent(livePacketHtml(f)).openOn(S.map)
      .on('remove', () => { g.open = false; g.until = Math.max(g.until, Date.now() + 3000); line.setStyle({ opacity: 0.35, weight: g.w }); });
  });
  const tick = () => {
    if (!S.map || !S.liveLayer?.hasLayer(line)) return;
    if (!g.open && Date.now() > g.until) {
      // sanft ausblenden, dann weg
      const t0 = performance.now();
      const out = (t) => {
        if (g.open) { setTimeout(tick, 500); return; } // währenddessen angetippt: stehen lassen
        const o = 0.35 * (1 - (t - t0) / 800);
        if (o <= 0) { liveDropGhost(g); return; }
        line.setStyle({ opacity: o }); requestAnimationFrame(out);
      };
      requestAnimationFrame(out);
      return;
    }
    setTimeout(tick, 500);
  };
  setTimeout(tick, 500);
}
function liveDropGhost(g) {
  S.liveLayer?.removeLayer(g.line); S.liveLayer?.removeLayer(g.hit);
  if (S.live.ghosts) S.live.ghosts = S.live.ghosts.filter((x) => x !== g);
}
// Name zu einem Repeater-Hash (alle bekannten Nodes, nicht nur mit Position); mehrdeutig -> "#ab?"
function liveHopName(h) {
  const all = [...(S.nodes?.values?.() || [])].filter((n) => n.id?.startsWith('mc:') && n.id.slice(3).toLowerCase().startsWith(h));
  const rep = all.filter((n) => n.type === 2 || n.type === 3);
  const one = rep.length === 1 ? rep[0] : all.length === 1 ? all[0] : null;
  return one ? one.long || one.short || `#${h}` : `#${h}${all.length > 1 ? '?' : ''}`;
}
// Zurückgelegte Strecke: Summe der Funkstrecken Absender › Repeater › du (Luftlinie je Strecke), dazu die direkte
// Luftlinie. Stationen ohne Position werden übersprungen – dann ist es ein Mindestwert.
function liveDistanceRows(f, row) {
  const me = mapPoint({ me: true });
  if (!me) return row(T('live.distance'), T('live.noOwnPos'));
  const stops = [liveOrigin(f), ...f.path.map((h) => mapPoint({ hash: h }))];
  const known = stops.filter((p) => p && p.lat != null);
  const missing = stops.length - known.length;
  const pts = [...known, me];
  if (pts.length < 2) return row(T('live.distance'), T('live.noPos'));
  let km = 0;
  for (let i = 1; i < pts.length; i++) km += distKm(pts[i - 1], pts[i]);
  const legs = pts.length - 1;
  const originOk = Boolean(stops[0] && stops[0].lat != null);
  const main = `${missing ? `${T('live.atLeast')} ` : ''}${T('live.legs', { n: legs, km: fmtKm(km) })}`;
  const note = missing ? `<small class="lp-note">${esc(T('live.missing', { n: missing }))}${originOk ? '' : ` ${esc(T('live.alsoSender'))}`}</small>` : '';
  return row(T('live.distance'), `${esc(main)}${note}`) + (originOk && legs > 1 ? row(T('live.airline'), esc(T('live.directToSender', { km: fmtKm(distKm(stops[0], me)) }))) : '');
}
function livePacketHtml(f) {
  const [color, label] = liveKind(f.kind);
  const fromNode = f.from ? node(f.from) : null;
  let from = f.name || fromNode?.long || fromNode?.short || null;
  if (!from && f.src) { const n = liveOrigin(f); from = n ? n.long || n.short : `#${f.src}`; }
  const hops = f.hops ?? f.path.length;
  const way = [from || T('common.unknown'), ...f.path.map(liveHopName), T('common.you')];
  const ago = Math.max(0, Math.round((Date.now() - f.t) / 1000));
  const row = (k, v) => (v ? `<div class="lp-row"><span>${esc(k)}</span><b>${v}</b></div>` : '');
  const sig = [f.snr != null ? `SNR ${nf(f.snr, 1)} dB` : '', f.rssi != null ? `RSSI ${nf(f.rssi)} dBm` : ''].filter(Boolean).join(' · ');
  const route = { FLOOD: T('live.rFlood'), DIRECT: T('live.rDirect'), TRANSPORT_FLOOD: T('pk.rFloodScope'), TRANSPORT_DIRECT: T('pk.rDirectScope') }[f.route] || f.route;
  return `<div class="map-pop live-pkt">
    <div class="lp-head"><i style="background:${color}"></i><b>${esc(label)}</b><small>${esc(f.kind || '')}</small><span>${ago < 60 ? T('live.agoS', { n: ago }) : T('live.agoMin', { n: Math.round(ago / 60) })}</span></div>
    ${row(T('pk.rFrom'), esc(from || T('common.unknown')))}
    ${row(T('pk.rPath'), way.map(esc).join(' › '))}
    ${row('Hops', `${nf(hops)}${hops === 0 ? ` (${T('pk.heardDirect')})` : ''}${route ? ` · ${esc(route)}` : ''}`)}
    ${liveDistanceRows(f, row)}
    ${row(T('pk.rAtYou'), esc(sig))}
    ${row(T('pk.rSize'), f.size != null ? esc(T('pk.nBytes', { n: nf(f.size) })) : '')}
    ${row(T('live.time'), esc(new Date(f.t).toLocaleTimeString(LOC)))}
  </div>`;
}
function drawLiveLegend() {
  const el = $('#live-legend');
  if (!el || !S.live.on) return;
  const cut = Date.now() - 60000;
  S.live.recent = S.live.recent.filter((x) => x.t >= cut);
  const n = S.live.recent.length;
  const seen = [...new Set(S.live.recent.map((x) => liveKind(x.kind)[1]))];
  const kinds = Object.values(LIVE_KINDS).filter(([, l], i, a) => a.findIndex(([, l2]) => l2 === l) === i);
  el.innerHTML = `<span class="live-dot">⚡ <b>Live</b>&nbsp;${S.live.err ? `<em class="tb-err">${esc(S.live.err)}</em>` : `${T('live.perMin', { n, num: nf(n) })}${S.live.noPos ? ` · ${T('live.noPosCount', { n: nf(S.live.noPos) })}` : ''}`}</span>${kinds.map(([c, l]) => `<span class="${seen.includes(l) ? '' : 'dim'}"><b class="lg-line" style="border-color:${c}"></b>${esc(l)}</span>`).join('')}`;
}

async function refreshMap(fit) {
  try {
    S.mapData = await api(`/api/map?days=${S.mapDays}`);
    drawMap(fit);
  } catch (e) { const sub = $('#map-sub'); if (sub) sub.textContent = T('common.error', { msg: e.message }); }
}

// Position zu einem Punkt eines Wegs: Node-ID, Name oder Repeater-Hash (nur eindeutig)
function mapPoint(p) {
  if (p.lat != null && p.lon != null) return { lat: p.lat, lon: p.lon, long: p.label || '' }; // freie Koordinate
  const all = S.mapData?.nodes || [];
  let n = null;
  if (p.me) n = all.find((x) => x.local) || null;
  else if (p.id) n = all.find((x) => x.id === p.id) || null;
  if (!n && p.name) { const c = all.filter((x) => x.long === p.name); n = c.length === 1 ? c[0] : null; }
  if (!n && p.hash) {
    const c = all.filter((x) => x.id.startsWith('mc:') && x.id.slice(3).toLowerCase().startsWith(p.hash));
    const pref = c.filter((x) => x.type === 2 || x.type === 3);
    n = pref.length === 1 ? pref[0] : c.length === 1 ? c[0] : null;
  }
  return n;
}

function drawFocus() {
  const L = window.L;
  S.focusLayer.clearLayers();
  const bar = $('#map-focus');
  if (S.traceBuild) return drawTraceBuild(bar);
  const f = S.mapFocus;
  if (!f) { bar.classList.add('hidden'); return null; }
  if (f.kind === 'legs') return drawTraceLegs(bar, f);
  if (f.kind === 'star') {
    const c = mapPoint(f.center);
    const leaves = f.leaves.map((p) => ({ ...p, n: mapPoint(p) }));
    const known = leaves.filter((p) => p.n);
    if (c) {
      for (const p of known) {
        const km = distKm(c, p.n);
        L.polyline([[c.lat, c.lon], [p.n.lat, p.n.lon]], { color: p.color || snrColor(p.snr), weight: FOCUS_LINE, opacity: 0.9, interactive: false }).addTo(S.focusLayer);
        // breite, unsichtbare Trefferlinie fürs Antippen; zeigt ein kleines Fenster statt eines Tooltips
        L.polyline([[c.lat, c.lon], [p.n.lat, p.n.lon]], { color: '#000', opacity: 0.001, weight: 18, bubblingMouseEvents: false })
          .on('click', (e) => L.popup({ className: 'live-pop', maxWidth: 260, autoPanPadding: [16, 16] }).setLatLng(e.latlng)
            .setContent(p.pop ? p.pop(km) : `<div class="map-pop live-pkt"><div class="lp-head"><i style="background:${p.color || snrColor(p.snr)}"></i><b>${esc(p.label)}</b></div><div class="lp-row"><span>${T('live.distanceLabel')}</span><b>${esc(T('stats.airline', { km: fmtKm(km) }))}</b></div></div>`).openOn(S.map))
          .addTo(S.focusLayer);
      }
      L.marker([c.lat, c.lon], { icon: L.divIcon({ className: 'focus-pin', html: '<span>★</span>', iconSize: [22, 22] }) }).bindTooltip(esc(f.center.label || '')).addTo(S.focusLayer);
    }
    bar.classList.remove('hidden');
    bar.innerHTML = `<div><b>${esc(f.title)}</b><small>${c ? `${T('focus.nOf', { k: known.length, n: leaves.length })} ${esc(f.note || T('focus.nbNote'))}` : T('focus.noPos')}</small></div>${focusAllBtn()}<button class="icon-btn" data-close-focus aria-label="${esc(T('focus.hide'))}">${ICON.close}</button>`;
    const pts = [...(c ? [[c.lat, c.lon]] : []), ...known.map((p) => [p.n.lat, p.n.lon])];
    return pts.length ? L.latLngBounds(pts) : null;
  }
  const pts = f.points.map((p) => ({ ...p, n: mapPoint(p) }));
  const known = pts.filter((p) => p.n);
  // Linie: durchgezogen zwischen bekannten Nachbarn, gestrichelt über unbekannte Stationen hinweg
  // An jedem Teilstück steht die Luftlinie in km; über eine Lücke hinweg ist das eine Mindeststrecke.
  let prev = null;
  let gap = false;
  let total = 0;
  let anyGap = false;
  for (const p of pts) {
    if (!p.n) { gap = true; continue; }
    if (prev) {
      const d = distKm(prev.n, p.n);
      total += d;
      anyGap = anyGap || gap;
      L.polyline([[prev.n.lat, prev.n.lon], [p.n.lat, p.n.lon]], { color: '#c8372d', weight: FOCUS_LINE, opacity: 0.9, dashArray: gap ? '6 8' : null })
        .bindTooltip(`${gap ? '≥ ' : ''}${fmtKm(d)}`, { permanent: true, direction: 'center', className: 'seg-km' }).addTo(S.focusLayer);
    }
    prev = p; gap = false;
  }
  const partial = anyGap || !pts[0]?.n || !pts[pts.length - 1]?.n; // Lücke mittendrin oder Anfang/Ende ohne Position
  pts.forEach((p, i) => {
    if (!p.n) return;
    L.marker([p.n.lat, p.n.lon], { icon: L.divIcon({ className: 'focus-pin', html: `<span>${p.me ? '•' : esc(p.tag ?? i + (f.numberFrom ?? 0))}</span>`, iconSize: [22, 22] }) })
      .bindTooltip(esc(p.label || (p.me ? T('common.you') : '') || p.n.long || p.n.short || ''), { direction: 'top', offset: [0, -10] }).addTo(S.focusLayer);
  });
  bar.classList.remove('hidden');
  const missing = pts.length - known.length;
  bar.innerHTML = `<div><b>${esc(f.title)}${known.length > 1 ? ` · ${partial ? `${T('live.atLeast')} ` : ''}${fmtKm(total)}` : ''}</b><small>${T('focus.stations', { k: known.length, n: pts.length })}${missing ? ` · ${T('focus.dashed')}` : ''}${known.length > 1 ? ` · ${T('focus.airline')}` : ''}</small></div>${focusAllBtn()}<button class="icon-btn" data-close-focus aria-label="${esc(T('focus.hidePath'))}">${ICON.close}</button>`;
  return known.length ? L.latLngBounds(known.map((p) => [p.n.lat, p.n.lon])) : null;
}

// ---- Eigene Traceroute: Repeater auf der Karte in Reihenfolge antippen, der letzte ist das Ziel
const TRACE_MAX = 8;
function addTraceHop(n) {
  const tb = S.traceBuild;
  if (!tb || tb.busy) return;
  if (n.local) { toast(T('trace.meAuto')); return; }
  if (n.type !== 2 && n.type !== 3) { toast(T('trace.onlyRpt')); return; }
  if (tb.hops.some((h) => h.id === n.id)) { toast(T('trace.dup')); return; }
  if (tb.hops.length >= TRACE_MAX) { toast(T('trace.max', { n: TRACE_MAX })); return; }
  tb.hops.push({ id: n.id, label: n.long || n.short || n.id.slice(3, 11) });
  drawMap(false);
}

function drawTraceBuild(bar) {
  const L = window.L;
  const tb = S.traceBuild;
  const me = (S.mapData?.nodes || []).find((x) => x.local);
  const pts = [me, ...tb.hops.map((h) => mapPoint({ id: h.id }))].filter(Boolean);
  if (pts.length > 1) L.polyline(pts.map((p) => [p.lat, p.lon]), { color: '#c8372d', weight: 3, opacity: 0.8, dashArray: '6 6' }).addTo(S.focusLayer);
  tb.hops.forEach((h, i) => {
    const p = mapPoint({ id: h.id });
    if (p) L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'focus-pin', html: `<span>${i + 1}</span>`, iconSize: [22, 22] }), interactive: false }).addTo(S.focusLayer);
  });
  bar.classList.remove('hidden');
  const chain = tb.hops.length ? `${T('common.you')} › ${tb.hops.map((h, i) => `${esc(h.label)}${i === tb.hops.length - 1 ? ` ${T('trace.target')}` : ''}`).join(' › ')}` : '';
  const secs = tb.busy ? Math.round((Date.now() - tb.started) / 1000) : 0;
  const status = !tb.busy && tb.status ? `<small class="${tb.status.err ? 'tb-err' : ''}">${esc(tb.status.text)}</small>` : '';
  bar.innerHTML = `<div><b>${tb.busy ? `${T('trace.running', { s: secs })} <span class="muted">${T('trace.upTo')}</span>` : T('trace.own')}</b><small>${chain || T('trace.howto')}</small>${status}</div>
    ${tb.hops.length && !tb.busy ? `<button class="icon-btn" data-tb="undo" aria-label="${esc(T('trace.undo'))}">↶</button>` : ''}
    ${!tb.busy ? `<button class="icon-btn" data-tb="cancel" aria-label="${esc(T('common.cancel'))}">${ICON.close}</button>` : ''}
    <button class="pill primary-pill" data-tb="send" ${!tb.hops.length || tb.busy ? 'disabled' : ''}>${T('common.send')}</button>`;
  return null;
}

async function sendCustomTrace() {
  const tb = S.traceBuild;
  if (!tb?.hops.length || tb.busy) return;
  tb.busy = true; tb.started = Date.now(); tb.status = null; drawMap(false);
  // Sekunden mitzählen, damit man sieht, dass etwas passiert
  const tick = setInterval(() => { if (S.traceBuild === tb && tb.busy && S.view === 'map') drawTraceBuild($('#map-focus')); else clearInterval(tick); }, 1000);
  const finish = (status) => { clearInterval(tick); tb.busy = false; tb.status = status; if (S.view === 'map') drawMap(false); };
  try {
    const r = await api('/api/node/trace-custom', { method: 'POST', body: { hops: tb.hops.map((h) => h.id) } });
    if (S.traceBuild !== tb) { clearInterval(tick); return; }
    if (!r.ok) {
      finish({ err: true, text: `✘ ${T('trace.noAnswer', { s: Math.round((r.ms || Date.now() - tb.started) / 1000) })}` });
      return;
    }
    clearInterval(tick);
    // Teilstrecken: Du → Station 1 → … → Ziel → … → Du; SNR i = Empfang an Station i, lastSnr = Empfang bei dir
    const seq = [{ me: true, key: 'me', label: T('common.you') }, ...r.path.map((p) => ({ id: p.id, hash: p.hash, key: p.id || `#${p.hash}`, label: p.name || `#${p.hash}` })), { me: true, key: 'me', label: T('common.you') }];
    const legs = new Map();
    for (let i = 0; i < seq.length - 1; i++) {
      const a = seq[i]; const b = seq[i + 1];
      const snr = i < r.snrs.length ? r.snrs[i] : r.lastSnr;
      const k = [a.key, b.key].sort().join('|');
      const leg = legs.get(k) || { a, b, out: null, back: null };
      if (leg.out == null && leg.a.key === a.key) leg.out = snr; else leg.back = snr;
      legs.set(k, leg);
    }
    S.traceBuild = null;
    S.mapFocus = { kind: 'legs', title: T('trace.done', { name: tb.hops[tb.hops.length - 1].label, s: nf((r.ms || 0) / 1000, 1) }), stations: [seq[0], ...tb.hops.map((h) => ({ id: h.id, label: h.label }))], legs: [...legs.values()] };
    drawMap(false);
  } catch (e) {
    if (S.traceBuild !== tb) { clearInterval(tick); return; }
    const text = e.code === 'NOT_A_CONTACT' ? e.message : e.code === 'TRACE_BUSY' ? T('trace.busy')
      : e.status === 403 ? T('trace.noPerm')
        : e.code === 'MESHCORE_TRACE_FAILED' ? T('trace.failed')
          : e.status === 429 ? T('trace.tooMany')
            : T('common.error', { msg: e.message });
    finish({ err: true, text: `✘ ${text}` });
  }
}

function drawTraceLegs(bar, f) {
  const L = window.L;
  const all = [];
  for (const leg of f.legs) {
    const a = mapPoint(leg.a); const b = mapPoint(leg.b);
    if (!a || !b) continue;
    all.push([a.lat, a.lon], [b.lat, b.lon]);
    const worst = [leg.out, leg.back].filter((v) => v != null);
    const v = (x) => (x == null ? '–' : `${nf(x, 1)} dB`);
    L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: snrColor(worst.length ? Math.min(...worst) : null), weight: FOCUS_LINE, opacity: 0.9 })
      .bindTooltip(`→ ${v(leg.out)} · ← ${v(leg.back)} · ${fmtKm(distKm(a, b))}`, { permanent: true, direction: 'center', className: 'seg-km' }).addTo(S.focusLayer);
  }
  f.stations.forEach((st, i) => {
    const p = mapPoint(st);
    if (p) L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'focus-pin', html: `<span>${i ? i : '•'}</span>`, iconSize: [22, 22] }) }).bindTooltip(esc(st.label), { direction: 'top', offset: [0, -10] }).addTo(S.focusLayer);
  });
  const missing = f.legs.filter((l) => !mapPoint(l.a) || !mapPoint(l.b)).length;
  bar.classList.remove('hidden');
  bar.innerHTML = `<div><b>${esc(f.title)}</b><small>${T('trace.legsNote')}${missing ? ` · ${T('trace.legsMissing', { n: missing })}` : ''}</small></div>${focusAllBtn()}<button class="icon-btn" data-close-focus aria-label="${esc(T('focus.hide'))}">${ICON.close}</button>`;
  return all.length ? L.latLngBounds(all) : null;
}

// SNR einer Trace-Station: nur hin ("6,5 dB") oder hin und zurück ("→ 6,5 · ← 4 dB")
function traceSnr(h) {
  if (h.snr == null && h.back == null) return '';
  if (h.back == null) return `${nf(h.snr, 1)} dB`;
  return `→ ${h.snr == null ? '–' : nf(h.snr, 1)} · ← ${nf(h.back, 1)} dB`;
}
// Entfernung zwischen zwei Positionen (Luftlinie, Haversine)
function distKm(a, b) {
  const R = 6371; const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad; const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
// Himmelsrichtung von a nach b (N, NO, O, …)
function compass(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return T('map.compass').split(' ')[Math.round((((Math.atan2(y, x) / rad) + 360) % 360) / 45) % 8];
}
const fmtKm = (km) => `${km < 1 ? km.toLocaleString(LOC, { maximumFractionDigits: 2 }) : km.toLocaleString(LOC, { maximumFractionDigits: 1 })} km`;

const snrColor = (v) => (v == null ? '#888' : v >= 5 ? '#1f9d6b' : v >= -5 ? '#d9a12b' : '#c8372d');

// Größe von Punkten und Linien nach Zoomstufe: weit herausgezoomt (viele Nodes) klein, nah wie gewohnt
function mapScale() {
  const z = S.map ? S.map.getZoom() : 10;
  const dot = z >= 13 ? 1 : z >= 12 ? 0.85 : z >= 11 ? 0.7 : z >= 10 ? 0.55 : z >= 9 ? 0.45 : 0.38;
  return { dot, line: 0.45 + 0.55 * dot, border: dot >= 0.7 ? 1.5 : 1 };
}
const dotRadius = (n, sc) => (n.local ? Math.max(5, 9 * sc.dot) : Math.max(2.5, (n.type === 2 ? 7 : 6) * sc.dot));
function rescaleMap() {
  const sc = mapScale();
  for (const [mk, n] of S.mapDots || []) { mk.setRadius(dotRadius(n, sc)); mk.setStyle({ weight: sc.border }); }
  for (const [pl, base] of S.mapLines || []) pl.setStyle({ weight: base * sc.line });
}

function drawMap(fit) {
  const L = window.L;
  document.querySelectorAll('#map-range .seg[data-days]').forEach((b) => b.classList.toggle('active', Number(b.dataset.days) === S.mapDays));
  $('#map-range .seg[data-links]')?.classList.toggle('active', Boolean(S.mapLinksOn));
  $('#trace-btn')?.classList.toggle('on', Boolean(S.traceBuild));
  if (!S.map || !S.mapData || !L) return;
  const since = Date.now() - S.mapDays * 86400000;
  // Fokus (Weg, Reach, Nachbarn, Traceroute): nur die beteiligten Nodes, keine Linien, Live pausiert –
  // über „Alle Nodes“ in der Fokus-Leiste wieder einblendbar
  const focusOnly = Boolean(S.mapFocus) && !S.mapFocusAll;
  $('.view-map')?.classList.toggle('focus-only', focusOnly);
  if (focusOnly && S.live.pauseForFocus) {
    S.live.pauseForFocus = false;
    if (S.live.timer) { liveStop(); S.live.resume = true; }
  }
  if (!S.mapFocus && S.live.resume) { S.live.resume = false; if (S.live.on && !S.live.timer && S.source?.protocol === 'meshcore') liveStart(); }
  $('#live-btn')?.classList.toggle('paused', Boolean(S.live.resume));
  const keep = focusOnly ? focusNodeIds(S.mapFocus) : null;
  const list = S.mapData.nodes.filter((n) => (keep ? keep.has(n.id) || (n.local && keep.has('me')) : n.local || (n.lastHeard || 0) >= since));
  const noPos = S.mapData.noPos.filter((t) => t >= since).length;
  // Verbindungen
  S.linkLayer.clearLayers();
  S.mapLines = []; S.mapDots = [];
  const links = S.mapLinksOn && !focusOnly ? S.mapData.links || [] : [];
  const sc = mapScale();
  for (const l of links) {
    const direct = l.kind === 'direct';
    const nb = l.kind === 'nb';
    const base = direct ? 2 : nb ? 1.5 : Math.min(4, 1.2 + Math.log2(l.n) * 0.7);
    const pl = L.polyline([l.a, l.b], direct
      ? { color: snrColor(l.snr), weight: base * sc.line, opacity: 0.75, dashArray: '4 6' }
      : nb ? { color: snrColor(l.snr), weight: base * sc.line, opacity: 0.5, dashArray: '1 5' }
        : { color: '#1f6f5c', weight: base * sc.line, opacity: 0.55 });
    S.mapLines.push([pl, base]);
    pl
      .bindTooltip(direct ? `${esc(l.bn)} · ${T('pk.heardDirect')}${l.snr != null ? ` · SNR ${esc(l.snr)}` : ''}`
        : nb ? `${esc(l.an)} ↔ ${esc(l.bn)} · ${T('map.lgNb')}${l.snr != null ? ` · SNR ${esc(l.snr)}` : ''}`
          : `${esc(l.an)} ↔ ${esc(l.bn)} · ${T('map.ttSeen', { n: l.n })}`, { sticky: true })
      .addTo(S.linkLayer);
  }
  // Nodes
  S.mapLayer.clearLayers();
  const meNode = S.mapData.nodes.find((x) => x.local) || null;
  for (const n of list.sort((a, b) => (a.lastHeard || 0) - (b.lastHeard || 0))) {
    const t = typeOf(n);
    const name = (n.local && myName()) || n.long || n.short || n.id;
    const color = n.local ? '#c8372d' : MAP_COLORS[n.type] || '#888';
    const mk = L.circleMarker([n.lat, n.lon], { radius: dotRadius(n, sc), color: '#fff', weight: sc.border, fillColor: color, fillOpacity: 0.9 });
    S.mapDots.push([mk, n]);
    if (S.traceBuild) {
      // Bau-Modus: Antippen nimmt Repeater/Room-Server in den Pfad auf (statt Popup)
      mk.on('click', () => addTraceHop(n));
      mk.bindTooltip(esc(name), { direction: 'top', offset: [0, -6] });
      mk.addTo(S.mapLayer);
      continue;
    }
    mk.bindPopup(`<div class="map-pop"><b>${n.fav ? '★ ' : ''}${esc(name)}</b>
      <div>${n.local ? T('map.yourNode') : t ? `${t.icon} ${esc(t.label)}` : 'Node'}</div>
      <div class="muted">${T('chat.lastHeard', { ago: esc(ago(n.lastHeard)) })}${n.hops != null ? ` · ${T('common.hops', { n: n.hops })}` : ''}${n.snr != null ? ` · SNR ${esc(n.snr)}` : ''}</div>
      ${!n.local && meNode ? `<div class="muted">📍 ${T('map.fromYou', { km: fmtKm(distKm(meNode, n)), dir: compass(meNode, n) })}</div>` : ''}
      ${!n.local && canDm(n) ? `<button class="map-dm" data-map-dm="${esc(n.id)}">${T('contact.send')}</button>` : ''}
      ${!n.local ? `<button class="map-dm map-sec" data-map-node="${esc(n.id)}">${T('map.detailsStatus')}</button>` : ''}</div>`);
    mk.bindTooltip(esc(name), { direction: 'top', offset: [0, -6] });
    mk.addTo(S.mapLayer);
  }
  const fb = drawFocus();
  const sub = $('#map-sub');
  const shown = list.filter((n) => !n.local).length;
  if (sub) sub.textContent = focusOnly ? T('map.focusSub', { n: shown }) : `${T('map.nodesPos', { n: shown })}${noPos ? ` · ${T('map.noPos', { n: noPos })}` : ''}${links.length ? ` · ${T('map.linksN', { n: links.length })}` : ''}`;
  if (fb) S.map.fitBounds(fb.pad(0.25), { maxZoom: 14 });
  else if (fit && list.length) S.map.fitBounds(L.latLngBounds(list.map((n) => [n.lat, n.lon])), { padding: [30, 30], maxZoom: 13 });
  if (S.mapFocus && !fb) toast(T('map.noPosPath'));
}

const FOCUS_LINE = 3; // alle Fokus-Linien (Weg, Reach, Nachbarn, Traceroute) gleich stark
// Welche Nodes gehören zum Fokus? (IDs; 'me' = eigener Node)
function focusNodeIds(f) {
  const ids = new Set();
  const add = (p) => { if (!p) return; if (p.me) { ids.add('me'); return; } const n = mapPoint(p); if (n?.id) ids.add(n.id); if (n?.local) ids.add('me'); };
  add(f.center);
  (f.leaves || []).forEach(add);
  (f.points || []).forEach(add);
  (f.stations || []).forEach(add);
  (f.legs || []).forEach((l) => { add(l.a); add(l.b); });
  return ids;
}
const focusAllBtn = () => `<button class="pill focus-all ${S.mapFocusAll ? 'on' : ''}" data-focus-all title="${esc(T('focus.allTitle'))}">${S.mapFocusAll ? T('focus.onlySel') : T('focus.allNodes')}</button>`;

// Weg auf der Karte zeigen (aus Nachricht, Traceroute oder einzelner Node)
function showOnMap(focus) {
  S.mapFocus = focus;
  S.mapFocusAll = false;
  S.live.pauseForFocus = true;
  if (S.view === 'map') drawMap(false); else go('map');
}

// ------------------------------------------------------------------ Node-Details: Status, Verlauf, Traceroute

const STATUS_FIELDS = [
  ['status_battery_volts', T('node.battery'), (v) => `${v.toFixed(2)} V`],
  ['battery_volts', T('node.battery'), (v) => `${v.toFixed(2)} V`],
  ['status_uptime_secs', T('node.uptime'), (v) => dur(v)],
  ['status_noise_floor', T('node.noise'), (v) => `${fmtNum(v)} dB`],
  ['status_last_rssi', T('node.lastRssi'), (v) => `${fmtNum(v)} dBm`],
  ['status_last_snr', T('node.lastSnr'), (v) => `${fmtNum(v)} dB`],
  ['status_air_time_secs', T('node.airTx'), (v) => dur(v)],
  ['status_rx_air_time_secs', T('node.airRx'), (v) => dur(v)],
  ['status_packets_recv', T('node.pkRecv'), (v) => v.toLocaleString(LOC)],
  ['status_packets_sent', T('node.pkSent'), (v) => v.toLocaleString(LOC)],
  ['status_recv_flood', T('node.recvFlood'), (v) => v.toLocaleString(LOC)],
  ['status_recv_direct', T('node.recvDirect'), (v) => v.toLocaleString(LOC)],
  ['status_sent_flood', T('node.sentFlood'), (v) => v.toLocaleString(LOC)],
  ['status_sent_direct', T('node.sentDirect'), (v) => v.toLocaleString(LOC)],
  ['status_flood_dups', T('node.dupFlood'), (v) => v.toLocaleString(LOC)],
  ['status_direct_dups', T('node.dupDirect'), (v) => v.toLocaleString(LOC)],
  ['status_queue_len', T('node.queue'), (v) => String(v)],
  ['status_errors', T('node.errors'), (v) => String(v)],
  ['status_recv_errors', T('node.recvErrors'), (v) => String(v)],
];
const STATUS_CHARTS = [['status_battery_volts', T('node.battery'), 'V'], ['battery_volts', T('node.battery'), 'V'], ['status_noise_floor', T('node.noise'), 'dB'], ['status_last_snr', T('node.lastSnr'), 'dB'], ['status_packets_recv', T('node.pkRecv'), '']];
const NODE_RANGES = [[1, '24 h'], [7, T('common.days', { n: 7 })], [30, T('common.days', { n: 30 })]];

function dur(sec) {
  const s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return d ? T('dur.dh', { d, h }) : h ? `${h} h ${m} min` : `${m} min`;
}
function fmtNum(v) { return Math.abs(v) >= 100 ? Math.round(v).toLocaleString(LOC) : (Math.round(v * 100) / 100).toLocaleString(LOC); }

function sparkline(points) {
  if (!points || points.length < 2) return `<div class="muted spark-empty">${T('node.fewValues')}</div>`;
  const xs = points.map((p) => p[0]); const ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs); const x1 = Math.max(...xs); let y0 = Math.min(...ys); let y1 = Math.max(...ys);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const W = 300; const H = 60;
  const pts = points.map(([x, y]) => `${(((x - x0) / (x1 - x0 || 1)) * W).toFixed(1)},${(H - 4 - ((y - y0) / (y1 - y0)) * (H - 8)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${pts}"/></svg>`;
}

function permHint(e, perm) {
  if (e.status === 403) return T('perm.noPerm', { perm });
  if (e.status === 429) return T('perm.tooSoon', { s: e.retryAfter || 60 });
  if (e.code === 'TX_DISABLED') return T('perm.txDisabled');
  if (e.code === 'MESHCORE_TRACE_FAILED') return T('perm.traceFailed');
  if (e.status === 503) return T('perm.notConnected');
  return e.message;
}

function renderNode() {
  const app = $('#app');
  const id = S.conv;
  if ($('.view-node', app) && app.dataset.node === id) { renderNodeBody(); return; }
  app.dataset.node = id;
  S.ni = { id, series: null, traces: null, days: load('nodeDays', 7), busy: null, msg: {} };
  app.innerHTML = `
    <div class="view view-node">
      <header class="bar">
        <button class="icon-btn" id="back" aria-label="${esc(T('common.back'))}">${ICON.back}</button>
        ${avatar('dm:' + id, 'small')}
        <div class="bar-title"><h2 id="node-title"></h2><div class="sub" id="node-sub"></div></div>
      </header>
      <main class="scroll node-page" id="node-body"></main>
    </div>`;
  $('#back').onclick = () => history.back();
  $('#node-body').onclick = onNodeClick;
  renderNodeBody();
  loadNodeTelemetry();
  loadTraces();
  loadContactPath();
  const nn = node(id);
  if (nn?.type === 2 || nn?.type === 3) { loadNeighbours(false); if (S.source?.protocol === 'meshcore') loadReach(); }
}

const nodeKind = (n) => (n?.type === 4 ? 'lpp' : n?.type === 2 || n?.type === 3 ? 'status' : null);

function renderNodeBody() {
  const ni = S.ni;
  const n = node(ni.id) || { id: ni.id };
  const t = typeOf(n);
  $('#node-title').textContent = n.long || n.short || n.id;
  $('#node-sub').textContent = `${t ? `${t.icon} ${t.label}` : 'Node'}${n.fav ? ` · ★ ${T('fav.label')}` : ''}`;
  const row = (k, v) => (v == null || v === '' ? '' : `<div class="info-row"><span>${k}</span><b>${esc(v)}</b></div>`);
  const kind = nodeKind(n);
  const series = ni.series || {};
  const latest = STATUS_FIELDS.filter(([k]) => series[k]).filter(([k], i, a) => !(k === 'battery_volts' && a.some(([x]) => x === 'status_battery_volts')));
  const lastTs = Math.max(0, ...Object.values(series).map((s) => s.last?.[0] || 0));
  const charts = kind === 'status' || series.status_packets_recv
    ? STATUS_CHARTS.filter(([k]) => series[k])
    : Object.keys(series).filter((k) => !k.startsWith('status_') && !/^(latitude|longitude|altitude)/.test(k)).map((k) => [k, k.replace(/_/g, ' '), series[k].unit || '']);
  const msg = (k) => (ni.msg[k] ? `<div class="node-msg ${ni.msg[k].err ? 'err' : ''}">${esc(ni.msg[k].text)}</div>` : '');
  const traces = ni.traces || [];
  $('#node-body').innerHTML = `
    <section class="card">
      ${row(T('node.lastHeard'), n.lastHeard ? `${ago(n.lastHeard)} (${new Date(n.lastHeard).toLocaleString(LOC)})` : null)}
      ${row('Hops', n.hops)}
      ${row('SNR', n.snr)}
      ${row('ID', n.id.length > 24 ? `${n.id.slice(0, 19)}…` : n.id)}
      <div class="node-actions">
        ${canDm(n) ? `<button class="pill" data-na="dm">${T('node.msgBtn')}</button>` : ''}
        <button class="pill" data-na="map">${T('node.mapBtn')}</button>
        ${S.source?.protocol === 'meshcore' ? `<button class="pill" data-na="fav">${n.fav ? '★' : '☆'} ${T('fav.label')}</button>` : ''}
        ${canAdmin(n) ? `<button class="pill accent" data-na="admin">${T('adm.open')}</button>` : ''}
      </div>
    </section>
    ${kind ? `
    <section class="card">
      <div class="card-head"><b>${kind === 'lpp' ? T('node.sensors') : 'Status'}</b>${lastTs ? `<small>${T('node.asOf', { ago: esc(ago(lastTs)) })}</small>` : ''}</div>
      ${latest.length ? `<div class="stat-grid">${latest.map(([k, label, f]) => `<div><small>${esc(label)}</small><b>${esc(f(series[k].last[1]))}</b></div>`).join('')}</div>` : ni.series ? `<div class="muted">${T('node.noValues')}</div>` : `<div class="muted">${T('common.loading')}</div>`}
      ${kind === 'lpp' && !latest.length && charts.length ? `<div class="stat-grid">${charts.map(([k, label, u]) => `<div><small>${esc(label)}</small><b>${esc(fmtNum(series[k].last[1]))} ${esc(u)}</b></div>`).join('')}</div>` : ''}
      <button class="sheet-btn primary" data-na="status" ${ni.busy === 'status' ? 'disabled' : ''}>${ni.busy === 'status' ? T('node.querying') : kind === 'lpp' ? T('node.querySensors') : T('node.queryStatus')}</button>
      ${msg('status')}
      <div class="hint">${T('node.queryHint')}</div>
    </section>` : ''}
    ${charts.length || kind ? `
    <section class="card">
      <div class="card-head"><b>${T('node.history')}</b><span class="mini-segs">${NODE_RANGES.map(([d, l]) => `<button class="seg ${ni.days === d ? 'active' : ''}" data-nd="${d}">${l}</button>`).join('')}</span></div>
      ${charts.length ? charts.map(([k, label, u]) => {
        const s = series[k]; const ys = s.points.map((p) => p[1]);
        return `<div class="chart"><div class="chart-head"><span>${esc(label)}</span><small>${esc(fmtNum(Math.min(...ys)))} – ${esc(fmtNum(Math.max(...ys)))} ${esc(u)}</small></div>${sparkline(s.points)}</div>`;
      }).join('') : `<div class="muted">${ni.series ? T('node.noValuesRange') : T('common.loading')}</div>`}
      ${msg('tele')}
    </section>` : ''}
    ${n.type === 2 || n.type === 3 ? trafficCard(ni) : ''}
    <section class="card">
      <div class="card-head"><b>${T('node.checkRoute')}</b></div>
      <button class="sheet-btn" data-na="trace" ${ni.busy === 'trace' ? 'disabled' : ''}>${ni.busy === 'trace' ? T('node.traceRunning') : T('node.traceStart')}</button>
      ${msg('trace')}
      ${traces.map((tr, i) => `
        <div class="trace">
          <div class="trace-head"><span>${esc(ago(tr.ts))}</span><button class="pill" data-trace-map="${i}">${T('node.onMap')}</button></div>
          <div class="trace-path"><span>${T('common.you')}</span>${tr.hops.map((h) => `<span>›</span><span>${esc(h.name || `#${h.hash}`)}${traceSnr(h) ? `<small> ${esc(traceSnr(h))}</small>` : ''}</span>`).join('')}</div>
        </div>`).join('') || (ni.traces ? `<div class="muted">${T('node.noTrace')}</div>` : '')}
      <div class="hint">${T('node.traceHint')}</div>
    </section>
    <section class="card">
      <div class="card-head"><b>${T('node.connection')}</b></div>
      <div class="info-row"><span>${T('node.storedPath')}</span><b>${ni.contact == null ? T('common.loading') : !ni.contact.known ? T('node.noContact') : ni.contact.flood ? T('node.noPathFlood') : ni.contact.hops.length ? esc(ni.contact.hops.map((h) => h.name || `#${h.hash}`).join(' › ')) : T('common.direct')}</b></div>
      <div class="node-actions">
        <button class="pill" data-na="ping" ${ni.busy ? 'disabled' : ''}>${ni.busy === 'ping' ? T('node.pinging') : T('node.ping')}</button>
        <button class="pill" data-na="reset" ${ni.busy ? 'disabled' : ''}>${ni.busy === 'reset' ? T('node.resetting') : T('node.reset')}</button>
        <button class="pill" data-na="discover" ${ni.busy ? 'disabled' : ''}>${ni.busy === 'discover' ? T('node.discovering') : T('node.discover')}</button>
      </div>
      ${msg('conn')}
      <div class="hint">${T('node.connHint')}</div>
    </section>
    ${n.type === 2 || n.type === 3 ? `
    <section class="card">
      <div class="card-head"><b>${T('node.nbTitle')}</b>${ni.nb?.ts ? `<small>${T('node.asOf', { ago: esc(ago(ni.nb.ts)) })}</small>` : ''}</div>
      ${ni.nb == null ? `<div class="muted">${T('common.loading')}</div>` : ni.nb.neighbours.length ? ni.nb.neighbours.map((x) => `<div class="heard-row"><span class="heard-name">${esc(x.name || `#${x.hash}`)}</span><span class="heard-snr" style="color:${snrColor(x.snr)}">${x.snr != null ? `SNR ${esc(x.snr)}` : ''}</span><span class="heard-snr">${x.secs != null ? esc(dur(x.secs)) : ''}</span></div>`).join('') : `<div class="muted">${T('node.nbNone')}</div>`}
      <div class="node-actions">
        <button class="pill" data-na="nb" ${ni.busy ? 'disabled' : ''}>${ni.busy === 'nb' ? T('node.querying') : T('node.nbQuery')}</button>
        ${nbMore(ni.nb) ? `<button class="pill" data-na="nbmore" ${ni.busy ? 'disabled' : ''}>${nbMoreLabel(ni.nb)}</button>` : ''}
        ${ni.nb?.neighbours?.length ? `<button class="pill" data-na="nbmap">${T('node.mapBtn')}</button>` : ''}
      </div>
      ${msg('nb')}
      <div class="hint">${T('node.nbHint')}</div>
    </section>
    ${S.source?.protocol === 'meshcore' ? reachCard(ni) : ''}` : ''}`;
}

// ------------------------------------------------------------------ Repeater-Verwaltung (REMOTE_ADMIN=1)
// Ablauf wie in der MeshCore-App: anmelden, dann Status, Konsole und Einstellungen. Alles geht über MeshMonitor;
// jede Abfrage ist Funkverkehr (eine DM hin, eine zurück), deshalb nur auf Knopfdruck. Verlauf nur im Speicher.
const ADM_DANGER = /\b(reboot|erase|clkreboot|factory|poweroff|shutdown)\b(?!\.)|\bset\s+prv\.key\b/i;
const admName = (id) => { const n = node(id); return n?.long || n?.short || T('type.repeater'); };
const canAdmin = (n) => Boolean(S.admin && S.source?.protocol === 'meshcore' && (n?.type === 2 || n?.type === 3));
// Auftrag beim Server starten und nachfragen, bis er fertig ist (Funk: bis zu 2 Min.)
async function admJob(path, body) {
  const { job } = await api(path, { method: 'POST', body });
  const t0 = Date.now();
  while (Date.now() - t0 < 160000) {
    await new Promise((r) => setTimeout(r, 2000));
    const j = await api(`/api/admin/job?id=${encodeURIComponent(job)}`);
    if (j.state === 'done') return j.result || {};
    if (j.state === 'error') throw Object.assign(new Error(j.error || T('adm.failed')), { code: j.code });
  }
  throw Object.assign(new Error(T('adm.timeout')), { code: 'CLI_TIMEOUT' });
}
function admError(e) {
  if (e.code === 'FORBIDDEN' || e.status === 403) return e.code === 'ADMIN_DISABLED' ? e.message : T('perm.noPerm', { perm: 'remote_admin:write' });
  if (e.code === 'CLI_TIMEOUT') return S.adm?.session?.resumed ? T('adm.timeoutResumed') : T('adm.timeout');
  if (e.code === 'CONTACT_NOT_ON_DEVICE') return T('adm.notOnDevice');
  if (e.code === 'TX_DISABLED') return T('perm.txDisabled');
  return e.message;
}
const admValue = (reply) => String(reply || '').trim().replace(/^>\s?/, '');

function renderAdmin() {
  const app = $('#app');
  const id = S.conv;
  if (!$('.view-admin', app) || app.dataset.admin !== id) {
    app.dataset.admin = id;
    S.adm = { id, tab: 'status', session: null, busy: null, status: null, log: [], out: {}, draft: {}, msg: null };
    app.innerHTML = `
      <div class="view view-admin">
        <header class="bar">
          <button class="icon-btn" id="back" aria-label="${esc(T('common.back'))}">${ICON.back}</button>
          ${avatar('dm:' + id, 'small')}
          <div class="bar-title"><h2>${T('adm.title')}</h2><div class="sub">${esc(admName(id))}</div></div>
        </header>
        <main class="scroll node-page" id="adm-body"></main>
        <footer class="composer-wrap hidden" id="adm-foot">
          <form class="composer" id="adm-form">
            <textarea id="adm-input" rows="1" placeholder="${esc(T('adm.cmdPlaceholder'))}" enterkeyhint="send" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
            <button class="send" type="submit" aria-label="${esc(T('common.send'))}">${ICON.send}</button>
          </form>
        </footer>
        <nav class="adm-tabs">${['status', 'console', 'settings'].map((t) => `<button data-adm-tab="${t}">${{ status: ICON.info, console: ICON.terminal, settings: ICON.gear }[t]}<span>${{ status: T('adm.tabStatus'), console: T('adm.tabConsole'), settings: T('adm.tabSettings') }[t]}</span></button>`).join('')}</nav>
      </div>`;
    $('#back').onclick = () => history.back();
    $('.adm-tabs').onclick = (e) => { const b = e.target.closest('[data-adm-tab]'); if (b) { S.adm.tab = b.dataset.admTab; renderAdminBody(); } };
    $('#adm-body').onclick = onAdminClick;
    $('#adm-body').oninput = (e) => { const k = e.target.dataset?.admIn; if (k) S.adm.draft[k] = e.target.value; };
    $('#adm-form').onsubmit = (e) => { e.preventDefault(); const v = $('#adm-input').value.trim(); if (v) { $('#adm-input').value = ''; admCli(v, { log: true }); } };
    $('#adm-input').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#adm-form').requestSubmit(); } };
    loadAdminSession();
  }
  renderAdminBody();
}

async function loadAdminSession() {
  const a = S.adm;
  try {
    const s = await api(`/api/admin/session?id=${encodeURIComponent(a.id)}`);
    a.session = { ...s, resumed: s.active };
  } catch (e) { a.session = { active: false, canRemember: false, error: admError(e) }; }
  if (S.adm === a) renderAdminBody();
}

// Feste Befehle der Einstellungen: Werte lesen (get) und schreiben (set); Werkzeuge = einzelne Befehle mit Ausgabe
const ADM_FIELDS = [
  { group: 'info', key: 'name', label: () => T('adm.fName'), max: 31 },
  { group: 'info', key: 'lat', label: () => T('adm.fLat'), num: [-90, 90] },
  { group: 'info', key: 'lon', label: () => T('adm.fLon'), num: [-180, 180] },
  // Repeater-Schlüssel in doppelten Anführungszeichen: check-i18n hielte sie sonst für Text-Schlüssel
  { group: 'adv', key: "advert.interval", label: () => T('adm.fAdvert'), sub: () => T('adm.fAdvertSub'), num: [0, 240], int: true },
  { group: 'adv', key: "flood.advert.interval", label: () => T('adm.fFlood'), sub: () => T('adm.fFloodSub'), num: [0, 168], int: true },
];
const ADM_TOOLS = [
  { key: 'repeat', cmd: 'get repeat', label: () => T('adm.tRepeat'), sub: () => T('adm.tRepeatSub') },
  { key: 'advert', cmd: 'advert', label: () => T('adm.tAdvert'), sub: () => T('adm.tAdvertSub') },
  { key: 'clock', fetch: true, cmd: 'clock', label: () => T('adm.tClock'), sub: () => T('adm.tClockSub') },
  { key: 'sync', cmd: 'clock sync', label: () => T('adm.tSync'), sub: () => T('adm.tSyncSub') },
  { key: 'neighbors', fetch: true, nb: true, label: () => T('adm.tNeighbors'), sub: () => T('adm.tNeighborsSub') },
  { key: 'radio', fetch: true, cmd: 'get radio', label: () => T('adm.tRadio'), sub: () => T('adm.tRadioSub') },
  { key: 'ver', fetch: true, cmd: 'ver', label: () => T('adm.tVer'), sub: () => T('adm.tVerSub') },
  { key: 'guest', label: () => T('adm.tGuest'), sub: () => T('adm.tGuestSub'), input: true },
  { key: 'reboot', cmd: 'reboot', label: () => T('adm.tReboot'), sub: () => T('adm.tRebootSub'), danger: true },
];

function renderAdminBody() {
  const a = S.adm;
  if (!a || !$('#adm-body')) return;
  document.querySelectorAll('[data-adm-tab]').forEach((b) => b.classList.toggle('active', b.dataset.admTab === a.tab));
  const s = a.session;
  const on = Boolean(s?.active);
  $('#adm-foot').classList.toggle('hidden', !(on && a.tab === 'console'));
  const busy = (k) => a.busy === k;
  const out = (k) => (a.out[k] ? `<div class="adm-out ${a.out[k].err ? 'err' : ''}">${esc(a.out[k].text)}</div>` : '');
  let html = '';
  if (!s) html = `<div class="muted adm-pad">${T('common.loading')}</div>`;
  else if (!on) {
    html = `
      <section class="card">
        <div class="card-head"><b>${T('adm.loginTitle')}</b></div>
        ${s.error ? `<div class="node-msg err">${esc(s.error)}</div>` : ''}
        ${s.reason === 'other_radio' ? `<div class="hint left">${T('adm.otherRadio')}</div>` : ''}
        <input class="adm-field" type="password" id="adm-pw" maxlength="15" placeholder="${esc(T('adm.password'))}" autocomplete="off" ${busy('login') ? 'disabled' : ''}>
        ${s.canRemember ? `<label class="adm-check"><input type="checkbox" id="adm-remember"> ${T('adm.remember')}</label>` : ''}
        <button class="sheet-btn primary" data-adm="login" ${a.busy ? 'disabled' : ''}>${busy('login') ? T('adm.loggingIn') : T('adm.login')}</button>
        ${s.canRemember ? `<button class="sheet-btn" data-adm="saved" ${a.busy ? 'disabled' : ''}>${busy('saved') ? T('adm.loggingIn') : T('adm.loginSaved')}</button>` : ''}
        ${out('login')}
        <div class="hint">${T('adm.loginHint')}</div>
      </section>`;
  } else {
    const head = `<div class="adm-ok">${ICON.check}<span>${T('adm.loggedIn')}${s.loggedInAt ? ` · ${esc(ago(s.loggedInAt))}` : ''}</span><button class="pill" data-adm="logout">${T('adm.logout')}</button></div>`;
    if (a.tab === 'status') {
      const v = a.status?.values || {};
      const rows = STATUS_FIELDS.filter(([k]) => v[k] != null);
      html = `${head}
        <section class="card">
          <div class="card-head"><b>Status</b>${a.status?.ts ? `<small>${T('node.asOf', { ago: esc(ago(a.status.ts)) })}</small>` : ''}</div>
          ${rows.length ? `<div class="stat-grid">${rows.map(([k, label, f]) => `<div><small>${esc(label)}</small><b>${esc(f(v[k]))}</b></div>`).join('')}</div>` : `<div class="muted">${a.status ? T('node.noValues') : T('adm.statusNone')}</div>`}
          <button class="sheet-btn primary" data-adm="status" ${a.busy ? 'disabled' : ''}>${busy('status') ? T('node.querying') : T('node.queryStatus')}</button>
          ${out('status')}
          <div class="hint">${T('adm.airHint')}</div>
        </section>`;
    } else if (a.tab === 'console') {
      html = `${head}
        <div class="adm-chips">${['ver', 'clock', 'neighbors', 'get repeat', 'get radio'].map((c) => `<button class="pill" data-adm-cmd="${esc(c)}" ${a.busy ? 'disabled' : ''}>${esc(c)}</button>`).join('')}</div>
        <div class="adm-log" id="adm-log">${a.log.length ? a.log.map((l) => `<div class="${l.cmd ? 'adm-cmd' : l.err ? 'adm-err' : 'adm-rep'}">${l.cmd ? `&gt; ${esc(l.cmd)}` : esc(l.text)}</div>`).join('') : `<div class="muted">${T('adm.consoleEmpty')}</div>`}${busy('cli') ? `<div class="muted">${T('adm.waiting')}</div>` : ''}</div>
        <div class="hint">${T('adm.consoleHint')}</div>`;
    } else {
      const field = (f) => {
        const val = a.draft[f.key] ?? '';
        return `
          <div class="adm-row">
            <label><span>${esc(f.label())}</span>${f.sub ? `<small>${esc(f.sub())}</small>` : ''}</label>
            <div class="adm-inline">
              <input class="adm-field" data-adm-in="${esc(f.key)}" value="${esc(val)}" ${f.num ? 'inputmode="decimal"' : ''} maxlength="${f.max || 16}" placeholder="–">
              <button class="pill" data-adm-get="${esc(f.key)}" ${a.busy ? 'disabled' : ''} title="${esc(T('adm.read'))}">${ICON.refresh}</button>
              <button class="pill" data-adm-set="${esc(f.key)}" ${a.busy ? 'disabled' : ''} title="${esc(T('adm.save'))}">${ICON.check}</button>
            </div>
            ${out(`f:${f.key}`)}
          </div>`;
      };
      const tool = (t) => `
        <div class="adm-tool ${t.danger ? 'danger' : ''}">
          <div class="adm-tool-text"><b>${esc(t.label())}</b><small>${esc(t.sub())}</small></div>
          ${t.input ? `<input class="adm-field" data-adm-in="guest" type="password" maxlength="15" placeholder="${esc(T('adm.newPw'))}" value="${esc(a.draft.guest || '')}">` : ''}
          ${t.key === 'repeat'
            ? `<span class="adm-inline"><button class="pill" data-adm-tool="repeat" ${a.busy ? 'disabled' : ''}>${busy('t:repeat') ? '…' : T('adm.read')}</button><button class="pill" data-adm-repeat="on" ${a.busy ? 'disabled' : ''}>${T('common.on')}</button><button class="pill" data-adm-repeat="off" ${a.busy ? 'disabled' : ''}>${T('common.off')}</button></span>`
            : `<button class="pill" data-adm-tool="${t.key}" ${a.busy ? 'disabled' : ''}>${busy(`t:${t.key}`) ? '…' : t.input ? T('adm.save') : t.danger ? T('adm.run') : t.fetch ? T('adm.fetch') : T('adm.send')}</button>`}
          ${out(`t:${t.key}`)}
          ${t.nb && a.nb ? `<div class="adm-nb">${a.nb.neighbours.length ? a.nb.neighbours.map((x) => `<div class="heard-row"><span class="heard-name">${esc(x.name || `#${x.hash}`)}</span><span class="heard-snr" style="color:${snrColor(x.snr)}">${x.snr != null ? `SNR ${esc(x.snr)}` : ''}</span><span class="heard-snr">${x.secs != null ? esc(dur(x.secs)) : ''}</span></div>`).join('') : `<div class="muted">${T('node.nbEmpty')}</div>`}
            <div class="node-actions">${nbMore(a.nb) ? `<button class="pill" data-adm="nbmore" ${a.busy ? 'disabled' : ''}>${busy('t:neighbors') ? '…' : nbMoreLabel(a.nb)}</button>` : ''}${a.nb.neighbours.length ? `<button class="pill" data-adm="nbmap">${T('node.mapBtn')} (${a.nb.neighbours.length})</button>` : ''}</div></div>` : ''}
        </div>`;
      html = `${head}
        <div class="adm-note">${T('adm.airHint')}</div>
        <section class="card"><div class="card-head"><b>${T('adm.gInfo')}</b></div>${ADM_FIELDS.filter((f) => f.group === 'info').map(field).join('')}</section>
        <section class="card"><div class="card-head"><b>${T('adm.gAdvert')}</b></div>${ADM_FIELDS.filter((f) => f.group === 'adv').map(field).join('')}</section>
        <section class="card"><div class="card-head"><b>${T('adm.gTools')}</b></div>${ADM_TOOLS.map(tool).join('')}</section>
        <div class="hint">${T('adm.moreInConsole')}</div>`;
    }
  }
  $('#adm-body').innerHTML = html;
  const log = $('#adm-log');
  if (log) log.scrollIntoView({ block: 'end' });
}

// Einen Befehl senden; gefährliche erst nach Eingabe des Repeater-Namens
async function admCli(command, { log = false, key = 'cli', confirm = false } = {}) {
  const a = S.adm;
  if (!a || a.busy) return null;
  if (ADM_DANGER.test(command) && !confirm) { admConfirm(command, () => admCli(command, { log, key, confirm: true })); return null; }
  a.busy = key;
  if (log) a.log.push({ cmd: command });
  if (key !== 'cli') delete a.out[key];
  renderAdminBody();
  let reply = null;
  try {
    const r = await admJob('/api/admin/cli', { id: a.id, command, confirm });
    reply = r.reply ?? '';
    if (log) a.log.push({ text: reply || T('adm.noOutput') });
    else a.out[key] = { text: reply || T('adm.noOutput') };
    if (a.session) a.session.resumed = false; // Antwort kam: Sitzung trägt
  } catch (e) {
    if (log) a.log.push({ err: true, text: admError(e) });
    else a.out[key] = { err: true, text: admError(e) };
  }
  a.busy = null;
  if (a.log.length > 300) a.log.splice(0, a.log.length - 300);
  if (S.adm === a) renderAdminBody();
  return reply;
}
function admConfirm(command, run) {
  const name = admName(S.adm.id);
  openSheet(`
    <div class="sheet-title">${T('adm.dangerTitle')}</div>
    <div class="hint left">${T('adm.dangerText', { cmd: esc(command), name: esc(name) })}</div>
    <input class="adm-field" id="adm-confirm" placeholder="${esc(name)}" autocomplete="off">
    <button class="sheet-btn danger" data-adm-go disabled>${T('adm.run')}</button>
    <button class="sheet-btn cancel" data-close>${T('common.cancel')}</button>`, (e) => {
    if (e.target.closest('[data-adm-go]') && !e.target.closest('[data-adm-go]').disabled) { closeSheet(); run(); }
  });
  const inp = $('#adm-confirm');
  inp.oninput = () => { $('[data-adm-go]').disabled = inp.value.trim() !== name; };
  inp.focus();
}

async function admNeighbours(more) {
  const a = S.adm;
  if (!a || a.busy) return;
  a.busy = 't:neighbors'; delete a.out['t:neighbors']; renderAdminBody();
  try { a.nb = await fetchNeighbours(a.id, more ? a.nb : null); } catch (e) {
    a.out['t:neighbors'] = { err: true, text: e.status === 504 || /timeout/i.test(e.message) ? T('node.nbNoAnswer') : permHint(e, 'nodes:read') };
  }
  a.busy = null;
  if (S.adm === a) renderAdminBody();
}

async function onAdminClick(e) {
  const a = S.adm;
  if (!a) return;
  const b = e.target.closest('[data-adm], [data-adm-cmd], [data-adm-get], [data-adm-set], [data-adm-tool], [data-adm-repeat]');
  if (!b || b.disabled) return;
  const act = b.dataset.adm;
  if (act === 'login' || act === 'saved') {
    const password = $('#adm-pw')?.value || '';
    if (act === 'login' && !password) { a.out.login = { err: true, text: T('adm.pwMissing') }; renderAdminBody(); return; }
    const remember = Boolean($('#adm-remember')?.checked);
    a.busy = act; delete a.out.login; renderAdminBody();
    try {
      const r = await admJob('/api/admin/login', act === 'saved' ? { id: a.id, saved: true } : { id: a.id, password, remember });
      a.session = { ...(a.session || {}), active: true, loggedInAt: Date.now(), resumed: false };
      a.msg = r.persisted ? T('adm.savedOk') : null;
      if (r.persisted) toast(T('adm.savedOk'));
    } catch (err) { a.out.login = { err: true, text: admError(err) }; }
    a.busy = null;
    if (S.adm === a) renderAdminBody();
    return;
  }
  if (act === 'logout') {
    try { await api('/api/admin/logout', { method: 'POST', body: { id: a.id } }); } catch (err) { toast(admError(err)); }
    a.session = { ...(a.session || {}), active: false, loggedInAt: null };
    renderAdminBody();
    return;
  }
  if (act === 'status') {
    a.busy = 'status'; delete a.out.status; renderAdminBody();
    try { a.status = await admJob('/api/admin/status', { id: a.id }); } catch (err) { a.out.status = { err: true, text: admError(err) }; }
    a.busy = null;
    if (S.adm === a) renderAdminBody();
    return;
  }
  if (act === 'nbmap') {
    const n = node(a.id);
    showOnMap({ kind: 'star', title: T('node.nbOf', { name: admName(a.id) }), center: { id: a.id, label: n?.long || n?.short }, leaves: a.nb.neighbours.map((x) => ({ id: x.id, hash: x.hash, label: `${x.name || `#${x.hash}`}${x.snr != null ? ` · SNR ${x.snr}` : ''}`, snr: x.snr })) });
    return;
  }
  if (act === 'nbmore') { admNeighbours(true); return; }
  if (b.dataset.admCmd) { admCli(b.dataset.admCmd, { log: true }); return; }
  const f = ADM_FIELDS.find((x) => x.key === (b.dataset.admGet || b.dataset.admSet));
  if (f && b.dataset.admGet) {
    const r = await admCli(`get ${f.key}`, { key: `f:${f.key}` });
    if (r != null && !/unknown|\?\?/i.test(r)) { a.draft[f.key] = admValue(r); delete a.out[`f:${f.key}`]; renderAdminBody(); }
    return;
  }
  if (f && b.dataset.admSet) {
    const v = String(a.draft[f.key] ?? '').trim().replace(/[\r\n]/g, ' ');
    const bad = !v || (f.max && new TextEncoder().encode(v).length > f.max)
      || (f.num && (!/^-?\d+(\.\d+)?$/.test(v) || Number(v) < f.num[0] || Number(v) > f.num[1] || (f.int && !Number.isInteger(Number(v)))));
    if (bad) { a.out[`f:${f.key}`] = { err: true, text: T('adm.badValue') }; renderAdminBody(); return; }
    admCli(`set ${f.key} ${v}`, { key: `f:${f.key}` });
    return;
  }
  if (b.dataset.admRepeat) { admCli(`set repeat ${b.dataset.admRepeat}`, { key: 't:repeat' }); return; }
  const t = ADM_TOOLS.find((x) => x.key === b.dataset.admTool);
  if (!t) return;
  if (t.nb) { admNeighbours(false); return; }
  if (t.input) {
    const v = String(a.draft.guest || '');
    // Leeren geht über MeshMonitor nicht: es kürzt den Befehl, die Firmware braucht aber "set guest.password " mit Leerzeichen
    if (!v) { a.out['t:guest'] = { err: true, text: T('adm.guestNoClear') }; renderAdminBody(); return; }
    if (v.length > 15 || /\s/.test(v)) { a.out['t:guest'] = { err: true, text: T('adm.badValue') }; renderAdminBody(); return; }
    await admCli(`set guest.password ${v}`, { key: 't:guest' });
    a.draft.guest = ''; renderAdminBody();
    return;
  }
  admCli(t.cmd, { key: `t:${t.key}` });
}

// Paketverkehr eines Repeaters: aus seinen eigenen Zählern (Status-Telemetrie), berechnet im Server (repeaterTraffic).
// "mind." = Neustart im Zeitraum (davor fehlen Pakete), "–" = Messungen decken den Zeitraum nicht ab.
const trafficNum = (d) => (d ? `${d.lower ? `${T('traffic.atLeast')}\u00a0` : ''}${nf(d.n)}` : '–');
function trafficCard(ni) {
  const tr = ni.traffic;
  const last = tr ? Math.max(tr.recv?.last || 0, tr.sent?.last || 0) : 0;
  const head = `<div class="card-head"><b>${T('traffic.title')}</b>${last ? `<small>${T('node.asOf', { ago: esc(ago(last)) })}</small>` : ''}</div>`;
  if (ni.series == null) return `<section class="card">${head}<div class="muted">${T('common.loading')}</div></section>`;
  if (!tr) return `<section class="card">${head}<div class="muted">${T('traffic.none')}</div><div class="hint">${T('traffic.needPolling')}</div></section>`;
  const r = tr.recv || {}; const s = tr.sent || {};
  const h = r.hour || s.hour;
  const perH = (d) => (d ? nf(d.n) : '–');
  const days = (ni.trafficBounds || []).map((b, i) => ({ b, r: r.days?.[i] || null, s: s.days?.[i] || null })).filter((x) => x.r || x.s).reverse();
  const max = Math.max(1, ...days.map((x) => x.s?.n || x.r?.n || 0));
  return `
    <section class="card">
      ${head}
      <div class="stat-grid">
        <div><small>${T('traffic.recvHour')}</small><b>${perH(r.hour)}</b></div>
        <div><small>${T('traffic.sentHour')}</small><b>${perH(s.hour)}</b></div>
        <div><small>${T('traffic.recv24')}</small><b>${trafficNum(r.day)}</b></div>
        <div><small>${T('traffic.sent24')}</small><b>${trafficNum(s.day)}</b></div>
      </div>
      <div class="hint">${h ? T('traffic.measured', { span: esc(dur(h.span / 1000)) }) : T('traffic.noFresh')}</div>
      ${days.length ? `
      <div class="tr-table">
        <div class="tr-row tr-headrow"><span>${T('traffic.perDay')}</span><small>${T('traffic.recv')}</small><small>${T('traffic.sent')}</small></div>
        ${days.map((x) => `<div class="tr-row"><span>${esc(dayLabel(x.b))}${(x.r || x.s)?.partial ? ` <small>${T('traffic.soFar')}</small>` : ''}<i class="tr-bar" style="width:${Math.max(2, ((x.s?.n || x.r?.n || 0) / max) * 100)}%"></i></span><b>${trafficNum(x.r)}</b><b>${trafficNum(x.s)}</b></div>`).join('')}
      </div>` : ''}
      <div class="hint">${T('traffic.hint', { n: Math.max(r.samples || 0, s.samples || 0) })}</div>
    </section>`;
}

// Reach (experimentell): aus den Wegen der Flood-Pakete, die dein Companion empfangen hat
const REACH_SHOW = 8;
function reachCard(ni) {
  const r = ni.reach;
  const list = (rows, kind) => {
    if (!rows.length) return `<div class="muted">${T('reach.nothing')}</div>`;
    const all = ni.reachAll?.[kind];
    const max = Math.max(...rows.map((x) => x.n));
    return rows.slice(0, all ? rows.length : REACH_SHOW).map((x) => {
      const label = x.me ? T('common.you') : x.name || `#${x.hash}${x.amb ? '?' : ''}`;
      const sub = [x.origin ? T('reach.asSender') : '', x.amb ? T('reach.amb', { n: x.amb }) : !x.name && !x.me ? T('common.unknown') : ''].filter(Boolean).join(' · ');
      return `<button class="reach-row" ${x.id && !x.me ? `data-reach-node="${esc(x.id)}"` : 'disabled'}>
        <span class="reach-name">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
        <span class="reach-bar"><i style="width:${Math.max(6, (x.n / max) * 100)}%"></i></span>
        <span class="reach-n">${nf(x.n)}×<small>${esc(ago(x.last))}</small></span>
      </button>`;
    }).join('') + (rows.length > REACH_SHOW ? `<button class="route-map" data-reach-all="${kind}">${all ? T('reach.less') : T('reach.all', { n: rows.length })}</button>` : '');
  };
  let body;
  if (r == null) body = `<div class="muted">${T('reach.working')}</div>`;
  else if (r.err) body = `<div class="node-msg err">${esc(r.err)}</div>`;
  else if (!r.packets) body = `<div class="muted">${T('reach.none')}</div>`;
  else body = `
      <div class="reach-sum">${T('reach.sum', { n: r.packets, num: nf(r.packets) })}${r.since ? `, ${T('reach.oldest', { ago: esc(ago(r.since)) })}` : ''}</div>
      <div class="reach-head">${T('reach.hears')} <small>${r.hears.length}</small></div>
      ${list(r.hears, 'hears')}
      <div class="reach-head">${T('reach.reaches')} <small>${r.reaches.length}</small></div>
      ${list(r.reaches, 'reaches')}`;
  return `
    <section class="card">
      <div class="card-head"><b>${T('reach.title')}</b><small>${T('reach.exp')}</small></div>
      ${body}
      <div class="node-actions">
        ${r?.packets ? `<button class="pill" data-na="reachmap">${T('node.mapBtn')}</button>` : ''}
        <button class="pill" data-na="reach" ${r == null ? 'disabled' : ''}>${T('reach.redo')}</button>
      </div>
      <div class="hint">${T('reach.hint')}</div>
    </section>`;
}
async function loadReach() {
  const ni = S.ni;
  ni.reach = null;
  if (S.view === 'node') renderNodeBody();
  try {
    const r = await api(`/api/node/reach?id=${encodeURIComponent(ni.id)}`);
    if (S.ni !== ni) return;
    ni.reach = r.unsupported ? { err: T('reach.mcOnly') } : r;
  } catch (e) {
    if (S.ni !== ni) return;
    ni.reach = { err: permHint(e, 'packetmonitor:read') };
  }
  if (S.view === 'node') renderNodeBody();
}
function reachMap(ni, n) {
  const r = ni.reach;
  const m = new Map();
  const put = (x, dir) => {
    if (!x.me && !x.id && x.amb) return; // mehrdeutig: keine Position raten
    const k = x.me ? 'me' : x.id || `#${x.hash}`;
    const e = m.get(k) || (x.me ? { me: true, label: T('common.you') } : { id: x.id, hash: x.id ? null : x.hash, label: x.name || `#${x.hash}` });
    e[dir] = (e[dir] || 0) + x.n;
    e[`${dir}Last`] = Math.max(e[`${dir}Last`] || 0, x.last || 0);
    m.set(k, e);
  };
  r.hears.forEach((x) => put(x, 'in'));
  r.reaches.forEach((x) => put(x, 'out'));
  const me = n.long || n.short || T('type.repeater');
  const leaves = [...m.values()].map((e) => {
    const color = e.in && e.out ? '#2e9d5b' : e.in ? '#3a8fd6' : '#d9822b';
    const cnt = (v, last) => (v ? `${nf(v)}×<small class="lp-note">${T('reach.last', { ago: esc(ago(last)) })}</small>` : `<span class="muted">${T('reach.notSeen')}</span>`);
    return {
      ...e, color,
      pop: (km) => `<div class="map-pop live-pkt">
        <div class="lp-head"><i style="background:${color}"></i><b>${esc(e.label)}</b><small>${e.in && e.out ? T('reach.mutual') : ''}</small></div>
        <div class="lp-row reach-pop"><span>${T('reach.hearsX', { a: esc(me), b: esc(e.label) })}</span><b>${cnt(e.in, e.inLast)}</b></div>
        <div class="lp-row reach-pop"><span>${T('reach.hearsX', { a: esc(e.label), b: esc(me) })}</span><b>${cnt(e.out, e.outLast)}</b></div>
        <div class="lp-row reach-pop"><span>${T('live.distanceLabel')}</span><b>${esc(T('stats.airline', { km: fmtKm(km) }))}</b></div>
      </div>`,
    };
  });
  showOnMap({ kind: 'star', title: T('reach.mapTitle', { name: n.long || n.short || T('type.repeater') }), note: T('reach.mapNote'), center: { id: ni.id, label: n.long || n.short }, leaves });
}

async function loadContactPath() {
  const ni = S.ni;
  try { const r = await api(`/api/node/contact?id=${encodeURIComponent(ni.id)}`); if (S.ni === ni) ni.contact = r; } catch (e) { if (S.ni === ni) { ni.contact = { known: false }; ni.msg.conn = { err: true, text: permHint(e, 'nodes:read') }; } }
  if (S.ni === ni && S.view === 'node') renderNodeBody();
}
// Nachbarn live vom Repeater: eine Antwort fasst höchstens 10 (Firmware), "Weitere laden" holt die nächste Seite.
// Seiten werden zusammengeführt (der Repeater sortiert je Anfrage neu, ein Eintrag kann wandern; erster gewinnt).
async function fetchNeighbours(id, prev = null) {
  const offset = prev ? prev.neighbours.length : 0;
  const r = await api(`/api/node/neighbours?id=${encodeURIComponent(id)}&live=1${offset ? `&offset=${offset}` : ''}`);
  if (!prev) return { ...r, live: true };
  const seen = new Set(prev.neighbours.map((x) => x.id || x.hash));
  return { ...r, live: true, neighbours: [...prev.neighbours, ...r.neighbours.filter((x) => !seen.has(x.id || x.hash))], total: r.total ?? prev.total };
}
const nbMore = (nb) => Boolean(nb?.live && nb.total != null && nb.total > nb.neighbours.length);
const nbMoreLabel = (nb) => T('node.nbMore', { n: nb.neighbours.length, total: nb.total });

async function loadNeighbours(live, more = false) {
  const ni = S.ni;
  try {
    const r = live ? await fetchNeighbours(ni.id, more ? ni.nb : null) : await api(`/api/node/neighbours?id=${encodeURIComponent(ni.id)}`);
    if (S.ni !== ni) return;
    ni.nb = r;
    if (live) ni.msg.nb = { text: r.neighbours.length ? T('node.nbGot', { n: r.neighbours.length }) : T('node.nbEmpty') };
  } catch (e) {
    if (S.ni !== ni) return;
    ni.nb = ni.nb || { neighbours: [] };
    ni.msg.nb = { err: true, text: e.status === 504 || /timeout/i.test(e.message) ? T('node.nbNoAnswer') : permHint(e, 'nodes:read') };
  }
  if (S.view === 'node') renderNodeBody();
}

async function loadNodeTelemetry() {
  const ni = S.ni;
  const n = node(ni.id);
  // Tagesanfänge der letzten 7 Tage in der Zeitzone dieses Geräts (für "Pakete pro Tag")
  const today = dayStart(new Date());
  const bounds = [6, 5, 4, 3, 2, 1, 0].map((i) => addDays(today, -i).getTime());
  try {
    const r = await api(`/api/node/telemetry?id=${encodeURIComponent(ni.id)}&days=${ni.days}&b=${bounds.join(',')}`);
    if (S.ni !== ni) return;
    ni.series = r.series || {};
    ni.traffic = r.traffic || null;
    ni.trafficBounds = bounds;
    delete ni.msg.tele;
  } catch (e) {
    if (S.ni !== ni) return;
    ni.series = {};
    if (nodeKind(n) || e.status !== 404) ni.msg.tele = { err: true, text: permHint(e, 'nodes:viewOnMap') };
  }
  if (S.view === 'node') renderNodeBody();
}

async function loadTraces() {
  const ni = S.ni;
  try {
    const r = await api(`/api/node/traces?id=${encodeURIComponent(ni.id)}`);
    if (S.ni !== ni) return;
    ni.traces = r.traces || [];
  } catch (e) {
    if (S.ni !== ni) return;
    ni.traces = [];
    ni.msg.trace = { err: true, text: permHint(e, 'traceroute:read') };
  }
  if (S.view === 'node') renderNodeBody();
}

async function onNodeClick(e) {
  const ni = S.ni;
  const rn = e.target.closest('[data-reach-node]');
  if (rn && ni) { go('node', rn.dataset.reachNode); return; }
  const ra = e.target.closest('[data-reach-all]');
  if (ra && ni) { ni.reachAll = { ...(ni.reachAll || {}), [ra.dataset.reachAll]: !ni.reachAll?.[ra.dataset.reachAll] }; renderNodeBody(); return; }
  const b = e.target.closest('[data-na], [data-nd], [data-trace-map]');
  if (!b || !ni) return;
  if (b.dataset.nd) { ni.days = Number(b.dataset.nd); save('nodeDays', ni.days); ni.series = null; renderNodeBody(); loadNodeTelemetry(); return; }
  if (b.dataset.traceMap != null) {
    const tr = ni.traces[Number(b.dataset.traceMap)];
    const n = node(ni.id);
    showOnMap({ title: T('node.traceTo', { name: n?.long || n?.short || 'Node' }), numberFrom: 0, points: [{ me: true, label: T('common.you') }, ...tr.hops.map((h) => ({ id: h.id, hash: h.hash, label: `${h.name || `#${h.hash}`}${traceSnr(h) ? ` · ${traceSnr(h)}` : ''}` }))] });
    return;
  }
  const act = b.dataset.na;
  if (act === 'admin') { go('admin', ni.id); return; }
  const n = node(ni.id) || { id: ni.id };
  const busy = async (key, fn) => {
    ni.busy = key; delete ni.msg[key === 'nb' ? 'nb' : 'conn']; renderNodeBody();
    try { await fn(); } catch (err) {
      ni.msg[key === 'nb' ? 'nb' : 'conn'] = { err: true, text: err.status === 504 ? T('node.pingNoAnswer') : err.code === 'MESHCORE_PING_FAILED' || err.status === 409 ? T('node.notPossible', { msg: err.message }) : permHint(err, 'nodes:write') };
    }
    ni.busy = null;
    if (S.ni === ni && S.view === 'node') renderNodeBody();
  };
  if (act === 'ping') {
    busy('ping', async () => {
      const r = await api('/api/node/ping', { method: 'POST', body: { id: ni.id } });
      ni.msg.conn = { text: `${T('node.pingOk', { rtt: r.rttMs != null ? `${Math.round(r.rttMs)} ms` : '?' })}${r.snrToTarget != null ? ` · ${T('node.snrOut', { v: r.snrToTarget })}` : ''}${r.snrFromTarget != null ? ` / ${T('node.snrBack', { v: r.snrFromTarget })}` : ''} – ${T('node.inRange')}` };
    });
    return;
  }
  if (act === 'reset') {
    busy('reset', async () => {
      await api('/api/node/reset-path', { method: 'POST', body: { id: ni.id } });
      ni.msg.conn = { text: T('node.resetOk') };
      await loadContactPath();
    });
    return;
  }
  if (act === 'discover') {
    busy('discover', async () => {
      const r = await api('/api/node/discover-path', { method: 'POST', body: { id: ni.id } });
      const wait = Math.min(30000, Math.max(5000, r.waitMs || 15000));
      await new Promise((res) => setTimeout(res, wait));
      await loadContactPath();
      ni.msg.conn = ni.contact?.hops?.length || (ni.contact && !ni.contact.flood) ? { text: T('node.discoverOk') } : { err: true, text: T('node.discoverNone') };
    });
    return;
  }
  if (act === 'nb') { busy('nb', () => loadNeighbours(true)); return; }
  if (act === 'nbmore') { busy('nb', () => loadNeighbours(true, true)); return; }
  if (act === 'reach') { loadReach(); return; }
  if (act === 'reachmap') { reachMap(ni, n); return; }
  if (act === 'fav') { await toggleFav(ni.id); if (S.view === 'node') renderNodeBody(); return; }
  if (act === 'nbmap') {
    showOnMap({ kind: 'star', title: T('node.nbOf', { name: n.long || n.short || T('type.repeater') }), center: { id: ni.id, label: n.long || n.short }, leaves: ni.nb.neighbours.map((x) => ({ id: x.id, hash: x.hash, label: `${x.name || `#${x.hash}`}${x.snr != null ? ` · SNR ${x.snr}` : ''}`, snr: x.snr })) });
    return;
  }
  if (act === 'dm') go('chat', `dm:${ni.id}`);
  else if (act === 'map') showOnMap({ title: n.long || n.short || 'Node', numberFrom: 1, points: [{ id: ni.id, label: n.long || n.short, tag: '★' }] });
  else if (act === 'status') {
    ni.busy = 'status'; delete ni.msg.status; renderNodeBody();
    try {
      const r = await api('/api/node/status', { method: 'POST', body: { id: ni.id, type: nodeKind(n) || 'status' } });
      ni.msg.status = { text: r.written ? T('node.statusOk') : T('node.statusNone'), err: !r.written };
      if (S.ni === ni) await loadNodeTelemetry();
    } catch (err) { ni.msg.status = { err: true, text: permHint(err, 'messages:write') }; }
    ni.busy = null;
    if (S.ni === ni && S.view === 'node') renderNodeBody();
  } else if (act === 'trace') {
    ni.busy = 'trace'; delete ni.msg.trace; renderNodeBody();
    try {
      const r = await api('/api/node/trace', { method: 'POST', body: { id: ni.id } });
      const before = (ni.traces || [])[0]?.ts || 0;
      let found = false;
      for (let i = 0; i < 15 && S.ni === ni; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        const t = await api(`/api/node/traces?id=${encodeURIComponent(ni.id)}`).catch(() => null);
        if (t?.traces?.[0] && t.traces[0].ts > before && t.traces[0].ts >= r.at - 10000) { ni.traces = t.traces; found = true; break; }
      }
      ni.msg.trace = found ? { text: T('node.traceOk') } : { err: true, text: T('node.traceNone') };
    } catch (err) { ni.msg.trace = { err: true, text: permHint(err, 'traceroute:write') }; }
    ni.busy = null;
    if (S.ni === ni && S.view === 'node') renderNodeBody();
  }
}

// ------------------------------------------------------------------ Web Push

const pushSupported = () => window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function keyToBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function subscribePush() {
  const reg = await navigator.serviceWorker.ready;
  const { key, persistent } = await api('/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  const want = keyToBytes(key);
  const cur = sub?.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
  if (sub && cur && (cur.length !== want.length || cur.some((v, i) => v !== want[i]))) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
  await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), prefs: S.convPrefs, watch: S.watch, lang: LANG } });
  S.pushEndpoint = sub.endpoint;
  return { persistent };
}

async function enablePush() {
  if (!pushSupported()) {
    toast(window.isSecureContext ? T('push.unsupported') : T('push.https'));
    return;
  }
  const p = await Notification.requestPermission();
  if (p !== 'granted') { toast(T('push.denied')); return; }
  try {
    const { persistent } = await subscribePush();
    S.notify = true; save('notify', true);
    toast(persistent ? T('push.on') : T('push.onVolatile'));
    sendPresence(true);
  } catch (e) { toast(T('push.failed', { msg: e.message })); }
}

// Abo dieses Geräts beim Server und im Browser entfernen
async function dropPushSubscription() {
  if (!pushSupported()) return;
  try {
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 2000))]);
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch { /* egal */ }
  S.pushEndpoint = null;
}

async function disablePush() {
  await dropPushSubscription();
  S.notify = false; save('notify', false);
  toast(T('push.off'));
}

// Beim Start: Abo beim Server auffrischen (falls er es nach einem Neustart nicht mehr kennt)
async function ensurePush() {
  if (!S.notify || !pushSupported() || Notification.permission !== 'granted') return;
  try { await subscribePush(); sendPresence(!document.hidden); } catch { /* still */ }
}

// Dem Server sagen, ob DIESES Gerät die App gerade offen hat (dann kein Push, sondern Hinweis in der App)
function sendPresence(visible) {
  if (!S.pushEndpoint) return;
  fetch('/api/presence', {
    method: 'POST', credentials: 'same-origin', keepalive: true,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visible, endpoint: S.pushEndpoint }),
  }).catch(() => {});
}
setInterval(() => { if (!document.hidden) sendPresence(true); }, 30000);

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
function openDrawer() {
  const root = $('#drawer-root');
  const notifOn = S.notify && 'Notification' in window && Notification.permission === 'granted';
  const sources = S.sources || [];
  const mc = S.source?.protocol === 'meshcore';
  root.innerHTML = `
    <div class="backdrop" data-close></div>
    <nav class="drawer" aria-label="${esc(T('drawer.aria'))}">
      <div class="drawer-head">
        <img src="/icons/icon.svg" alt="" class="drawer-logo">
        <div><b>MeshLink Chat</b><div class="muted">${esc(myName() || T('drawer.noNode'))}</div></div>
      </div>
      <div class="drawer-section">${T('drawer.secChat')}</div>
      <button class="drawer-item ${S.view === 'list' ? 'active' : ''}" data-act="chats">${ICON.chat}<span>${T('drawer.chats')}</span></button>
      <button class="drawer-item ${S.view === 'contacts' ? 'active' : ''}" data-act="contacts">${ICON.people}<span>${T('list.contacts')}</span></button>
      <button class="drawer-item ${S.view === 'mentions' ? 'active' : ''}" data-act="mentions"><span class="drawer-at">@</span><span>${T('men.title')}${unreadMentions() ? ` <small class="badge">${unreadMentions()}</small>` : ''}</span></button>
      ${mc ? `<button class="drawer-item ${S.view === 'rooms' ? 'active' : ''}" data-act="rooms">${ICON.home}<span>${T('rooms.title')}</span></button>` : ''}
      <button class="drawer-item ${S.view === 'search' ? 'active' : ''}" data-act="search">${ICON.search}<span>${T('drawer.search')}</span></button>
      <div class="drawer-section">${T('drawer.secNet')}</div>
      <button class="drawer-item ${S.view === 'map' ? 'active' : ''}" data-act="map">${ICON.map}<span>${T('map.title')}</span></button>
      ${mc ? `<button class="drawer-item ${S.view === 'repeaters' ? 'active' : ''}" data-act="repeaters">${ICON.radio}<span>${T('drawer.repeaters')}</span></button>` : ''}
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
      <button class="drawer-item" data-act="reload">${ICON.refresh}<span>${T('drawer.reload')}</span></button>
      <a class="drawer-version" href="${REPO_URL}" target="_blank" rel="noopener noreferrer" title="${esc(T('drawer.repo'))}">MeshLink Chat ${esc(S.version || '')} ↗</a>
      <button class="drawer-item danger" data-act="logout">${ICON.logout}<span>${T('drawer.logout')}</span></button>
    </nav>`;
  root.classList.add('open');
  root.onclick = async (e) => {
    if (e.target.closest('[data-close]')) { closeDrawer(); return; }
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
function closeDrawer() { const r = $('#drawer-root'); r.classList.remove('open'); r.innerHTML = ''; }

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

async function resetData() {
  S.msgs.clear(); S.byPacket.clear(); S.names.clear(); S.expanded.clear(); S.pending.clear();
  S.myNames = new Set(); S.otherNames = new Set(); S.me = '';
  await resync();
  readHistoryIfFresh(); // neue Quelle auf diesem Gerät
  if (S.view === 'chat') go('list');
  else { $('#app').innerHTML = ''; render(); }
}

// ------------------------------------------------------------------ Navigation

function go(view, conv, replace = false) {
  leaveMap();
  S.view = view;
  S.conv = conv || null;
  S.replyTo = null;
  const st = { view, conv };
  if (view === 'list') history.replaceState(st, '', '/');
  else if (replace) history.replaceState(st, '', `/#${encodeURIComponent(conv || view)}`);
  else history.pushState(st, '', `/#${encodeURIComponent(conv || view)}`);
  delete $('#app').dataset.conv;
  $('#app').innerHTML = '';
  render();
}

window.addEventListener('popstate', (e) => {
  const st = e.state || { view: 'list' };
  // Vollbild der Karte verlassen (Zurück-Geste) – die Karte bleibt, nichts neu aufbauen
  if (S.mapFullPop) { S.mapFullPop = false; return; }
  if (S.mapFull && S.view === 'map' && st.view === 'map' && !st.mapFull) { toggleMapFull(false); return; }
  closeSheet();
  closeDrawer();
  leaveMap();
  S.view = st.view || 'list';
  S.conv = st.conv || null;
  S.replyTo = null;
  $('#app').innerHTML = '';
  render();
});

// ------------------------------------------------------------------ Composer & Senden

function setupComposer() {
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

function updateCount() {
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

async function sendText(text, replyToId, emoji = false) {
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

function sendReaction(msgId, emoji) {
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

// ------------------------------------------------------------------ Gesten & Aktionsmenü

function setupMessageGestures() {
  const el = $('#msgs');
  let timer = null; let start = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
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
    if (!b || !reactionsSupported() || e.pointerType === 'mouse' || e.target.closest('button, a, .quote, .heard-list')) { lastTap = { id: null, t: 0 }; return; }
    const id = b.closest('.row').dataset.id;
    const now = Date.now();
    if (lastTap.id === id && now - lastTap.t < 300) { lastTap = { id: null, t: 0 }; sendReaction(id, '❤️'); }
    else lastTap = { id, t: now };
  });
}

function openSheet(html, onClick) {
  const root = $('#sheet-root');
  root.innerHTML = `<div class="backdrop" data-close></div><div class="sheet" role="dialog">${html}</div>`;
  root.classList.add('open');
  root.onclick = (e) => {
    if (e.target.closest('[data-close]')) { closeSheet(); return; }
    onClick?.(e);
  };
}
function closeSheet() { const r = $('#sheet-root'); r.classList.remove('open'); r.innerHTML = ''; }

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
      if (S.source?.protocol === 'meshcore') {
        const ta = $('#input');
        if (!isMine(m)) { ta.value = `@[${nodeName(m.from)}] ${ta.value}`; ta.dispatchEvent(new Event('input')); }
      } else { S.replyTo = id; renderReplyBar(); }
      $('#input').focus();
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
      ${isMine(m) && (!m.dm || (m.heard || []).length) && S.source?.protocol === 'meshcore' ? row(T('info.heardBy'), (m.heard || []).length ? m.heard.map((r) => `${relayLabel(r)}${r.snr != null ? ` (SNR ${r.snr})` : ''}`).join(', ') : T('info.noRepeater')) : ''}
    </div>
    <button class="sheet-btn cancel" data-close>${T('common.close')}</button>`);
}

function openOwnNodes() {
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

// ------------------------------------------------------------------ Benachrichtigungen

let toastTimer = null;
function toast(text, onClick) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  t.onclick = () => { t.classList.remove('show'); onClick?.(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

function notify(fresh) {
  const relevant = fresh.filter((m) => {
    if (isMine(m) || isOwnOther(m) || m.id.startsWith('tmp-')) return false;
    if (m.reaction) { const t = targetOf(m); return t && isMine(t) && !isMuted(convOf(t)); }
    if (isMuted(convOf(m))) return false;
    return m.dm || mentionsMe(m) || convPref(convOf(m)) === 'all';
  }).filter((m) => !(S.view === 'chat' && S.conv === convOf(m) && !document.hidden));
  if (!relevant.length) return;
  if (document.hidden) {
    if (S.pushEndpoint) return; // der Server schickt eine echte Push-Nachricht – nicht doppelt anzeigen
    if (!S.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
    navigator.serviceWorker?.ready.then((reg) => {
      for (const m of relevant.slice(-3)) {
        const key = convOf(m.reaction ? targetOf(m) : m);
        const title = m.reaction ? T('notif.reacted', { name: nodeName(m.from) }) : key.startsWith('dm:') ? nodeName(m.from) : T('notif.inConv', { name: nodeName(m.from), conv: convTitle(key) });
        reg.showNotification(title, {
          body: m.reaction ? T('notif.reactBody', { emoji: m.emoji, text: targetOf(m)?.text || '' }) : m.text,
          tag: key, renotify: true, icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', data: { conv: key },
        });
      }
    });
  } else {
    const m = relevant[relevant.length - 1];
    if (m.reaction) return;
    const key = convOf(m);
    toast(`${key.startsWith('ch:') ? T('notif.inConv', { name: nodeName(m.from), conv: convTitle(key) }) : nodeName(m.from)}: ${m.text}`, () => go('chat', key));
  }
}

// ------------------------------------------------------------------ Login & Start

function showLogin() {
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

async function resync() {
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
