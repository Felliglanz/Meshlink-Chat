/* MeshLink Chat – Repeater-Übersicht, Wächter, Advert. */

import { T } from '../core/i18n.js';
import { $, ago, dur, esc, fmtNum, nf } from '../core/util.js';
import { load, S, save } from '../core/state.js';
import { api } from '../core/api.js';
import { ICON } from '../core/icons.js';
import { closeSheet, openSheet, permHint, toast } from '../ui.js';
import { myName } from '../data.js';
import { go } from '../nav.js';
import { trafficNum } from './node.js';
import { subscribePush } from '../push.js';

// ------------------------------------------------------------------ Repeater-Wächter (pro Gerät, über Push)
S.watch = load('watch', { on: false, hours: 6, volts: null });
const WATCH_HOURS = [1, 3, 6, 12, 24];
const WATCH_VOLTS = [null, 3.5, 3.6, 3.7];
export function openWatch() {
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

// ------------------------------------------------------------------ Repeater-Übersicht (Favoriten)

export function renderRepeaters() {
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

export function openAdvert() {
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
