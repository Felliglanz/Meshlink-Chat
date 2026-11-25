/* MeshLink Chat – Node-Seite: Status, Verlauf, Traceroute, Nachbarn, Reach. */

import { LOC, T } from '../core/i18n.js';
import { $, ago, dayLabel, dur, esc, fmtKm, fmtNum, nf } from '../core/util.js';
import { load, S, save } from '../core/state.js';
import { api } from '../core/api.js';
import { ICON } from '../core/icons.js';
import { avatar, permHint } from '../ui.js';
import { node } from '../data.js';
import { go } from '../nav.js';
import { canDm, toggleFav, typeOf } from './contacts.js';
import { addDays, dayStart } from './stats.js';
import { showOnMap, snrColor } from '../map/map.js';
import { traceSnr } from '../map/trace.js';
import { canAdmin } from './admin.js';

// ------------------------------------------------------------------ Node-Details: Status, Verlauf, Traceroute

export const STATUS_FIELDS = [
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

function sparkline(points) {
  if (!points || points.length < 2) return `<div class="muted spark-empty">${T('node.fewValues')}</div>`;
  const xs = points.map((p) => p[0]); const ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs); const x1 = Math.max(...xs); let y0 = Math.min(...ys); let y1 = Math.max(...ys);
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const W = 300; const H = 60;
  const pts = points.map(([x, y]) => `${(((x - x0) / (x1 - x0 || 1)) * W).toFixed(1)},${(H - 4 - ((y - y0) / (y1 - y0)) * (H - 8)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${pts}"/></svg>`;
}

export function renderNode() {
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

export const nodeKind = (n) => (n?.type === 4 ? 'lpp' : n?.type === 2 || n?.type === 3 ? 'status' : null);

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

// Paketverkehr eines Repeaters: aus seinen eigenen Zählern (Status-Telemetrie), berechnet im Server (repeaterTraffic).
// "mind." = Neustart im Zeitraum (davor fehlen Pakete), "–" = Messungen decken den Zeitraum nicht ab.
export const trafficNum = (d) => (d ? `${d.lower ? `${T('traffic.atLeast')}\u00a0` : ''}${nf(d.n)}` : '–');
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
export async function fetchNeighbours(id, prev = null) {
  const offset = prev ? prev.neighbours.length : 0;
  const r = await api(`/api/node/neighbours?id=${encodeURIComponent(id)}&live=1${offset ? `&offset=${offset}` : ''}`);
  if (!prev) return { ...r, live: true };
  const seen = new Set(prev.neighbours.map((x) => x.id || x.hash));
  return { ...r, live: true, neighbours: [...prev.neighbours, ...r.neighbours.filter((x) => !seen.has(x.id || x.hash))], total: r.total ?? prev.total };
}
export const nbMore = (nb) => Boolean(nb?.live && nb.total != null && nb.total > nb.neighbours.length);
export const nbMoreLabel = (nb) => T('node.nbMore', { n: nb.neighbours.length, total: nb.total });

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
