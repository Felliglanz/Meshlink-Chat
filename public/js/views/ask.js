/* MeshLink Chat – Frag die App: Fragen in einfacher Sprache, Antworten aus den vorhandenen Daten.
   Keine KI und kein Dienst von außen: Die Frage wird über Stichwörter (deutsch und englisch) einer festen Liste von
   Antworten zugeordnet, Knoten werden am Namen erkannt (auch mit kleinen Tippfehlern). Unverstanden = ehrlich sagen
   und Vorschläge machen, nie raten. Der Verlauf liegt nur im Speicher dieser Seite. */

import { T } from '../core/i18n.js';
import { $, ago, dayLabel, esc, fmtKm, hm, nf } from '../core/util.js';
import { S } from '../core/state.js';
import { api } from '../core/api.js';
import { ICON, ic } from '../core/icons.js';
import { permHint } from '../ui.js';
import { channelName, isMine, nodeName, relayLabel } from '../data.js';
import { go } from '../nav.js';
import { airLevel, airOf, dayStart, glanceLines, pct } from './stats.js';

// ------------------------------------------------------------------ Text vergleichen
// Kleinbuchstaben, ohne Akzente/Umlaut-Punkte, ß = ss, Satzzeichen = Leerzeichen
const norm = (s) => ` ${String(s || '').toLowerCase().replace(/ß/g, 'ss').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\p{L}\p{N}%]+/gu, ' ').trim()} `;
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}
// Kommt das Stichwort am Wortanfang vor? (Mehrwort-Stichwörter als Ganzes)
const has = (q, kw) => q.includes(` ${kw}`);

// Absichten mit Stichwörtern (deutsch + englisch, schon in Vergleichsform). Höchste Summe der Treffer-Längen gewinnt.
const INTENTS = {
  help: ['hilfe', 'was kannst', 'was weisst du', 'beispiel', 'help', 'what can', 'examples'],
  today: ['heute', 'ist los', 'was ist los', 'was war los', 'was geht', 'uberblick', 'zusammenfassung', 'wie viele nachrichten', 'wer war aktiv', 'today', 'going on', 'happening', 'summary', 'overview', 'how many messages'],
  renames: ['umbenannt', 'namen gewechselt', 'namenswechsel', 'name gewechselt', 'namen geandert', 'alter name', 'alten namen', 'andere namen', 'fruher geheissen', 'hiess', 'renamed', 'rename', 'old name', 'other names', 'changed name', 'name change', 'previous name'],
  twins: ['doppelganger', 'gleichen namen', 'selben namen', 'gleicher name', 'gleichnamig', 'nachahm', 'falscher', 'falsche', 'fake', 'duplicate', 'same name', 'impersonat', 'twin'],
  origin: ['woher', 'wo kommt', 'wo steht', 'wo ist', 'wo sitzt', 'herkunft', 'richtung', 'standort', 'wie weit weg', 'where', 'location', 'direction', 'how far'],
  last: ['zuletzt', 'wann', 'online', 'erreichbar', 'noch da', 'lebt', 'last heard', 'last seen', 'when', 'is alive', 'still there', 'reachable'],
  mydm: ['meine dm', 'meine letzte', 'letzte dm', 'letzte nachricht', 'angekommen', 'zugestellt', 'bestatigt', 'bestatigung', 'my dm', 'my last', 'last dm', 'delivered', 'arrived', 'receipt'],
  neighbors: ['bringt mir', 'nachbar', 'wichtigste repeater', 'welcher repeater', 'hore ich', 'hor ich', 'direkt gehort', 'neighbo', 'best repeater', 'which repeater', 'hear directly'],
  far: ['weitest', 'reichweite', 'am weitesten', 'entfernung', 'farthest', 'furthest', 'range', 'distance'],
  new: ['neu im netz', 'neue knoten', 'neue nodes', 'neues', 'neu ', 'zum ersten mal', 'new nodes', 'new on', 'whats new', 'first time'],
  air: ['auslastung', 'airtime', 'duty', 'sendezeit', 'funk voll', 'wie voll', 'belegt', '10 %', '10%', 'kanal voll', 'channel load', 'busy air', 'utilisation', 'utilization'],
  busy: ['funkt am meisten', 'sendet am meisten', 'vielsender', 'spam', 'adverts', 'zu oft', 'flutet', 'lautest', 'most packets', 'transmits most', 'who sends most', 'spammer', 'too often'],
  repeaters: ['meinen repeatern', 'meine repeater', 'repeater status', 'akku', 'batterie', 'wie geht', 'my repeaters', 'battery', 'how are'],
  profile: ['uber ', 'wer ist', 'steckbrief', 'profil', 'infos', 'erzahl', 'kennst du', 'about', 'who is', 'profile', 'tell me'],
  explain: ['was heisst', 'was ist', 'was bedeutet', 'was sind', 'erklar', 'what is', 'what are', 'what does', 'meaning', 'explain'],
};
// Begriffe für "Was heißt …?" (Schlüssel = Erklärtext gl.<key>)
const TERMS = {
  snr: ['snr', 'signal rausch', 'signal noise'], rssi: ['rssi', 'signalstarke', 'signal strength'], flood: ['flood', 'fluten'], hops: ['hop', 'hops', 'sprunge'],
  advert: ['advert', 'adverts', 'anmeldung'], repeater: ['repeater', 'relais'], companion: ['companion', 'begleiter'], room: ['room', 'room server', 'brett'],
  ack: ['ack', 'bestatigung', 'receipt'], path: ['weg', 'pfad', 'route', 'path', 'fester weg', 'fixed route'], duty: ['duty', 'duty cycle', '10 %', 'sendezeit', 'airtime'],
  scope: ['scope', 'region'], sf: ['sf', 'spreading', 'bandbreite', 'bandwidth', 'coding rate'], trace: ['trace', 'traceroute'],
};

