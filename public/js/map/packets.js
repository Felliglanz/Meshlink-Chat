/* MeshLink Chat – Paket-Analyzer. */

import { LOC, T } from '../core/i18n.js';
import { $, esc, nf, pad } from '../core/util.js';
import { load, S, save } from '../core/state.js';
import { api } from '../core/api.js';
import { ICON, ic } from '../core/icons.js';
import { closeSheet, openSheet, permHint, toast } from '../ui.js';
import { node } from '../data.js';
import { showOnMap } from './map.js';
import { liveKind } from './live.js';

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
export function renderPackets() {
  const app = $('#app');
  if ($('.view-packets', app)) return;
  const f = S.pk.f;
  app.innerHTML = `
    <div class="view view-packets">
      <header class="bar">
        <button class="icon-btn" id="back" aria-label="${esc(T('common.back'))}">${ICON.back}</button>
        <div class="bar-title"><h2>${T('pk.title')}</h2><div class="sub" id="pk-sub">${T('common.loading')}</div></div>
        <button class="bar-pill ${S.pk.live ? 'on' : ''}" id="pk-live" title="${esc(T('pk.liveTitle'))}">${ic('bolt')}Live</button>
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
  if (p.text) line2 = `${ic('chat')}${esc(p.text)}`;
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
        ${p.type !== 9 && p.path.length ? `<button class="route-map" data-pk-act="map">${ic('map')}${T('pk.mapBtn')}</button>` : ''}
        ${p.path.length && p.type !== 9 ? `<button class="route-map" data-pk-act="via">${T('pk.onlyVia', { name: esc(pkHop(p.path[p.path.length - 1])) })}</button>` : ''}
        ${p.from ? `<button class="route-map" data-pk-act="from">${T('pk.onlyFrom', { name: esc(from || T('pk.thisSender')) })}</button>` : ''}
      </div>
      ${d ? `<div class="pk-sec">${T('pk.breakdown')} <small>${T('pk.breakdownSub', { n: d.total })}</small></div>
        <div class="pk-hex" id="pk-hex">${hex}</div>
        <div class="pk-fields">${table}</div>
        ${d.errors.length ? `<div class="lp-note">${ic('warn')}${esc(d.errors.join(' · '))}</div>` : ''}
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
