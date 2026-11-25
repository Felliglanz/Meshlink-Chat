/* MeshLink Chat – Karte: Laden, Stil, Vollbild, Nodes und gezeigte Wege. */

import { T } from '../core/i18n.js';
import { $, ago, compass, distKm, esc, fmtKm } from '../core/util.js';
import { APP_VERSION, load, S, save } from '../core/state.js';
import { api } from '../core/api.js';
import { ICON, ic } from '../core/icons.js';
import { closeSheet, openSheet, toast } from '../ui.js';
import { myName } from '../data.js';
import { go } from '../nav.js';
import { canDm, TYPE, typeOf } from '../views/contacts.js';
import { liveStart, liveStop } from './live.js';
import { addTraceHop, drawTraceBuild, drawTraceLegs, sendCustomTrace } from './trace.js';

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

export function leaveMap() {
  if (S.mapFull) { S.mapFull = false; document.body.classList.remove('map-full-on'); if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); }
  if (S.view === 'map') { S.mapFocus = null; S.traceBuild = null; }
  clearInterval(S.live?.timer); if (S.live) { S.live.timer = null; S.live.active = 0; }
  clearInterval(S.mapTimer);
  S.mapTimer = null;
  if (S.map) { S.map.remove(); S.map = null; }
}

export function renderMap() {
  const app = $('#app');
  if ($('.view-map', app)) return;
  S.mapDays = load('mapDays', 1);
  S.mapLinksOn = load('mapLinks', true);
  app.innerHTML = `
    <div class="view view-map">
      <header class="bar">
        <button class="icon-btn" id="back" aria-label="${esc(T('common.back'))}">${ICON.back}</button>
        <div class="bar-title"><h2>${T('map.title')}</h2><div class="sub" id="map-sub">${T('common.loading')}</div></div>
        ${S.source?.protocol === 'meshcore' ? `<button class="bar-pill${S.live.on ? ' on' : ''}" id="live-btn" title="${esc(T('map.liveTitle'))}">${ic('bolt')}Live</button><button class="bar-pill" id="trace-btn" title="${esc(T('map.traceTitle'))}">${ic('compass')}Trace</button>` : ''}
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
export function toggleMapFull(on = !S.mapFull) {
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

async function refreshMap(fit) {
  try {
    S.mapData = await api(`/api/map?days=${S.mapDays}`);
    drawMap(fit);
  } catch (e) { const sub = $('#map-sub'); if (sub) sub.textContent = T('common.error', { msg: e.message }); }
}

// Position zu einem Punkt eines Wegs: Node-ID, Name oder Repeater-Hash (nur eindeutig)
export function mapPoint(p) {
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

export const snrColor = (v) => (v == null ? '#888' : v >= 5 ? '#1f9d6b' : v >= -5 ? '#d9a12b' : '#c8372d');

// Größe von Punkten und Linien nach Zoomstufe: weit herausgezoomt (viele Nodes) klein, nah wie gewohnt
export function mapScale() {
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

export function drawMap(fit) {
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
    mk.bindPopup(`<div class="map-pop"><b>${n.fav ? ic('star') : ''}${esc(name)}</b>
      <div>${n.local ? T('map.yourNode') : t ? `${ic(t.icon)}${esc(t.label)}` : 'Node'}</div>
      <div class="muted">${T('chat.lastHeard', { ago: esc(ago(n.lastHeard)) })}${n.hops != null ? ` · ${T('common.hops', { n: n.hops })}` : ''}${n.snr != null ? ` · SNR ${esc(n.snr)}` : ''}</div>
      ${!n.local && meNode ? `<div class="muted">${ic('pin')}${T('map.fromYou', { km: fmtKm(distKm(meNode, n)), dir: compass(meNode, n) })}</div>` : ''}
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

export const FOCUS_LINE = 3; // alle Fokus-Linien (Weg, Reach, Nachbarn, Traceroute) gleich stark
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
export const focusAllBtn = () => `<button class="pill focus-all ${S.mapFocusAll ? 'on' : ''}" data-focus-all title="${esc(T('focus.allTitle'))}">${S.mapFocusAll ? T('focus.onlySel') : T('focus.allNodes')}</button>`;

// Weg auf der Karte zeigen (aus Nachricht, Traceroute oder einzelner Node)
export function showOnMap(focus) {
  S.mapFocus = focus;
  S.mapFocusAll = false;
  S.live.pauseForFocus = true;
  if (S.view === 'map') drawMap(false); else go('map');
}