// ------------------------------------------------------------------ Knoten am Namen erkennen
function candidates() {
  const out = [];
  for (const n of S.nodes.values()) {
    if (n.id === S.me) continue;
    for (const nm of [n.long, n.short]) if (nm) out.push({ id: n.id, name: n.long || n.short, key: norm(nm).trim() });
  }
  // Kanal-Absender, die keinem Knoten zugeordnet sind (nur ein Name im Text)
  const known = new Set(out.map((c) => c.key));
  for (const m of S.msgs.values()) {
    if (m.dm || !m.name || isMine(m)) continue;
    const k = norm(m.name).trim();
    if (k && !known.has(k)) { known.add(k); out.push({ id: null, name: m.name, key: k }); }
  }
  return out;
}
// Bester Treffer: ganzer Name im Text, sonst Namensteile mit höchstens 1–2 Tippfehlern
function findNode(q) {
  const words = q.trim().split(' ').filter(Boolean);
  let best = null;
  for (const c of candidates()) {
    if (c.key.length < 2) continue;
    let score = 0;
    if (q.includes(` ${c.key} `) || (c.key.length >= 4 && q.includes(c.key))) score = c.key.length * 2;
    else {
      const parts = c.key.split(' ').filter((p) => p.length >= 4);
      let hit = 0;
      for (const p of parts) if (words.some((w) => w.length >= 4 && lev(w, p) <= (p.length > 6 ? 2 : 1))) hit += p.length;
      if (hit && hit >= Math.min(...parts.map((p) => p.length))) score = hit;
    }
    if (score && (!best || score > best.score)) best = { ...c, score };
  }
  return best;
}
function detect(text) {
  const q = norm(text);
  const score = {};
  for (const [id, kws] of Object.entries(INTENTS)) for (const kw of kws) if (has(q, kw)) score[id] = (score[id] || 0) + kw.length;
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const node = findNode(q);
  let term = null;
  for (const [k, kws] of Object.entries(TERMS)) if (kws.some((kw) => has(q, kw) && q.includes(`${kw} `))) { term = k; break; }
  // "Was ist …" ohne bekannten Begriff zählt nicht ("Was ist heute los?"); mit Knoten gelten nur Fragen über ihn
  const NODE_OK = ['last', 'origin', 'renames', 'twins', 'profile'];
  let intent = ranked.find((id) => (id === 'explain' ? Boolean(term) : !node || NODE_OK.includes(id))) || null;
  if (node && !intent) intent = 'profile';
  if (!intent && term && q.trim().split(' ').length <= 3) intent = 'explain';
  return { intent, node, term };
}

