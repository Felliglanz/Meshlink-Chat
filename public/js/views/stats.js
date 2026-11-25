/* MeshLink Chat – Statistik. */

import { LOC, T } from '../core/i18n.js';
import { $, esc, fmtBytes, fmtKm, hm, nf, pad } from '../core/util.js';
import { S } from '../core/state.js';
import { api } from '../core/api.js';
import { ICON, ic } from '../core/icons.js';
import { permHint, toast } from '../ui.js';
import { channelName } from '../data.js';
import { go } from '../nav.js';
import { showOnMap } from '../map/map.js';

// ------------------------------------------------------------------ Statistik (Tag, Tage, Monat)

const PACKET_LABELS = {
  ADVERT: T('pkt.advert'), GRP_TXT: T('pkt.grpTxt'), TXT_MSG: T('pkt.txtMsg'), ACK: T('pkt.ack'), PATH: T('pkt.path'), REQ: T('pkt.req'), RESPONSE: T('pkt.response'),
  ANON_REQ: T('pkt.anonReq'), TRACE: T('pkt.trace'), GRP_DATA: T('pkt.grpData'), MULTIPART: T('pkt.multipart'), CONTROL: T('pkt.control'), RAW_CUSTOM: T('pkt.rawCustom'),
};

// Zeitraum der Statistik: heute, gestern, letzte 7 Tage (Grenzen in der Zeitzone des Geräts).
// Bewusst nicht länger: In belebten Netzen wären das zehntausende Nachrichten – zu viel Last für kleine Geräte.
const STAT_RANGES = [['today', T('common.today')], ['yesterday', T('common.yesterday')], ['7', T('stats.days7')]];
export const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
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

export function renderStats() {
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
  const rec = (icon, title, main, sub, btn = '') => `<div class="record"><span class="record-icon">${ICON[icon]}</span><div class="record-main"><small>${esc(title)}</small><b>${esc(main)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>${btn}</div>`;
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
  if (m.channels[0]) records.push(rec('trophy', T('stats.topChannel'), m.channels[0].name, `${msgN(m.channels[0].n)}${m.channel ? ` · ${T('stats.pctOfChannel', { pct: nf((m.channels[0].n / m.channel) * 100) })}` : ''}`));
  if (m.topSenders[0]) records.push(rec('chat', T('stats.topSender'), m.topSenders[0].name, msgN(m.topSenders[0].n)));
  m.farthest.forEach((f, i) => records.push(rec(i ? 'pin' : 'radio', i ? T('stats.rankDist', { i: i + 1 }) : T('stats.farthest'), f.name, `${T('stats.airline', { km: fmtKm(f.km) })}${hopsTxt(f.hops)}`,
    mapBtn(focus({ title: `${f.name} → ${you}`, numberFrom: 0, points: [{ id: f.id, label: f.name, tag: '✉' }, { me: true, label: you }] })))));
  if (m.longest) records.push(rec('hops', T('stats.longest'), T('stats.hopsFrom', { n: m.longest.hops, name: m.longest.name }), `${multi ? `${bucketLabel(m.longest.ts, 'day')} · ` : ''}${m.longest.path.join(' › ')}`, mapBtn(focus({ title: T('map.pathFrom', { name: m.longest.name }), numberFrom: 0, points: m.longest.points }))));
  if (pk?.farDirect) records.push(rec('signal', T('stats.farDirect'), pk.farDirect.name, `${T('stats.airline', { km: fmtKm(pk.farDirect.km) })}${pk.farDirect.snr != null ? ` · SNR ${nf(pk.farDirect.snr, 1)} dB` : ''} · ${PACKET_LABELS[pk.farDirect.type] || pk.farDirect.type}`,
    mapBtn(focus({ title: T('stats.toYouDirect', { name: pk.farDirect.name }), numberFrom: 0, points: [{ id: pk.farDirect.id, label: pk.farDirect.name, tag: '📡' }, { me: true, label: you }] }))));
  if (pk?.maxHops?.hops) records.push(rec('repeat', T('stats.maxHops'), T('common.hops', { n: pk.maxHops.hops }), `${PACKET_LABELS[pk.maxHops.type] || pk.maxHops.type} · ${pk.maxHops.path.join(' › ')}`, mapBtn(focus({ title: T('stats.packetOver', { n: pk.maxHops.hops }), numberFrom: 1, points: pk.maxHops.points }))));
  if (m.busiest) records.push(rec('clock', multi ? T('stats.busiestDay') : T('stats.busiestHour'), bucketLabel(m.busiest.start, unit), msgN(m.busiest.n)));
  if (m.longText) records.push(rec('note', T('stats.longText'), m.longText.name, T('stats.bytes', { n: m.longText.bytes, num: nf(m.longText.bytes) })));

  const types = { 1: T('stats.typeCompanions'), 2: T('stats.typeRepeaters'), 3: T('stats.typeRooms'), 4: T('stats.typeSensors'), 0: T('stats.typeOther') };
  const hopHist = pk ? pk.hopHist.map((n, h) => ({ label: h === 0 ? T('stats.hop0') : h === 8 ? T('stats.hop8') : T('common.hops', { n: h }), n })).filter((r) => r.n) : [];
  const warn = [
    m.truncated ? T('stats.warnTrunc') : '',
    m.skipped?.length || m.dmSkipped ? T('stats.warnSkipped', { list: [...(m.skipped || []), ...(m.dmSkipped ? [T('list.dms')] : [])].join(', ') }) : '',
    pk?.truncated ? T('stats.warnPkTrunc', { n: nf(100000) }) : '',
  ].filter(Boolean);
  const covNote = p && cov ? `<div class="note">${ic('box')}${covGone
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
