/* MeshLink Chat – Eigene Traceroute auf der Karte bauen. */

import { T } from '../core/i18n.js';
import { $, distKm, esc, fmtKm, nf } from '../core/util.js';
import { S } from '../core/state.js';
import { api } from '../core/api.js';
import { ICON } from '../core/icons.js';
import { toast } from '../ui.js';
import { drawMap, FOCUS_LINE, focusAllBtn, mapPoint, snrColor } from './map.js';

// ---- Eigene Traceroute: Repeater auf der Karte in Reihenfolge antippen, der letzte ist das Ziel
const TRACE_MAX = 8;
export function addTraceHop(n) {
  const tb = S.traceBuild;
  if (!tb || tb.busy) return;
  if (n.local) { toast(T('trace.meAuto')); return; }
  if (n.type !== 2 && n.type !== 3) { toast(T('trace.onlyRpt')); return; }
  if (tb.hops.some((h) => h.id === n.id)) { toast(T('trace.dup')); return; }
  if (tb.hops.length >= TRACE_MAX) { toast(T('trace.max', { n: TRACE_MAX })); return; }
  tb.hops.push({ id: n.id, label: n.long || n.short || n.id.slice(3, 11) });
  drawMap(false);
}

export function drawTraceBuild(bar) {
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

export async function sendCustomTrace() {
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

export function drawTraceLegs(bar, f) {
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
export function traceSnr(h) {
  if (h.snr == null && h.back == null) return '';
  if (h.back == null) return `${nf(h.snr, 1)} dB`;
  return `→ ${h.snr == null ? '–' : nf(h.snr, 1)} · ← ${nf(h.back, 1)} dB`;
}