// ------------------------------------------------------------------ Daten
const statsCache = { at: 0, data: null };
async function todayStats() {
  if (statsCache.data && Date.now() - statsCache.at < 60000) return statsCache.data;
  const from = dayStart(new Date()).getTime();
  const starts = []; for (let h = 0; h < 24; h++) { const t = new Date(from); t.setHours(h, 0, 0, 0); if (t.getTime() < Date.now()) starts.push(t.getTime()); }
  const st = await api(`/api/stats?from=${from}&to=${Date.now()}&b=${starts.join(',')}`);
  statsCache.at = Date.now(); statsCache.data = st;
  return st;
}
const TYPE = () => ({ 1: T('type.companion'), 2: T('type.repeater'), 3: T('type.room'), 4: T('type.sensor') });
const when = (ts) => `${dayLabel(ts)} ${hm(ts)}`;
const dir = (deg) => (deg == null ? '' : T('map.compass').split(' ')[Math.round(deg / 45) % 8]);
const L = (icon, text) => [icon, text]; // Zeile einer Antwort (Text wird escaped)

// ------------------------------------------------------------------ Antworten
// Jede Antwort: { lines: [[icon, text]], note?, actions?: [{label, node?|stats?|chat?}] }
const ANSWER = {
  help: () => ({ lines: [L('ask', T('ask.helpIntro'))], suggest: SUGGEST(), note: T('ask.helpNote') }),

  async today() {
    const st = await todayStats();
    return { lines: glanceLines(st), actions: [{ label: T('ask.openStats'), stats: true }] };
  },

  async last({ node }) {
    if (!node.id) {
      const msgs = [...S.msgs.values()].filter((m) => !m.dm && m.name === node.name && !isMine(m)).sort((a, b) => b.ts - a.ts);
      return { lines: [msgs.length ? L('chat', T('ask.lastMsgName', { name: node.name, when: when(msgs[0].ts) })) : L('info', T('ask.neverName', { name: node.name }))], note: T('ask.nameOnly') };
    }
    const n = S.nodes.get(node.id);
    const lines = [];
    if (n?.lastHeard) lines.push(L('clock', T('ask.lastHeard', { name: node.name, ago: ago(n.lastHeard), when: when(n.lastHeard) })));
    else lines.push(L('info', T('ask.neverHeard', { name: node.name })));
    if (n?.hops != null) lines.push(L('hops', n.hops === 0 ? T('ask.hops0') : T('ask.hopsN', { n: n.hops })));
    if (n?.snr != null) lines.push(L('signal', T('ask.snr', { v: nf(n.snr, 1) })));
    return { lines, actions: [{ label: T('ask.openNode'), node: node.id }] };
  },

  async profile({ node }, mode = 'all') {
    const r = await api(`/api/ask?what=profile&${node.id ? `id=${encodeURIComponent(node.id)}` : `name=${encodeURIComponent(node.name)}`}`);
    const lines = [];
    const n = r.node;
    if (n && mode === 'all') {
      lines.push(L('user', [TYPE()[n.type] || T('ask.typeUnknown'), n.fav ? T('ask.isFav') : ''].filter(Boolean).join(' · ')));
      if (n.firstHeard) lines.push(L('clock', T('ask.firstHeard', { when: when(n.firstHeard) })));
      if (n.lastHeard) lines.push(L('clock', T('ask.lastHeardShort', { ago: ago(n.lastHeard) })));
    }
    if (n && (mode === 'all' || mode === 'origin')) {
      if (n.km != null) lines.push(L('compass', T('ask.distance', { km: fmtKm(n.km), dir: dir(n.deg) })));
      else if (mode === 'origin') lines.push(L('compass', T('ask.noPos', { name: r.name })));
      if (n.hops != null) lines.push(L('hops', n.hops === 0 ? T('ask.hops0') : T('ask.hopsN', { n: n.hops })));
    }
    // Woher: erster Repeater nach dem Absender (aus Adverts im Paket-Log bzw. aus den geladenen Nachrichten)
    const via = (r.via?.length ? r.via : r.msgs?.via || []).filter((v) => v.n);
    if (via.length && (mode === 'all' || mode === 'origin')) {
      const total = via.reduce((a, v) => a + v.n, 0);
      const parts = via.slice(0, 3).map((v) => (v.hash ? `${relayLabel(v)} (${nf((v.n / total) * 100)} %)` : `${T('ask.direct')} (${nf((v.n / total) * 100)} %)`));
      lines.push(L('radio', T('ask.via', { list: parts.join(', ') })));
    }
    // Namen im Lauf der Zeit
    if (r.names && (mode === 'all' || mode === 'names')) {
      if (r.names.length > 1) lines.push(L('warn', T('ask.namesMany', { list: r.names.map((x) => `„${x.name}“ (${T('ask.until', { when: when(x.last) })})`).join(', ') })));
      else if (r.names.length === 1) lines.push(L('check', T('ask.namesOne', { name: r.names[0].name, when: when(r.packetLogFrom || r.names[0].first) })));
      else lines.push(L('info', T('ask.namesNone')));
    }
    if (r.twins?.length && mode !== 'origin') lines.push(L('warn', T('ask.twins', { n: r.twins.length, list: r.twins.slice(0, 4).map((x) => `${x.name} (${x.id.slice(3, 9)}…)`).join(', ') })));
    else if (mode === 'twins') lines.push(L('check', T('ask.noTwins', { name: r.name })));
    if (r.adverts && mode === 'all') lines.push(L('megaphone', r.adverts.perDay != null && r.adverts.perDay > 48 ? T('ask.advertsMany', { n: nf(r.adverts.n), d: nf(r.adverts.perDay) }) : T('ask.adverts', { n: nf(r.adverts.n), d: r.adverts.perDay != null ? nf(r.adverts.perDay, 1) : '–' })));
    if (r.msgs && mode === 'all') lines.push(L('chat', T('ask.msgs', { n: r.msgs.n, when: when(r.msgs.last), ch: r.msgs.channels.map((c) => c.name || channelName(c.index)).join(', ') || T('list.dms'), num: nf(r.msgs.n) })));
    if (!lines.length) lines.push(L('info', T('ask.nothing', { name: r.name })));
    const notes = [];
    if (!n) notes.push(T('ask.nameOnly'));
    if (r.packetForbidden) notes.push(T('ask.pkForbidden'));
    else if (r.packetLogFrom) notes.push(T('ask.logFrom', { when: when(r.packetLogFrom) }));
    const actions = [];
    if (n) actions.push({ label: T('ask.openNode'), node: n.id });
    return { title: r.name, lines, note: notes.join(' '), actions };
  },
  origin: (d) => ANSWER.profile(d, 'origin'),

  async renames({ node }) {
    if (node) return ANSWER.profile({ node }, 'names');
    const r = await api('/api/ask?what=renames');
    if (r.unsupported) return { lines: [L('info', T('ask.mcOnly'))] };
    const lines = r.renames.length
      ? r.renames.slice(0, 8).map((x) => L('repeat', T('ask.renamed', { now: x.now, before: x.before.join(', '), when: when(x.at) })))
      : [L('check', T('ask.noRenames'))];
    return { lines, note: T('ask.logFrom', { when: when(r.from || Date.now()) }), actions: r.renames.slice(0, 3).map((x) => ({ label: x.now, node: S.nodes.has(x.id) ? x.id : null })).filter((a) => a.node) };
  },

  async twins({ node }) {
    if (node) return ANSWER.profile({ node }, 'twins');
    const r = await api('/api/ask?what=renames');
    if (r.unsupported) return { lines: [L('info', T('ask.mcOnly'))] };
    const lines = r.twins.length ? r.twins.map((x) => L('warn', T('ask.twinName', { name: x.name, n: x.n }))) : [L('check', T('ask.noTwinsAll'))];
    return { lines, note: `${T('ask.twinsNote')} ${T('ask.logFrom', { when: when(r.from || Date.now()) })}` };
  },

  async mydm() {
    const m = [...S.msgs.values()].filter((x) => x.dm && isMine(x) && !x.id.startsWith('tmp-')).sort((a, b) => b.ts - a.ts)[0];
    if (!m) return { lines: [L('mail', T('ask.noDm'))] };
    const lines = [L('mail', T('ask.dmTo', { name: nodeName(m.to), when: when(m.ts), text: m.text.slice(0, 60) }))];
    if (m.state === 'delivered') lines.push(L('check', m.rtt ? T('ask.dmOkRtt', { s: nf(m.rtt / 1000, 1) }) : T('ask.dmOk')));
    else if (m.state === 'failed') lines.push(L('warn', T('ask.dmFail')));
    else lines.push(L('clock', T('ask.dmOpen')));
    const heard = (m.heard || []).filter((r) => r.snr != null);
    if (m.heardDirect?.length) lines.push(L('radio', T('ask.dmDirect', { name: m.heardDirect[0].via ? relayLabel(m.heardDirect[0].via) : T('heard.directVia') })));
    else if (heard.length) lines.push(L('radio', T('ask.dmHeard', { n: heard.length, list: heard.slice(0, 3).map(relayLabel).join(', ') })));
    if (m.outRoute) lines.push(L('hops', m.outRoute.hops.length ? T('ask.dmRoute', { path: m.outRoute.hops.map(relayLabel).join(' › ') }) : m.outRoute.flood ? T('ask.dmRouteFlood') : T('ask.dmRouteDirect')));
    return { lines, actions: [{ label: T('ask.openChat'), chat: `dm:${m.to}` }] };
  },

  async neighbors() {
    const st = await todayStats();
    const p = st.packets && !st.packets.error ? st.packets : null;
    if (!p) return { lines: [L('info', T('ask.noPk'))] };
    const lines = p.lastHop.slice(0, 4).map((r, i) => L(i ? 'radio' : 'trophy', T('ask.neighbor', { name: r.name || `#${r.hash}`, n: nf(r.n), snr: r.snr != null ? nf(r.snr, 1) : '–' })));
    return { lines: lines.length ? lines : [L('info', T('ask.noNeighbors'))], note: T('ask.neighborNote'), actions: p.lastHop.slice(0, 2).filter((r) => r.id).map((r) => ({ label: r.name, node: r.id })) };
  },

  async far() {
    const st = await todayStats();
    const m = st.msgs; const p = st.packets && !st.packets.error ? st.packets : null;
    const lines = [];
    if (m.farthest[0]) lines.push(L('pin', T('ask.farMsg', { name: m.farthest[0].name, km: fmtKm(m.farthest[0].km) })));
    if (p?.farDirect) lines.push(L('signal', T('ask.farDirect', { name: p.farDirect.name, km: fmtKm(p.farDirect.km) })));
    if (p?.maxHops?.hops) lines.push(L('hops', T('ask.maxHops', { n: p.maxHops.hops })));
    if (!m.hasMyPos) lines.push(L('info', T('stats.needPos')));
    return { lines: lines.length ? lines : [L('info', T('ask.noFar'))], actions: [{ label: T('ask.openStats'), stats: true }] };
  },

  async new() {
    const st = await todayStats();
    if (!st.newNodes) return { lines: [L('info', T('ask.newUnsupported'))] };
    const lines = st.newNodes.list.length
      ? st.newNodes.list.slice(0, 8).map((n) => L(n.type === 2 ? 'radio' : 'user', T('ask.newNode', { name: n.name, type: TYPE()[n.type] || T('ask.typeUnknown'), when: hm(n.at) })))
      : [L('check', T('stats.newNone'))];
    return { lines, actions: st.newNodes.list.slice(0, 3).filter((n) => S.nodes.has(n.id)).map((n) => ({ label: n.name, node: n.id })) };
  },

  async air() {
    const st = await todayStats();
    const air = airOf(st);
    const lines = [];
    if (air) lines.push(L('pulse', T('stats.gAir', { pct: pct(air.pct), level: airLevel(air.pct) })));
    else lines.push(L('info', T(st.radio ? 'stats.airNoPk' : 'stats.airNoRadio')));
    for (const r of st.airtime?.repeaters || []) {
      lines.push(r.tx ? L(r.tx.pct >= 10 ? 'warn' : 'radio', T(r.tx.pct >= 10 ? 'ask.dutyOver' : 'ask.duty', { name: r.name, pct: pct(r.tx.pct), peak: r.tx.peak ? pct(r.tx.peak.pct) : '–' })) : L('info', T('ask.dutyNone', { name: r.name })));
    }
    return { lines, note: T('help.duty'), actions: [{ label: T('ask.openStats'), stats: true }] };
  },

  async busy() {
    const r = await api('/api/ask?what=busy');
    if (r.unsupported) return { lines: [L('info', T('ask.mcOnly'))] };
    const twice = new Set(r.rows.filter((x, i) => r.rows.findIndex((y) => y.name === x.name) !== i).map((x) => x.name));
    for (const x of r.rows) if (twice.has(x.name)) x.name = `${x.name} (${x.id.slice(3, 9)}…)`;
    const lines = r.rows.slice(0, 6).map((x, i) => L(i ? 'radio' : 'trophy', r.radio
      ? T('ask.busyRowAir', { name: x.name, n: nf(x.n), ads: nf(x.adverts), s: nf(x.ms / 1000, x.ms < 10000 ? 1 : 0) })
      : T('ask.busyRow', { name: x.name, n: nf(x.n), ads: nf(x.adverts) })));
    const spam = r.rows.filter((x) => x.adverts > 24);
    if (spam.length) lines.push(L('warn', T('ask.busySpam', { list: spam.map((x) => x.name).join(', ') })));
    return { lines: lines.length ? lines : [L('info', T('ask.noPk'))], note: T('ask.busyNote', { n: nf(r.total), anon: nf(r.anon), when: when(r.from) }), actions: r.rows.slice(0, 2).filter((x) => S.nodes.has(x.id)).map((x) => ({ label: x.name, node: x.id })) };
  },

  async repeaters() {
    const [h, st] = await Promise.all([api('/api/repeaters'), todayStats().catch(() => null)]);
    const duty = new Map((st?.airtime?.repeaters || []).map((r) => [r.id, r]));
    if (!h.repeaters?.length) return { lines: [L('info', T('ask.noFavRep'))] };
    const lines = h.repeaters.map((r) => {
      const bits = [r.lastHeard ? T('ask.repLast', { ago: ago(r.lastHeard) }) : T('ask.repNever')];
      if (r.status?.battery) bits.push(T('ask.repBat', { v: nf(r.status.battery.v, 2) }));
      const d = duty.get(r.id);
      if (d?.tx) bits.push(T('ask.repDuty', { pct: pct(d.tx.pct) }));
      const silent = r.lastHeard && Date.now() - r.lastHeard > 6 * 3600000;
      return L(silent || (d?.tx?.pct >= 10) ? 'warn' : 'radio', `${r.name}: ${bits.join(' · ')}`);
    });
    return { lines, actions: [{ label: T('ask.openRepeaters'), view: 'repeaters' }] };
  },

  explain: ({ term, node }) => {
    if (!term && node) return ANSWER.profile({ node });
    return { lines: [L('info', T(`gl.${term}`))] };
  },
};

