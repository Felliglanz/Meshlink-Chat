/* MeshLink Chat – Live-Pakete auf der Karte. */

import { LOC, T } from '../core/i18n.js';
import { $, ago, distKm, esc, fmtKm, nf } from '../core/util.js';
import { load, S } from '../core/state.js';
import { api } from '../core/api.js';
import { ic } from '../core/icons.js';
import { node } from '../data.js';
import { mapPoint, mapScale } from './map.js';

// ------------------------------------------------------------------ Live-Pakete auf der Karte
// Jedes gehörte Paket fliegt als Punkt vom Absender über die Repeater (soweit Position bekannt) zu dir.
// Daten: Paket-Log von MeshMonitor über den MeshLink-Chat-Server (alle 3 s, nur solange Live an ist und die Karte offen).
const LIVE_KINDS = {
  ADVERT: ['#7b61ff', T('pk.tAdvert')], GRP_TXT: ['#00a3a3', T('pk.tChannel')], TXT_MSG: ['#e0482f', 'DM'], ACK: ['#8f9b96', 'ACK'],
  PATH: ['#c99a00', T('pk.tPath')], TRACE: ['#ff4fa3', 'Trace'], REQ: ['#3a8fd6', T('live.query')], RESPONSE: ['#3a8fd6', T('live.query')], ANON_REQ: ['#3a8fd6', T('live.query')],
};
export const liveKind = (k) => LIVE_KINDS[k] || ['#6b7a74', T('stats.typeOther')];
S.live = { on: load('mapLive', false), after: 0, timer: null, active: 0, recent: [], noPos: 0 };

export function liveStart() {
  clearInterval(S.live.timer);
  S.live.after = 0; S.live.recent = []; S.live.noPos = 0; S.live.first = true; S.live.err = null;
  $('#live-legend')?.classList.remove('hidden');
  drawLiveLegend();
  livePoll();
  S.live.timer = setInterval(() => { if (S.view !== 'map' || !S.map) { liveStop(); return; } if (!document.hidden) livePoll(); }, 3000);
}
export function liveStop() {
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
  el.innerHTML = `<span class="live-dot">${ic('bolt')}<b>Live</b>&nbsp;${S.live.err ? `<em class="tb-err">${esc(S.live.err)}</em>` : `${T('live.perMin', { n, num: nf(n) })}${S.live.noPos ? ` · ${T('live.noPosCount', { n: nf(S.live.noPos) })}` : ''}`}</span>${kinds.map(([c, l]) => `<span class="${seen.includes(l) ? '' : 'dim'}"><b class="lg-line" style="border-color:${c}"></b>${esc(l)}</span>`).join('')}`;
}