// ------------------------------------------------------------------ Vorschläge
const SUGGEST = () => [T('ask.s.today'), T('ask.s.renames'), T('ask.s.mydm'), T('ask.s.air'), T('ask.s.new'), T('ask.s.neighbors'), T('ask.s.busy'), T('ask.s.repeaters'), T('ask.s.twins'), T('ask.s.far'), T('ask.s.snr')];
const NODE_SUGGEST = (name) => [T('ask.t.profile', { name }), T('ask.t.last', { name }), T('ask.t.origin', { name }), T('ask.t.names', { name })];
function suggestFor(text) {
  const q = norm(text);
  const words = q.trim().split(' ').filter((w) => w.length >= 2);
  if (!words.length) return [];
  const out = [];
  // Knotennamen, die mit dem Getippten anfangen (letztes Wort) oder darin vorkommen
  const last = words[words.length - 1];
  const nodes = candidates().filter((c) => c.key.split(' ').some((p) => p.startsWith(last)) || (last.length >= 4 && lev(last, c.key.split(' ')[0]) <= 1));
  const seen = new Set();
  for (const c of nodes.slice(0, 2)) if (!seen.has(c.name)) { seen.add(c.name); out.push(...NODE_SUGGEST(c.name).slice(0, 3)); }
  for (const s of SUGGEST()) { const ns = norm(s); if (words.every((w) => ns.includes(` ${w}`) || ns.split(' ').some((p) => p.length >= 4 && lev(p, w) <= 1))) out.push(s); }
  return [...new Set(out)].slice(0, 6);
}

// ------------------------------------------------------------------ Ansicht
S.askLog = S.askLog || [];
export function renderAsk() {
  const app = $('#app');
  if ($('.view-ask', app)) return;
  app.innerHTML = `
    <div class="view view-ask">
      <header class="bar">
        <button class="icon-btn" id="back" aria-label="${esc(T('common.back'))}">${ICON.back}</button>
        <div class="bar-title"><h2>${T('ask.title')}</h2><div class="sub">${T('ask.sub')}</div></div>
      </header>
      <main class="scroll ask-log" id="ask-log"></main>
      <footer class="composer-wrap ask-foot">
        <div class="ask-suggest" id="ask-suggest"></div>
        <form class="composer ask-form" id="ask-form" autocomplete="off">
          <input id="ask-input" type="text" enterkeyhint="send" maxlength="200" placeholder="${esc(T('ask.ph'))}" aria-label="${esc(T('ask.ph'))}">
          <button class="send" type="submit" aria-label="${esc(T('ask.send'))}">${ICON.send}</button>
        </form>
      </footer>
    </div>`;
  $('#back').onclick = () => history.back();
  const input = $('#ask-input');
  $('#ask-form').onsubmit = (e) => { e.preventDefault(); const q = input.value.trim(); if (q) { input.value = ''; drawSuggest(); ask(q); } };
  input.oninput = drawSuggest;
  const pick = (e) => {
    const b = e.target.closest('[data-q]'); if (b) { input.value = ''; drawSuggest(); ask(b.dataset.q); return; }
    const a = e.target.closest('[data-ask-node]'); if (a) { go('node', a.dataset.askNode); return; }
    const c = e.target.closest('[data-ask-chat]'); if (c) { go('chat', c.dataset.askChat); return; }
    const v = e.target.closest('[data-ask-view]'); if (v) go(v.dataset.askView);
  };
  $('#ask-log').onclick = pick;
  $('#ask-suggest').onclick = pick;
  drawLog();
  setTimeout(() => input.focus(), 50);
}
function drawSuggest() {
  const el = $('#ask-suggest');
  if (!el) return;
  const list = suggestFor($('#ask-input').value);
  el.innerHTML = list.map((s) => `<button type="button" class="ask-chip" data-q="${esc(s)}">${esc(s)}</button>`).join('');
}
const chips = (list) => `<div class="ask-chips">${list.map((s) => `<button type="button" class="ask-chip" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>`;
function answerHtml(a) {
  if (a.busy) return `<div class="ask-a busy">${ic('clock')}${T('ask.thinking')}</div>`;
  if (a.error) return `<div class="ask-a">${ic('warn')}<span>${esc(a.error)}</span></div>`;
  const r = a.res;
  return `<div class="ask-a">
    ${r.title ? `<b class="ask-title">${esc(r.title)}</b>` : ''}
    <ul>${r.lines.map(([icon, text]) => `<li>${ic(icon)}<span>${esc(text)}</span></li>`).join('')}</ul>
    ${r.note ? `<div class="ask-note">${esc(r.note)}</div>` : ''}
    ${r.suggest ? chips(r.suggest) : ''}
    ${r.actions?.length ? `<div class="ask-actions">${r.actions.map((x) => (x.node ? `<button class="pill" data-ask-node="${esc(x.node)}">${esc(x.label)}</button>`
      : x.chat ? `<button class="pill" data-ask-chat="${esc(x.chat)}">${esc(x.label)}</button>`
        : x.stats ? `<button class="pill" data-ask-view="stats">${esc(x.label)}</button>`
          : x.view ? `<button class="pill" data-ask-view="${esc(x.view)}">${esc(x.label)}</button>` : '')).join('')}</div>` : ''}
  </div>`;
}
function drawLog() {
  const el = $('#ask-log');
  if (!el) return;
  if (!S.askLog.length) {
    el.innerHTML = `<div class="ask-intro">${ic('ask')}<p>${esc(T('ask.intro'))}</p>${chips(SUGGEST().slice(0, 8))}<small>${esc(T('ask.privacy'))}</small></div>`;
    return;
  }
  el.innerHTML = S.askLog.map((x) => `<div class="ask-q"><span>${esc(x.q)}</span></div>${answerHtml(x)}`).join('');
  el.scrollTop = el.scrollHeight;
}
async function ask(q) {
  const entry = { q, busy: true };
  S.askLog.push(entry);
  if (S.askLog.length > 30) S.askLog.shift();
  drawLog();
  const d = detect(q);
  try {
    if (!d.intent) entry.res = { lines: [L('info', T('ask.unknown'))], suggest: [...(d.node ? NODE_SUGGEST(d.node.name) : []), ...SUGGEST()].slice(0, 6) };
    else if (['last', 'origin', 'profile'].includes(d.intent) && !d.node) entry.res = { lines: [L('info', T('ask.whichNode'))], suggest: SUGGEST().slice(0, 4) };
    else if (S.source?.protocol !== 'meshcore' && ['air', 'neighbors', 'busy', 'repeaters', 'renames', 'twins'].includes(d.intent)) entry.res = { lines: [L('info', T('ask.mcOnly'))] };
    else entry.res = await ANSWER[d.intent](d);
  } catch (e) {
    entry.error = permHint(e, 'packets:read');
  }
  entry.busy = false;
  if (S.view === 'ask') drawLog();
}
