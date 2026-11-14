'use strict';
/*
 * MeshLink Chat – kleine PWA-Chat-Oberfläche für MeshMonitor.
 * Keine npm-Abhängigkeiten. Spricht ausschließlich mit der REST-API von MeshMonitor:
 *   /api/v1/sources/{id}/…           Nodes, Kanäle, Nachrichten, Pakete, Telemetrie, Traceroute
 *   /api/sources/{id}/meshcore/…     MeshCore-Extras (Reaktionen, Scope, Resend, Advert, Kontakte, Rooms)
 * Gespeichert wird nichts außer den Push-Abos (max. 10, siehe push.js); alles andere liegt nur im Speicher.
 */
const VERSION = '1.2.0';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const cfg = {
  // BIND_ADDR/HOST_PORT aus der .env; HOST/PORT haben Vorrang (ältere Installationen)
  port: Number(process.env.PORT || process.env.HOST_PORT || 8090),
  host: process.env.HOST || process.env.BIND_ADDR || '0.0.0.0',
  mmUrl: (process.env.MM_URL || 'http://localhost:8080').replace(/\/+$/, ''),
  mmToken: process.env.MM_TOKEN || '',
  sourceId: process.env.MM_SOURCE || '',
  password: process.env.APP_PASSWORD || '',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  pollMs: Math.max(1000, Number(process.env.POLL_MS || 3000)),
  idlePollMs: Math.max(5000, Number(process.env.IDLE_POLL_MS || 15000)),
  historyLimit: Number(process.env.HISTORY_LIMIT || 500),
  myNodeId: process.env.MY_NODE_ID || '',
  myName: process.env.MY_NAME || '',
  sessionDays: Number(process.env.SESSION_DAYS || 30),
};

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const { createPush } = require('./push');
const i18n = require('./i18n');
const push = createPush({
  secret: cfg.secret,
  contact: process.env.PUSH_CONTACT || 'mailto:meshlink-chat@example.invalid',
  stateDir: process.env.STATE_DIRECTORY || null, // von systemd (StateDirectory=meshlink-chat)
});
const BROADCAST = new Set(['!ffffffff', 'ffffffff', '4294967295', '^all', 'broadcast', 'all']);

// ---------------------------------------------------------------- Upstream (MeshMonitor)

async function mm(p, { method = 'GET', body, raw = false, timeout = 15000 } = {}) {
  const res = await fetch(cfg.mmUrl + (raw ? '' : '/api/v1') + p, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.mmToken}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 2000) }; }
  if (!res.ok) {
    const e = json?.error;
    const err = new Error((typeof e === 'object' ? e?.message || e?.code : e) || json?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = typeof e === 'object' ? e?.code : json?.code;
    err.body = json;
    throw err;
  }
  return json;
}

const unwrap = (j) => (j && typeof j === 'object' && !Array.isArray(j) && 'data' in j ? j.data : j);

function asArray(j, ...keys) {
  const d = unwrap(j);
  if (Array.isArray(d)) return d;
  for (const k of keys) {
    if (Array.isArray(d?.[k])) return d[k];
    if (Array.isArray(j?.[k])) return j[k];
  }
  return [];
}

function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string' && !/^\d+(\.\d+)?$/.test(v)) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

const str = (v) => (v == null ? '' : String(v));

// ---------------------------------------------------------------- Normalisierung
// Einzige Stelle, die das MeshMonitor-Datenformat kennt. Bei Abweichungen hier anpassen.

// Koordinaten: Grad, oder Meshtastic-Ganzzahl (×1e7); 0/ungültig = keine Position
function geo(v, max) {
  let x = Number(v);
  if (v == null || v === '' || !Number.isFinite(x) || x === 0) return null;
  if (Math.abs(x) > 1000) x /= 1e7;
  return Math.abs(x) <= max ? Math.round(x * 1e5) / 1e5 : null;
}

function normNode(n) {
  const id = str(n.nodeId ?? n.id ?? n.user?.id ?? (n.publicKey ? `mc:${n.publicKey}` : ''));
  return {
    id,
    num: n.nodeNum ?? n.num ?? null,
    long: str(n.longName ?? n.user?.longName ?? n.name ?? n.advName),
    short: str(n.shortName ?? n.user?.shortName),
    lastHeard: toMs(n.lastHeard ?? n.lastSeen ?? n.lastAdvert ?? n.updatedAt),
    hops: n.hopsAway ?? null,
    snr: n.snr ?? null,
    local: Boolean(n.isLocal ?? n.isLocalNode ?? n.isMe ?? false),
    fav: Boolean(n.isFavorite ?? n.favorite ?? false),
    // MeshCore advType: 1 Companion, 2 Repeater, 3 Room-Server, 4 Sensor
    type: n.advType ?? null,
    lat: geo(n.latitude ?? n.lat ?? n.position?.latitude ?? n.latitudeI ?? n.position?.latitudeI, 90),
    lon: geo(n.longitude ?? n.lon ?? n.lng ?? n.position?.longitude ?? n.longitudeI ?? n.position?.longitudeI, 180),
  };
}

function normChannel(c, i) {
  const index = Number(c.index ?? c.channelIndex ?? c.slot ?? c.id ?? i);
  const role = c.role;
  if (role === 0 || role === 'DISABLED' || c.enabled === false) return null;
  return { index, name: str(c.displayName ?? c.name), scope: c.scope || null }; // ohne Namen: die App zeigt „Primär“/„Kanal n“ in ihrer Sprache
}

function deliveryState(m) {
  const s = m.deliveryState ?? m.delivery_state ?? m.status;
  if (typeof s === 'string' && s) return s.toLowerCase();
  if (m.delivered === true || m.deliveredAt) return 'delivered';
  if (m.delivered === false && /^sent-/.test(str(m.id))) return 'sent';
  if (m.ackFailed || m.routingErrorReceived) return 'failed';
  if (m.acknowledged || m.ackReceived || m.ack === true) return 'delivered';
  if (m.wantAck) return 'pending';
  return null;
}

function normMsg(m) {
  const id = str(m.id ?? m.messageId ?? m.uuid);
  let packetId = m.packetId ?? m.meshPacketId ?? m.requestId ?? null;
  if (packetId == null && /^\d+[-_]\d+$/.test(id)) packetId = Number(id.split(/[-_]/)[1]);
  const pk = m.fromPublicKey ?? m.senderPublicKey;
  // MeshCore-Kanalnachrichten tragen nur den Namen des Absenders
  const from = str(m.fromNodeId ?? m.from ?? m.senderId ?? (pk ? `mc:${pk}` : m.fromName ? `name:${m.fromName}` : ''));
  const toRaw = m.toNodeId ?? m.to ?? null;
  const channel = m.channel ?? m.channelIndex ?? null;
  const dm = Number(channel) === -1 || (toRaw != null && toRaw !== '' && !BROADCAST.has(str(toRaw).toLowerCase()));
  const text = str(m.text ?? m.message ?? m.content);
  const emojiField = m.emoji ?? m.isEmoji ?? m.reaction ?? null;
  const reaction = emojiField != null && emojiField !== 0 && emojiField !== '0' && emojiField !== false && emojiField !== '';
  const emojiChar = typeof emojiField === 'string' && !/^\d+$/.test(emojiField) ? emojiField : text;
  const hopStart = m.hopStart ?? null;
  const hopLimit = m.hopLimit ?? null;
  return {
    id,
    packetId: packetId == null ? null : String(packetId),
    from,
    name: m.fromName ?? m.senderName ?? null,
    to: toRaw == null ? null : str(toRaw),
    channel: channel == null ? null : Number(channel),
    dm,
    text,
    ts: toMs(m.createdAt ?? m.rxTime ?? m.timestamp ?? m.receivedAt) ?? Date.now(),
    replyId: m.replyId ?? m.reply_id ?? null,
    reaction,
    emoji: reaction ? emojiChar : null,
    state: deliveryState(m),
    hops: hopStart != null && hopLimit != null ? hopStart - hopLimit : m.hopCount ?? m.hops ?? m.pathLen ?? null,
    snr: m.rxSnr ?? m.snr ?? null,
    rssi: m.rxRssi ?? m.rssi ?? null,
    // MeshCore: Repeater-Hashes, über die die Nachricht kam ("a3,7f,02"); 0xff = feste Route
    path: parsePath(m.routePath),
    direct: m.pathLen === 255 || m.pathLen === 0xff,
  };
}

function parsePath(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!list) return null;
  const hops = list.map((x) => str(x).trim().toLowerCase()).filter((x) => /^[0-9a-f]{2,16}$/.test(x));
  return hops.length ? hops.slice(0, 64) : null;
}

function findMyNode(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return '';
  for (const k of ['localNodeId', 'myNodeId', 'ownNodeId']) if (obj[k]) return str(obj[k]);
  for (const k of ['localNode', 'localNodeInfo', 'myNode', 'myNodeInfo', 'self', 'node']) {
    const o = obj[k];
    if (o && typeof o === 'object') {
      if (o.nodeId) return str(o.nodeId);
      if (o.publicKey) return `mc:${o.publicKey}`;
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const r = findMyNode(v, depth + 1);
      if (r) return r;
    }
  }
  return '';
}

// ---------------------------------------------------------------- Zustand & Polling

const state = {
  source: null, // {id, name, protocol}
  me: cfg.myNodeId,
  myNames: new Set(cfg.myName ? [cfg.myName] : []),
  otherSources: [], // weitere Quellen in MeshMonitor (nur zum Erkennen eigener Nodes)
  otherNames: new Set(),
  nodes: [],
  channels: [],
  msgs: new Map(), // id -> {msg, sig}
  connected: false,
  error: null,
  lastMeta: 0,
  lastFull: 0,
  newest: 0, // höchster createdAt (ms) der Quelle
  nodesSig: '',
  sources: [],
  activeSourceId: '', // zur Laufzeit gewählte Quelle (nur im Speicher; nach Neustart gilt MM_SOURCE bzw. primär)
  relays: [], // {pk, name, adv} für Repeater-Namen
  pkIndex: new Map(), // erste 12 Hex-Zeichen des Public Keys -> [volle Node-IDs]
  heard: new Map(), // msgId -> Map(hash -> {hash, name, snr, hops, count})
  dmHeard: new Map(), // msgId -> [{hash, name, snr, hops}] – eigene DMs, von MeshMonitor (heardBy, ab 4.17.3)
  dmRoute: new Map(), // msgId -> {hops, flood} – Weg einer zugestellten eigenen DM (Kontakt-Pfad nach dem ACK); null = schon versucht
  dmHeardDirty: new Set(),
  seenPackets: new Set(),
  lastPacketTs: 0,
  backfilled: new Set(),
  reactions: new Map(), // MeshCore: msgId -> {target, emoji} (aus /api/sources/…/meshcore/messages)
  scopes: new Map(), // MeshCore: msgId -> {name, code} – Scope/Region, mit der die Nachricht gesendet wurde
  delivery: new Map(), // MeshCore: msgId -> {state, rtt} – Zustellung eigener DMs (ACK vom Empfänger)
  pushReady: false, // erst nach dem ersten vollständigen Abruf pushen (kein Verlauf als "neu")
  visible: new Map(), // Push-Endpoint -> sichtbar bis (dieses Gerät hat die App gerade offen)
  read: new Map(), // Chat -> gelesen bis (ms); gleicht Handy und PC ab, nur im Speicher
};
const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

function setStatus(connected, error) {
  const changed = connected !== state.connected || (error || null) !== state.error;
  state.connected = connected;
  state.error = error || null;
  if (changed) broadcast('status', { connected, error: state.error });
}

async function resolveSource() {
  const list = asArray(await mm('/sources'), 'sources');
  if (!list.length) throw new Error('MeshMonitor: no sources');
  const wanted = state.activeSourceId || cfg.sourceId;
  const pick = (wanted && list.find((s) => str(s.id) === wanted)) || list.find((s) => s.isPrimary) || list[0];
  state.sources = list.filter((s) => s.enabled !== false).map((s) => ({
    id: str(s.id), name: str(s.name || s.id), primary: Boolean(s.isPrimary),
    protocol: str(s.type ?? s.protocol).toLowerCase().includes('meshcore') ? 'meshcore' : 'meshtastic',
  }));
  const type = str(pick.type ?? pick.protocol).toLowerCase();
  state.otherSources = list.filter((s) => s !== pick && s.enabled !== false).map((s) => ({ id: str(s.id), name: str(s.name || s.id) }));
  state.source = {
    id: str(pick.id),
    name: str(pick.name || pick.id),
    protocol: type.includes('meshcore') ? 'meshcore' : 'meshtastic',
  };
}

const sp = () => `/sources/${encodeURIComponent(state.source.id)}`;
const mcPath = () => `/api/sources/${encodeURIComponent(state.source.id)}/meshcore`; // MeshCore-Teil (raw: true)

// MeshMonitor-Version (für die Nachrichtenlängen); /api/health nennt sie nur angemeldeten Aufrufern, also mit Token.
// Selten abfragen (alle 30 Min.); schlägt es fehl, bleibt die bisherige bzw. unbekannte Version.
async function refreshMmVersion() {
  if (Date.now() - (state.mmVersionAt || 0) < 30 * 60000) return;
  state.mmVersionAt = Date.now();
  try {
    const v = str((await mm('/api/health', { raw: true, timeout: 5000 }))?.version).slice(0, 40);
    if (v) state.mmVersion = v;
  } catch { /* egal: dann gelten die alten, strengeren Grenzen */ }
}
const verAtLeast = (v, want) => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(str(v));
  if (!m) return false;
  for (let i = 0; i < 3; i++) if (Number(m[i + 1]) !== want[i]) return Number(m[i + 1]) > want[i];
  return true;
};
// Höchstlänge einer Nachricht in Bytes. MeshCore ab MeshMonitor 4.17.3 wie die Firmware: DM 160,
// Kanal 160 − Länge des eigenen Node-Namens − 2 (die Firmware stellt "Name: " davor). Ältere Versionen
// prüfen strenger (150 / 130 / mit Scope 120). MeshMonitor teilt dabei nichts – zu lang wird abgelehnt.
function msgCaps() {
  if (state.source?.protocol !== 'meshcore') return { dm: 200, channel: 200, scoped: 200 };
  if (!verAtLeast(state.mmVersion, [4, 17, 3])) return { dm: 150, channel: 130, scoped: 120 };
  // Name: Node-Name und der aus gesendeten Nachrichten gelernte Absendername – der längste zählt (sicher)
  const meNode = nodeById(state.me) || state.nodes.find((n) => n.local);
  const names = [str(meNode?.long), ...state.myNames].filter(Boolean);
  const nb = names.length ? Math.min(Math.max(...names.map((x) => Buffer.byteLength(x))), 31) : 31;
  const ch = 160 - nb - 2;
  return { dm: 160, channel: ch, scoped: ch };
}

async function refreshMeta() {
  const [nodes, channels, status] = await Promise.allSettled([
    mm(`${sp()}/nodes`),
    mm(`${sp()}/channels`),
    mm(`${sp()}/status`),
    refreshMmVersion(),
  ]);
  if (nodes.status === 'fulfilled') {
    const rawNodes = asArray(nodes.value, 'nodes');
    state.nodes = rawNodes.map(normNode).filter((n) => n.id);
    state.pkIndex = new Map();
    for (const n of state.nodes) {
      const m = /^mc:([0-9a-f]{12})/i.exec(n.id);
      if (!m) continue;
      const k = m[1].toLowerCase();
      if (!state.pkIndex.has(k)) state.pkIndex.set(k, []);
      state.pkIndex.get(k).push(n.id);
    }
    state.relays = rawNodes.filter((n) => n.publicKey).map((n) => ({ pk: str(n.publicKey).toLowerCase(), name: str(n.longName || n.shortName), adv: n.advType ?? null }));
  }
  if (channels.status === 'fulfilled') {
    state.channels = asArray(channels.value, 'channels').map(normChannel).filter(Boolean)
      .filter((c, i, a) => a.findIndex((x) => x.index === c.index) === i)
      .sort((a, b) => a.index - b.index);
  }
  if (!cfg.myNodeId) {
    const local = state.nodes.find((n) => n.local);
    const fromStatus = status.status === 'fulfilled' ? findMyNode(unwrap(status.value)) : '';
    state.me = fromStatus || local?.id || state.me;
  }
  // Eigene Position: In der v1-Knotenliste fehlt sie beim eigenen Node manchmal; die Kontaktliste von MeshMonitor
  // führt den eigenen Node mit der Position aus dem Companion (Geräteeinstellung). Dann diese nehmen.
  if (state.source.protocol === 'meshcore') {
    const meNode = nodeById(state.me) || state.nodes.find((n) => n.local);
    const pk = pkOf(meNode?.id);
    if (meNode && pk && (meNode.lat == null || meNode.lon == null)) {
      try {
        const c = await companionContact(pk);
        const lat = geo(c?.latitude ?? c?.lat, 90); const lon = geo(c?.longitude ?? c?.lon, 180);
        if (lat != null && lon != null) { meNode.lat = lat; meNode.lon = lon; meNode.posFrom = 'device'; }
      } catch { /* Kontaktliste nicht lesbar: ohne eigene Position weiter */ }
    }
  }
  // Protokoll aus Antworten übernehmen, falls vorhanden
  const proto = unwrap(nodes.value ?? {})?.[0]?.protocol;
  if (proto === 'meshcore' || proto === 'meshtastic') state.source.protocol = proto;
  for (const o of state.otherSources) {
    try {
      const list = asArray(await mm(`/sources/${encodeURIComponent(o.id)}/messages?limit=200`), 'messages');
      for (const raw of list) if (raw.fromName && /^sent-/.test(str(raw.id))) state.otherNames.add(str(raw.fromName));
    } catch { /* Quelle evtl. offline */ }
  }
  for (const n of state.myNames) state.otherNames.delete(n);
  state.lastMeta = Date.now();
  const sig = crypto.createHash('sha1').update(JSON.stringify([state.me, state.mmVersion, posOf(nodeById(state.me)), state.channels, [...state.otherNames], state.nodes.map((n) => [n.id, n.long, n.short, n.fav])])).digest('hex');
  if (sig !== state.nodesSig) {
    state.nodesSig = sig;
    broadcast('meta', metaPayload());
  }
}

function metaPayload() {
  const mp = posOf(nodeById(state.me) || state.nodes.find((n) => n.local));
  return { version: VERSION, appVersion: APP_VERSION, mmVersion: state.mmVersion || null, caps: msgCaps(), mePos: mp, sources: state.sources, source: state.source, me: state.me, myNames: [...state.myNames], otherNames: [...state.otherNames], otherSources: state.otherSources, nodes: state.nodes.map(({ lat, lon, ...n }) => n), channels: state.channels };
}

// Rohe Nachricht von MeshMonitor -> Nachricht für die App (eigene erkannt, Weg, Reaktion, Scope).
// null = nicht anzeigbar (keine ID oder nicht entschlüsselter Kanal)
function buildMsg(raw) {
  const m = normMsg(raw);
  if (!m.id) return null;
  m.from = canonId(m.from);
  if (m.to) m.to = canonId(m.to);
  m.mine = Boolean((state.me && m.from === state.me) || /^sent-/.test(m.id) || (m.name && state.myNames.has(m.name)));
  m.ownOther = !m.mine && Boolean(m.name && state.otherNames.has(m.name));
  m.heard = m.dm ? state.dmHeard.get(m.id) || [] : heardFor(m.id);
  m.route = routeOf(m);
  const rx = state.reactions.get(m.id);
  if (rx) { m.reaction = true; m.emoji = rx.emoji; m.replyId = rx.target; }
  m.scope = state.scopes.get(m.id) || null;
  applyDelivery(m);
  if (m.mine && m.dm) m.outRoute = state.dmRoute.get(m.id) || null;
  delete m.path; delete m.direct;
  if (!m.dm && m.channel != null && (m.channel < 0 || m.channel > 255)) return null;
  return m;
}

// Nach einem Dienst-Neustart: DMs/Erwähnungen der letzten 3 Minuten nachmelden (sonst gingen sie unter).
const BOOT_TS = Date.now();
const CATCH_UP_MS = 180000;
let catchUp = true;

async function pollMessages() {
  // Alle 5 Min. bzw. beim Start komplett, sonst nur Neues seit dem letzten Stand (-2 Min. Puffer)
  const full = !state.newest || Date.now() - state.lastFull > 300000;
  let q = `limit=${cfg.historyLimit}`;
  if (!full) {
    const since = state.newest - 120000;
    q = `limit=1000&since=${state.source.protocol === 'meshcore' ? since : Math.floor(since / 1000)}`;
  }
  const j = await mm(`${sp()}/messages?${q}`);
  if (full) state.lastFull = Date.now();
  const changed = [];
  const rawList = asArray(j, 'messages');
  // Eigenen Absendernamen lernen (aus Nachrichten, die sicher von uns stammen)
  for (const raw of rawList) {
    if (raw.fromName && ((state.me && raw.fromNodeId === state.me) || /^sent-/.test(str(raw.id)))) state.myNames.add(str(raw.fromName));
  }
  // v1 liefert weder die Zuordnung von Reaktionen noch den Scope einer Nachricht. Beides steht im
  // MeshCore-Teil der API; er wird nur abgerufen, wenn wirklich neue Nachrichten da sind.
  if (state.source.protocol === 'meshcore') {
    const need = full || pendingDms().length || recentOwnDms() || rawList.some((r) => !state.msgs.has(str(r.id)) && !state.scopes.has(str(r.id)));
    if (need) await fetchReactions(full).catch((e) => console.error('[react]', e.status || '', e.message));
  }
  for (const raw of rawList) {
    const created = toMs(raw.createdAt ?? raw.rxTime ?? raw.timestamp);
    if (created && created > state.newest && created < Date.now() + 60000) state.newest = created;
    const m = buildMsg(raw);
    if (!m) continue;
    const sig = JSON.stringify(m);
    const prev = state.msgs.get(m.id);
    if (!prev || prev.sig !== sig) {
      state.msgs.set(m.id, { msg: m, sig });
      changed.push(m);
      if (!prev && (state.pushReady || (catchUp && m.ts > BOOT_TS - CATCH_UP_MS))) maybePush(m);
    }
  }
  // ACK zu einer schon bekannten DM eingetroffen (die Nachricht selbst kommt im Teilabruf nicht noch einmal)
  const seenNow = new Set(changed.map((m) => m.id));
  for (const e of state.msgs.values()) {
    if (seenNow.has(e.msg.id) || !e.msg.mine || !e.msg.dm) continue;
    let upd = applyDelivery(e.msg);
    if (state.dmHeardDirty.has(e.msg.id)) { e.msg.heard = state.dmHeard.get(e.msg.id) || []; upd = true; }
    if (upd) { e.sig = JSON.stringify(e.msg); changed.push(e.msg); }
  }
  state.dmHeardDirty.clear();
  // Speicher begrenzen
  if (state.msgs.size > cfg.historyLimit * 3) {
    const sorted = [...state.msgs.values()].sort((a, b) => a.msg.ts - b.msg.ts);
    for (const e of sorted.slice(0, state.msgs.size - cfg.historyLimit * 2)) state.msgs.delete(e.msg.id);
  }
  for (const id of state.heard.keys()) if (!state.msgs.has(id)) state.heard.delete(id);
  if (state.dmHeard.size > 500) for (const id of state.dmHeard.keys()) if (!state.msgs.has(id)) state.dmHeard.delete(id);
  if (state.dmRoute.size > 500) for (const id of state.dmRoute.keys()) if (!state.msgs.has(id)) state.dmRoute.delete(id);
  if (state.source.protocol === 'meshcore') scheduleDmRoutes();
  if (state.reactions.size > 3000) for (const id of state.reactions.keys()) if (!state.msgs.has(id)) state.reactions.delete(id);
  if (state.scopes.size > 3000) for (const id of state.scopes.keys()) if (!state.msgs.has(id)) state.scopes.delete(id);
  if (state.delivery.size > 3000) for (const id of state.delivery.keys()) if (!state.msgs.has(id)) state.delivery.delete(id);
  for (const id of state.backfilled) if (!state.msgs.has(id)) state.backfilled.delete(id);
  if (changed.length) broadcast('messages', changed);
}

// ---------------------------------------------------------------- Repeater-Echos ("gehört von")
// Eine gesendete Kanalnachricht wird von Repeatern weitergesendet; unser Node hört diese Kopien.
// MeshMonitor protokolliert sie entschlüsselt im Paket-Log (GRP_TXT + plaintext + path_hops).

const ECHO_WINDOW_MS = 60000;

function nameForHash(h) {
  const rel = state.relays.filter((r) => r.pk.startsWith(h));
  const pref = rel.filter((r) => r.adv === 2 || r.adv === 3 || r.adv == null);
  const pick = pref.length === 1 ? pref[0] : rel.length === 1 ? rel[0] : null;
  return pick ? pick.name || null : null;
}

// ---------------------------------------------------------------- Node-Hilfen (Karte, Status, Traceroute)

// Kontakt des Companions (mit gespeichertem Pfad). MeshMonitor hat keinen Einzelabruf, nur die Liste
// GET /contacts – bei einem Companion sind das genau die Kontakte auf dem Gerät. 10 s gemerkt (fresh = neu holen).
let contactCache = { key: '', at: 0, list: [] };
async function companionContact(pk, fresh = false) {
  if (fresh || contactCache.key !== state.source.id || Date.now() - contactCache.at > 10000) {
    const list = asArray(await mm(`${mcPath()}/contacts`, { raw: true, timeout: 20000 }), 'contacts');
    contactCache = { key: state.source.id, at: Date.now(), list };
  }
  return contactCache.list.find((c) => str(c.publicKey).toLowerCase() === pk) || null;
}

// Weg einer zugestellten eigenen DM: Mit dem ACK schickt der Empfänger den Weg zurück, den die Nachricht
// genommen hat; das Gerät speichert ihn als Pfad des Kontakts (MeshMonitor liest ihn ~1,5 s später neu ein).
// Diesen Pfad einmal je DM kurz nach der Zustellung abholen und an der Nachricht merken (nur im Speicher).
const DM_ROUTE_DELAY_MS = 4000;
const DM_ROUTE_MAX_AGE_MS = 15 * 60000;
function scheduleDmRoutes() {
  for (const { msg: m } of state.msgs.values()) {
    if (!m.mine || !m.dm || m.state !== 'delivered' || state.dmRoute.has(m.id) || Date.now() - m.ts > DM_ROUTE_MAX_AGE_MS) continue;
    const pk = pkOf(m.to);
    if (!pk) continue;
    state.dmRoute.set(m.id, null);
    const src = state.source.id;
    setTimeout(() => fetchDmRoute(m.id, pk, src).catch((e) => console.error('[dm-weg]', e.status || '', e.message)), DM_ROUTE_DELAY_MS);
  }
}
async function fetchDmRoute(id, pk, src) {
  if (state.source?.id !== src || !state.msgs.has(id)) return;
  const c = await companionContact(pk, Date.now() - contactCache.at > 3000);
  if (!c) return;
  const len = c.pathLen ?? c.path_len ?? c.outPathLen ?? null;
  const hops = parsePath(c.outPath ?? c.out_path) || [];
  const flood = !hops.length && (len == null || Number(len) < 0 || Number(len) === 255);
  const route = { hops: hops.map((h) => ({ hash: h, name: nameForHash(h) })), flood, bytes: hops.length ? Math.max(...hops.map((h) => h.length)) / 2 : null };
  state.dmRoute.set(id, route);
  const e = state.msgs.get(id);
  if (!e) return;
  e.msg.outRoute = route;
  e.sig = JSON.stringify(e.msg);
  broadcast('messages', [e.msg]);
}

let customTraceBusy = false; // immer nur eine eigene Traceroute gleichzeitig (sie ändert kurz einen Kontakt-Pfad)
const pkOf = (id) => { const m = /^(?:mc:)?([0-9a-f]{64})$/i.exec(str(id)); return m ? m[1].toLowerCase() : null; };
function nodeById(id) {
  const k = str(id).toLowerCase();
  return state.nodes.find((n) => n.id.toLowerCase() === k) || null;
}
// Repeater-Hash (Schlüssel-Präfix) -> Node, nur wenn eindeutig (Repeater/Rooms bevorzugt)
// Ein MeshCore-Trace aus der v1-API (ab 4.17.3 als ganze Runde): Zeile i = "Hop i hat seinen Vorgänger gehört",
// die letzte Zeile = "dein Funkgerät hat den letzten Hop gehört". Mit Rückweg (Palindrom a3,7f,ZIEL,7f,a3) wird
// in der Mitte geteilt: angezeigt wird nur der Hinweg, je Strecke SNR hin (snr) und zurück (back).
// null = gehört nicht zu diesem Node.
function traceView(t, pk) {
  const ts = toMs(t.timestamp);
  const rows = (Array.isArray(t.hops) ? t.hops : []).slice().sort((a, c) => (a.index ?? 0) - (c.index ?? 0));
  if (!ts || !rows.length) return null;
  const mePk = pkOf(state.me);
  const hashOf = (h) => str(h.hash || (h.publicKey || '').slice(0, 2)).toLowerCase();
  const isMe = (h) => Boolean(mePk && ((h.publicKey && str(h.publicKey).toLowerCase() === mePk) || (!h.publicKey && hashOf(h) && mePk.startsWith(hashOf(h)))));
  const back = rows.length > 1 && isMe(rows[rows.length - 1]); // Rückkehr zu dir aufgezeichnet
  const path = back ? rows.slice(0, -1) : rows;
  const n = path.length;
  const pal = n >= 3 && n % 2 === 1 && path.every((h, i) => hashOf(h) && hashOf(h) === hashOf(path[n - 1 - i]));
  const out = pal ? path.slice(0, (n + 1) / 2) : path;
  // Ziel: MeshMonitors toNodeId (= Wendepunkt) oder – falls unaufgelöst – der letzte Hop des Hinwegs
  const last = out[out.length - 1];
  const target = pkOf(t.toNodeId) || (last.publicKey ? str(last.publicKey).toLowerCase() : null);
  if (target ? target !== pk : !hashOf(last) || !pk.startsWith(hashOf(last))) return null;
  return {
    ts,
    hops: out.map((h, i) => {
      const nd = (h.publicKey && nodeById(`mc:${str(h.publicKey).toLowerCase()}`)) || nodeForHash(hashOf(h));
      const b = pal && back ? rows[n - i]?.snr : null;
      return { hash: hashOf(h), id: nd?.id || null, name: nd ? nd.long || nd.short : null, snr: h.snr ?? null, back: b ?? null };
    }),
  };
}

function nodeForHash(h) {
  const k = str(h).toLowerCase();
  if (!k) return null;
  const c = state.nodes.filter((n) => n.id.startsWith('mc:') && n.id.slice(3).toLowerCase().startsWith(k));
  const pref = c.filter((n) => n.type === 2 || n.type === 3);
  return pref.length === 1 ? pref[0] : c.length === 1 ? c[0] : null;
}
function nodeByName(name) {
  if (!name) return null;
  const c = state.nodes.filter((n) => n.long === name);
  return c.length === 1 ? c[0] : null;
}
const posOf = (n) => (n && n.lat != null && n.lon != null ? [n.lat, n.lon] : null);

const mmErrT = i18n.translator(i18n.DEFAULT);
function mmError(res, e, T = mmErrT) {
  console.error('[mm]', e.status || '', e.code || '', e.message);
  const status = e.status === 401 ? 502 : e.status && e.status < 500 ? e.status : 502; // 401 hieße für die App „abgemeldet“
  return send(res, status, { error: e.status === 401 ? T('srv.tokenRejected') : e.message, code: e.code || null, retryAfter: e.body?.retryAfter ?? e.body?.retryAfterSeconds ?? null });
}

// Verbindungen für die Karte: aus den Wegen empfangener Nachrichten (beobachtet) und
// den direkt gehörten Nachbarn des eigenen Nodes (MeshMonitor). Wird je Aufruf berechnet.
async function mapLinks(days) {
  const since = Date.now() - days * 86400000;
  const byId = new Map(state.nodes.map((n) => [n.id.toLowerCase(), n]));
  const id = (x) => byId.get(str(x).toLowerCase()) || null;
  const memo = new Map();
  const hash = (h) => { if (!memo.has(h)) memo.set(h, nodeForHash(h)); return memo.get(h); };
  const me = id(state.me);
  const links = new Map();
  const add = (a, b, kind, snr = null) => {
    if (!a || !b || a === b || !posOf(a) || !posOf(b)) return;
    const k = `${kind}|${[a.id, b.id].sort().join('|')}`;
    const l = links.get(k) || { kind, a: posOf(a), b: posOf(b), an: a.long || a.short, bn: b.long || b.short, n: 0, snr: null };
    l.n++;
    if (snr != null) l.snr = l.snr == null ? Number(snr) : Math.max(l.snr, Number(snr));
    links.set(k, l);
  };
  for (const { msg: m } of state.msgs.values()) {
    if (m.mine || m.ts < since || !m.route?.hops?.length) continue;
    const seq = [m.dm ? id(m.from) : nodeByName(m.name), ...m.route.hops.map((h) => hash(h.hash)), me];
    for (let i = 0; i < seq.length - 1; i++) add(seq[i], seq[i + 1], 'seen');
  }
  if (state.source?.protocol === 'meshcore') {
    try {
      const items = asArray(unwrap(await mm(`/api/sources/${encodeURIComponent(state.source.id)}/meshcore/neighbors?since=${since}`, { raw: true })), 'items');
      for (const it of Array.isArray(items) ? items.slice(0, 5000) : []) add(id(`mc:${it.publicKey}`), id(`mc:${it.neighborPublicKey}`), 'nb', it.snr);
    } catch (e) { if (e.status !== 403) console.error('[map] Nachbar-Tabellen:', e.status || '', e.message); }
  }
  if (me && state.source?.protocol === 'meshcore') {
    try {
      const d = unwrap(await mm(`${sp()}/network/direct-neighbors?hours=${days * 24}`)) || {};
      for (const v of Object.values(d)) {
        if (v?.publicKey && (toMs(v.lastHeard) || 0) >= since) add(me, id(`mc:${v.publicKey}`), 'direct', v.bestSnr);
      }
    } catch (e) { if (e.status !== 403) console.error('[map] Nachbarn:', e.status || '', e.message); }
  }
  return [...links.values()].slice(0, 2000);
}

// ---------------------------------------------------------------- Paketverkehr eines Repeaters
// Quelle sind die eigenen Zähler des Repeaters aus seiner Status-Telemetrie (packets_recv / packets_sent, seit dem
// Gerätestart). Die Differenz zweier Messungen = Pakete dazwischen; nichts wird aus dem eigenen Empfang geschätzt.
// - Neustart (Zähler kleiner oder Laufzeit kürzer als der Abstand zur letzten Messung): ab dann zählt der neue Stand;
//   was zwischen letzter Messung und Neustart lag, fehlt -> Ergebnis ist ein Mindestwert ("lower").
// - Zwischen zwei Messungen wird gleichmäßig verteilt, aber nur bei höchstens 3 Std. Abstand; über größere Lücken
//   (oder einen Neustart) hinweg gibt es für einen Zeitpunkt keinen Wert -> der Zeitraum bleibt leer statt geraten.
const TRAFFIC_GAP = 3 * 3600000;
function trafficSeries(points, uptime) {
  const s = [];
  let c = 0;
  for (let i = 0; i < points.length; i++) {
    const [t, v] = points[i];
    if (!i) { s.push({ t, c: 0, reset: false, gap: false }); continue; }
    const [pt, pv] = points[i - 1];
    if (t <= pt) continue;
    const up = uptime.get(t);
    const reset = v < pv || (up != null && up * 1000 < t - pt - 60000);
    c += reset ? v : v - pv;
    s.push({ t, c, reset, gap: t - pt > TRAFFIC_GAP });
  }
  return s;
}
// Zählerstand zum Zeitpunkt t; null, wenn t nicht sicher abgedeckt ist (vor der ersten / nach der letzten Messung, in einer Lücke)
function trafficAt(s, t) {
  if (!s.length || t < s[0].t || t > s[s.length - 1].t) return null;
  let lo = 0; let hi = s.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (s[mid].t <= t) lo = mid; else hi = mid; }
  const a = s[lo]; const b = s[hi];
  if (t === a.t) return a.c;
  if (t === b.t) return b.c;
  if (b.gap || b.reset) return null;
  return a.c + ((b.c - a.c) * (t - a.t)) / (b.t - a.t);
}
function trafficDelta(s, t1, t2) {
  const a = trafficAt(s, t1); const b = trafficAt(s, t2);
  if (a == null || b == null) return null;
  return { n: Math.round(b - a), lower: s.some((x) => x.reset && x.t > t1 && x.t <= t2) };
}
// rows = Telemetrie-Zeilen; bounds = Tagesanfänge in der Zeitzone des Geräts (optional) -> Pakete je Tag
function repeaterTraffic(rows, bounds = []) {
  const pts = { recv: [], sent: [] };
  const uptime = new Map();
  for (const r of rows) {
    const type = str(r.telemetryType).replace(/^mc_/, '');
    const v = Number(r.value); const t = toMs(r.timestamp ?? r.createdAt);
    if (!Number.isFinite(v) || !t) continue;
    if (type === 'status_packets_recv') pts.recv.push([t, v]);
    else if (type === 'status_packets_sent') pts.sent.push([t, v]);
    else if (type === 'status_uptime_secs') uptime.set(t, v);
  }
  const now = Date.now();
  const out = {};
  for (const [k, list] of Object.entries(pts)) {
    if (list.length < 2) continue;
    list.sort((a, b) => a[0] - b[0]);
    const s = trafficSeries(list, uptime);
    const last = s[s.length - 1];
    // Aktuell pro Stunde: jüngster sauberer Abschnitt von mind. 5 Min. (mehrere Messungen dürfen zusammenkommen)
    let hour = null;
    if (now - last.t <= TRAFFIC_GAP) {
      for (let i = s.length - 2; i >= 0; i--) {
        if (s[i + 1].gap || s[i + 1].reset) break;
        const span = last.t - s[i].t;
        if (span >= 300000) { hour = { n: Math.round(((last.c - s[i].c) / span) * 3600000), span, at: last.t }; break; }
      }
    }
    const day = trafficDelta(s, last.t - 86400000, last.t);
    const days = bounds.map((b0, i) => {
      const end = Math.min(bounds[i + 1] ?? now, last.t);
      if (end <= b0) return null;
      const d = trafficDelta(s, b0, end);
      return d && { ...d, partial: end < (bounds[i + 1] ?? b0 + 86400000) };
    });
    out[k] = { hour, day: day && { ...day, at: last.t }, days, samples: s.length, first: s[0].t, last: last.t };
  }
  return Object.keys(out).length ? out : null;
}

// Telemetrie eines Nodes als Zeitreihen je Typ (auf ~240 Punkte verdichtet)
async function nodeTelemetry(pk, days, bounds = []) {
  const since = Date.now() - days * 86400000;
  // Für den Paketverkehr mind. 26 Std. und ab dem ersten Tagesanfang holen (der Verlauf zeigt trotzdem nur "days")
  const from = Math.min(since, Date.now() - 26 * 3600000, ...bounds);
  let rows = [];
  for (const id of [`mc:${pk}`, pk]) {
    try { rows = asArray(await mm(`${sp()}/telemetry/${encodeURIComponent(id)}?since=${from}&limit=5000`), 'telemetry'); } catch (e) { if (e.status === 403) throw e; rows = []; }
    if (rows.length) break;
  }
  const series = {};
  for (const r of rows) {
    const type = str(r.telemetryType).replace(/^mc_/, '');
    const v = Number(r.value);
    const t = toMs(r.timestamp ?? r.createdAt);
    if (!type || !Number.isFinite(v) || !t || t < since) continue;
    (series[type] ||= { unit: r.unit || null, points: [] }).points.push([t, v]);
  }
  for (const s of Object.values(series)) {
    s.points.sort((a, b) => a[0] - b[0]);
    if (s.points.length > 240) {
      const last = s.points[s.points.length - 1];
      const step = s.points.length / 240;
      s.points = Array.from({ length: 239 }, (_, i) => s.points[Math.floor(i * step)]).concat([last]);
    }
    s.last = s.points[s.points.length - 1];
  }
  return { series, traffic: repeaterTraffic(rows, bounds) };
}

// ---------------------------------------------------------------- Statistik (heute, gestern, 7 Tage)
// Wird bei jedem Aufruf aus MeshMonitor berechnet. Im Speicher liegen nur bis zu 3 Paket-Zählungen
// (laufender Zeitraum wird fortgeschrieben, abgeschlossene 10 Min. gemerkt) und das letzte Nachrichten-Ergebnis.

function distKm(a, b) {
  const rad = Math.PI / 180;
  const h = Math.sin(((b[0] - a[0]) * rad) / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(((b[1] - a[1]) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}
const bump = (map, k, n = 1) => { if (map.has(k) || map.size < 3000) map.set(k, (map.get(k) || 0) + n); };
const top = (map, n) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n);

// Zeitraum + Balken: from/to (ms) und die Startzeitpunkte der Balken (Stunden oder Tage, vom Gerät berechnet,
// damit Mitternacht und Sommerzeit zur Zeitzone des Geräts passen).
function bucketOf(starts, t) {
  let i = 0;
  while (i + 1 < starts.length && t >= starts[i + 1]) i++;
  return i;
}

function newPacketAcc(n) {
  return {
    total: 0, bytes: 0, perBucket: Array(n).fill(0), types: new Map(), routes: new Map(), hopHist: Array(9).fill(0),
    snrN: 0, snrSum: 0, snrMin: null, snrMax: null, rssiN: 0, rssiSum: 0,
    lastHop: new Map(), lastHopSnr: new Map(), relay: new Map(), adverts: 0, advertNodes: new Set(), senders: new Set(),
    farDirect: null, maxHops: null, oldest: null,
  };
}

function addPacket(a, p, t, starts, me) {
  a.total++;
  a.bytes += Number(p.payload_size) || 0;
  a.perBucket[bucketOf(starts, t)]++;
  if (a.oldest == null || t < a.oldest) a.oldest = t;
  const type = str(p.payload_type_name) || (p.payload_type != null ? `Typ ${p.payload_type}` : 'unbekannt');
  bump(a.types, type);
  if (p.route_type_name) bump(a.routes, str(p.route_type_name));
  const path = Array.isArray(p.path_hops) ? p.path_hops.map((x) => str(x).toLowerCase()).filter(Boolean) : [];
  const hops = path.length || Number(p.hop_count) || 0;
  a.hopHist[Math.min(8, hops)]++;
  const snr = p.snr == null ? null : Number(p.snr);
  if (Number.isFinite(snr)) {
    a.snrN++; a.snrSum += snr;
    a.snrMin = a.snrMin == null ? snr : Math.min(a.snrMin, snr);
    a.snrMax = a.snrMax == null ? snr : Math.max(a.snrMax, snr);
  }
  if (p.rssi != null && Number.isFinite(Number(p.rssi))) { a.rssiN++; a.rssiSum += Number(p.rssi); }
  for (const h of path) bump(a.relay, h);
  if (path.length) {
    const last = path[path.length - 1]; // der Repeater, den wir selbst gehört haben
    bump(a.lastHop, last);
    if (Number.isFinite(snr) && a.lastHop.has(last)) a.lastHopSnr.set(last, Math.max(a.lastHopSnr.get(last) ?? -99, snr));
  }
  const spk = str(p.sender_public_key).toLowerCase();
  if ((spk || p.src_hash) && a.senders.size < 5000) a.senders.add(spk || `#${p.src_hash}`);
  if (type === 'ADVERT') { a.adverts++; if (a.advertNodes.size < 5000) a.advertNodes.add(spk || str(p.advert_name)); }
  if (!a.maxHops || hops > a.maxHops.hops) a.maxHops = { hops, type, path: path.slice(0, 64) };
  // Weitester Direktempfang: ohne Repeater gehört und Absender mit bekannter Position
  if (!hops && spk && me) {
    const n = nodeById(`mc:${spk}`);
    const pos = posOf(n);
    if (pos && n.id !== state.me) {
      const km = distKm(me, pos);
      if (!a.farDirect || km > a.farDirect.km) a.farDirect = { id: n.id, name: n.long || n.short || spk.slice(0, 8), km, snr: Number.isFinite(snr) ? snr : null, type };
    }
  }
}

// Wie weit reicht das Paket-Log von MeshMonitor zurück? (ältestes vorhandenes Paket; 5 Min. gemerkt)
let logStart = { key: '', at: 0, ts: null };
async function packetLogStart() {
  if (logStart.key === state.source.id && Date.now() - logStart.at < 300000) return logStart.ts;
  const head = await mm(`${sp()}/packets?limit=1`);
  const total = Number(head?.total);
  let ts = null;
  if (Number.isFinite(total) && total > 0) {
    const last = asArray(await mm(`${sp()}/packets?limit=1&offset=${total - 1}`), 'packets')[0];
    ts = toMs(last?.timestamp);
  }
  logStart = { key: state.source.id, at: Date.now(), ts };
  return ts;
}

// Paket-Zählung. Läuft der Zeitraum bis jetzt, wird nur Neues nachgezählt; abgeschlossene Zeiträume werden
// einmal gezählt und 10 Min. gemerkt. Höchstens 3 Zählungen gleichzeitig im Speicher.
const PACKET_PAGES_MAX = 100; // 100.000 Pakete je Zählung
const packetAccs = new Map(); // key -> {acc, live, lastTs, recent: Map(id->ts), at, busy, truncated}

async function packetStats(from, to, starts) {
  const live = to >= Date.now() - 60000;
  const key = `${state.source.id}|${from}|${live ? 'live' : to}|${starts.join(',')}`;
  let e = packetAccs.get(key);
  if (e && !live && Date.now() - e.at > 600000) { packetAccs.delete(key); e = null; }
  if (!e) {
    e = { acc: newPacketAcc(starts.length), live, lastTs: 0, recent: new Map(), at: Date.now(), busy: null, truncated: false };
    packetAccs.set(key, e);
    while (packetAccs.size > 3) packetAccs.delete(packetAccs.keys().next().value);
  } else if (!live) return e;
  if (e.busy) { await e.busy; return e; }
  e.busy = (async () => {
    const me = posOf(nodeById(state.me));
    const first = !e.lastTs;
    let list;
    if (first) {
      // Neueste zuerst: Pakete nach dem Zeitraum überspringen (bei abgeschlossenen Zeiträumen)
      let skip = 0;
      if (!live) skip = Number((await mm(`${sp()}/packets?since=${to}&limit=1`))?.total) || 0;
      list = [];
      for (let page = 0, offset = skip; page < PACKET_PAGES_MAX; page++) {
        const j = await mm(`${sp()}/packets?since=${from}&limit=1000&offset=${offset}`);
        const arr = asArray(j, 'packets');
        list.push(...arr);
        offset += arr.length;
        if (arr.length < 1000 || (j.total != null && offset >= j.total)) break;
        if (page === PACKET_PAGES_MAX - 1) e.truncated = true;
      }
    } else {
      list = await fetchPackets(e.lastTs - 5000, 5);
    }
    for (const p of list) {
      const t = toMs(p.timestamp);
      if (!t || t < from || t >= to || p.id == null || e.recent.has(p.id)) continue;
      if (live) e.recent.set(p.id, t);
      if (t > e.lastTs && t < Date.now() + 60000) e.lastTs = t;
      addPacket(e.acc, p, t, starts, me);
    }
    if (!e.lastTs) e.lastTs = from + 1; // leer: beim nächsten Mal nur noch Neues
    // Doppelt-Schutz braucht nur die IDs am Rand des letzten Abrufs
    for (const [id, t] of e.recent) if (t < e.lastTs - 15000) e.recent.delete(id);
  })().finally(() => { e.busy = null; });
  await e.busy;
  return e;
}

// Nachrichten-Statistik: wird Seite für Seite zusammengezählt, damit auch ein voller Monat nie komplett im
// Speicher liegt. MeshCore: Kanäle über den Kanal-Endpunkt (blättert zurück, liefert Reaktionen und Scope),
// DMs über v1. Meshtastic bzw. ältere MeshMonitor-Versionen: v1 mit Obergrenze.
function newMsgAgg(starts) {
  return {
    total: 0, channel: 0, dm: 0, mine: 0, received: 0, mentions: 0, reactions: 0,
    perBucket: Array(starts.length).fill(0), truncated: false,
    chans: new Map(), senders: new Map(), emojis: new Map(), scopes: new Map(), hashBytes: new Map(), far: new Map(),
    hopSum: 0, hopN: 0, direct: 0, longest: null, longText: null, scopeKnown: 0,
  };
}

function addMsg(g, m, starts, me) {
  if (m.reaction) { g.reactions++; if (m.emoji) bump(g.emojis, m.emoji); return; }
  g.total++;
  g.perBucket[bucketOf(starts, m.ts)]++;
  if (m.dm) g.dm++; else { g.channel++; bump(g.chans, m.channel); }
  if (m.scope) g.scopeKnown++;
  if (m.scope?.name) bump(g.scopes, `🔒 ${m.scope.name}`);
  else if (m.scope?.code > 0) bump(g.scopes, `🔒 #${m.scope.code.toString(16)}`);
  else if (m.scope?.code === 0 && !m.dm) bump(g.scopes, '🌐 ohne Scope');
  if (m.mine) { g.mine++; return; }
  g.received++;
  if (m.ownOther) return;
  const who = m.name || senderName(m);
  bump(g.senders, who);
  if (!m.dm && [...state.myNames].some((n) => m.text.includes(`@[${n}]`))) g.mentions++;
  const hops = m.route ? m.route.hops.length : m.hops;
  if (hops != null && Number.isFinite(Number(hops))) { g.hopSum += Number(hops); g.hopN++; if (Number(hops) === 0) g.direct++; }
  if (m.route?.bytes) bump(g.hashBytes, m.route.bytes);
  if (m.route?.hops.length && (!g.longest || m.route.hops.length > g.longest.hops)) {
    g.longest = { name: who, ts: m.ts, hops: m.route.hops.length, path: m.route.hops.map((h) => h.name || `#${h.hash}`), points: [m.dm ? { id: m.from, label: who, tag: '✉' } : { name: m.name, label: who, tag: '✉' }, ...m.route.hops.map((h) => ({ hash: h.hash, label: h.name || `#${h.hash}` })), { me: true, label: 'Du' }] };
  }
  if (!g.longText || m.text.length > g.longText.len) g.longText = { name: who, len: m.text.length, bytes: Buffer.byteLength(m.text) };
  // Weitester Absender: Luftlinie zwischen meinem Node und dem Absender (wenn beide eine Position haben)
  const n = m.dm ? nodeById(m.from) : nodeByName(m.name);
  const pos = posOf(n);
  if (me && pos && !g.far.has(n.id) && g.far.size < 3000) g.far.set(n.id, { id: n.id, name: who, km: distKm(me, pos), hops: hops ?? null });
}

function finishMsgAgg(g, starts, reactionsKnown) {
  const busiest = g.perBucket.reduce((b, v, i) => (v > g.perBucket[b] ? i : b), 0);
  return {
    total: g.total, channel: g.channel, dm: g.dm, mine: g.mine, received: g.received, mentions: g.mentions,
    reactions: reactionsKnown ? g.reactions : null, perBucket: g.perBucket, truncated: g.truncated,
    senders: g.senders.size,
    channels: top(g.chans, 8).map(([index, n]) => ({ index, name: state.channels.find((c) => c.index === index)?.name || '', n })),
    topSenders: top(g.senders, 8).map(([name, n]) => ({ name, n })),
    emojis: reactionsKnown ? top(g.emojis, 8).map(([e, n]) => ({ e, n })) : [],
    scopes: top(g.scopes, 6).map(([label, n]) => ({ label, n })),
    scopesPartial: g.scopeKnown < g.total * 0.9,
    hashBytes: [1, 2, 3].map((b) => ({ bytes: b, n: g.hashBytes.get(b) || 0 })).filter((x) => x.n),
    hops: g.hopN ? { avg: g.hopSum / g.hopN, direct: g.direct, n: g.hopN } : null,
    busiest: g.total ? { start: starts[busiest], n: g.perBucket[busiest] } : null,
    farthest: [...g.far.values()].sort((a, b) => b.km - a.km).slice(0, 3),
    longest: g.longest, longText: g.longText, hasMyPos: Boolean(posOf(nodeById(state.me))),
  };
}

// Zeile des MeshCore-Kanal-Endpunkts (Manager-Format) -> Nachricht wie aus v1, inkl. Reaktion und Scope
function channelRowToMsg(r, idx) {
  const m = buildMsg({
    id: r.id, fromNodeId: null, fromPublicKey: null, fromName: r.fromName ?? null, toNodeId: '!ffffffff', text: r.text,
    channel: idx, timestamp: r.timestamp, createdAt: r.receivedAt ?? r.timestamp, hopCount: r.hopCount ?? null,
    routePath: r.routePath ?? null, rxSnr: r.snr ?? null, rxRssi: r.rssi ?? null,
  });
  if (!m) return null;
  if (r.reactionEmoji) { m.reaction = true; m.emoji = str(r.reactionEmoji); m.replyId = r.reactionTargetId ?? null; }
  const code = r.scopeCode == null ? null : Number(r.scopeCode);
  if (r.scopeName || code != null) m.scope = { name: str(r.scopeName).trim() || null, code: Number.isFinite(code) ? code : null };
  return m;
}

const CHANNEL_PAGE = 1000;
const CHANNEL_MAX_OFFSET = 50000; // Grenze von MeshMonitor
// Alle Nachrichten eines Kanals im Zeitraum, Seite für Seite (neueste zuerst). true = Grenze erreicht.
async function eachChannelMsg(idx, from, to, cb) {
  for (let offset = 0; ; offset += CHANNEL_PAGE) {
    if (offset > CHANNEL_MAX_OFFSET) return true;
    const j = await mm(`${mcPath()}/messages/channel/${idx}?limit=${CHANNEL_PAGE}&offset=${offset}`, { raw: true, timeout: 30000 });
    const rows = asArray(j, 'messages');
    let older = false;
    for (const r of rows) {
      const m = channelRowToMsg(r, idx);
      if (!m) continue;
      if (m.ts < from) { older = true; continue; }
      if (m.ts < to) cb(m);
    }
    if (older || !rows.length || j?.hasMore === false || rows.length < CHANNEL_PAGE) return false;
  }
}
// Jeden Kanal einzeln abarbeiten. MeshMonitor prüft die Leserechte je Kanal (channel_N): Kanäle ohne Recht
// werden übersprungen statt die ganze Abfrage abzubrechen. Rückgabe: Namen der übersprungenen Kanäle.
async function eachReadableChannel(fn) {
  const skipped = [];
  for (const c of state.channels) {
    try { await fn(c); } catch (e) {
      if (e.status === 403) { skipped.push(c.name || `#${c.index}`); continue; }
      throw e;
    }
  }
  if (skipped.length) console.log(`[kanäle] ohne Leserecht übersprungen: ${skipped.join(', ')}`);
  return skipped;
}
async function channelMessagesInto(g, idx, from, to, starts, me) {
  if (await eachChannelMsg(idx, from, to, (m) => addMsg(g, m, starts, me))) g.truncated = true;
}

// ---------------------------------------------------------------- Erwähnungen (@[Mein Name]) der letzten Tage
let mentionCache = { key: '', at: 0, data: null };
async function mentionsSince(days) {
  const from = Date.now() - days * 86400000;
  const names = [...state.myNames];
  const key = `${state.source.id}|${days}|${names.join(',')}`;
  if (mentionCache.key === key && Date.now() - mentionCache.at < 30000) return mentionCache.data;
  const hit = (m) => !m.mine && !m.ownOther && !m.reaction && !m.dm && names.some((n) => m.text.includes(`@[${n}]`));
  const found = new Map();
  let truncated = false;
  let skipped = [];
  if (names.length) {
    if (state.source.protocol === 'meshcore' && state.channels.length) {
      skipped = await eachReadableChannel(async (c) => {
        if (await eachChannelMsg(c.index, from, Date.now() + 60000, (m) => { if (hit(m) && found.size < 2000) found.set(m.id, m); })) truncated = true;
      });
    } else {
      const raw = asArray(await mm(`${sp()}/messages?limit=5000&since=${state.source.protocol === 'meshcore' ? from : Math.floor(from / 1000)}`, { timeout: 60000 }), 'messages');
      for (const r of raw) { const m = buildMsg(r); if (m && m.ts >= from && hit(m)) found.set(m.id, m); }
      truncated = raw.length >= 5000;
    }
  }
  for (const { msg } of state.msgs.values()) if (msg.ts >= from && hit(msg)) found.set(msg.id, msg); // ganz frische
  const list = [...found.values()].sort((a, b) => b.ts - a.ts).slice(0, 200);
  mentionCache = { key, at: Date.now(), data: { mentions: list, truncated, days, names, skipped } };
  return mentionCache.data;
}

// ---------------------------------------------------------------- Repeater-Zustand (Übersicht + Wächter)
// Favoriten-Repeater/Room-Server mit letztem Empfang und den neuesten Status-Werten aus MeshMonitor (2 Min. gemerkt)
let healthCache = { key: '', at: 0, data: null, busy: null };
const HEALTH_FIELDS = { battery: ['status_battery_volts', 'battery_volts'], noise: ['status_noise_floor'], uptime: ['status_uptime_secs'], snr: ['status_last_snr'], rssi: ['status_last_rssi'], recv: ['status_packets_recv'] };
async function latestStatus(pk) {
  const since = Date.now() - 2 * 86400000;
  let rows = [];
  for (const id of [`mc:${pk}`, pk]) {
    try { rows = asArray(await mm(`${sp()}/telemetry/${encodeURIComponent(id)}?since=${since}&limit=3000`), 'telemetry'); } catch (e) { if (e.status === 403) throw e; rows = []; }
    if (rows.length) break;
  }
  const out = { ts: null, traffic: repeaterTraffic(rows) };
  for (const r of rows) {
    const type = str(r.telemetryType).replace(/^mc_/, '');
    const v = Number(r.value); const t = toMs(r.timestamp ?? r.createdAt);
    if (!Number.isFinite(v) || !t) continue;
    for (const [k, types] of Object.entries(HEALTH_FIELDS)) {
      if (types.includes(type) && (!out[k] || t > out[k].t)) out[k] = { v, t };
    }
    if (!out.ts || t > out.ts) out.ts = t;
  }
  return out;
}
async function repeaterHealth() {
  const favs = state.nodes.filter((n) => n.fav && (n.type === 2 || n.type === 3) && pkOf(n.id));
  const key = `${state.source?.id}|${favs.map((n) => n.id).join(',')}`;
  if (healthCache.key === key && Date.now() - healthCache.at < (Number(process.env.HEALTH_TTL_MS) || 120000)) return healthCache.data;
  if (healthCache.busy) return healthCache.busy;
  healthCache.busy = (async () => {
    let forbidden = false;
    const list = [];
    for (const n of favs.slice(0, 40)) {
      let st = {};
      if (!forbidden) {
        try { st = await latestStatus(pkOf(n.id)); } catch (e) { if (e.status === 403) forbidden = true; }
      }
      list.push({ id: n.id, name: n.long || n.short || pkOf(n.id).slice(0, 8), type: n.type, lastHeard: n.lastHeard, hops: n.hops, snr: n.snr, status: st });
    }
    const data = { repeaters: list, telemetryForbidden: forbidden, generated: Date.now() };
    healthCache = { key, at: Date.now(), data, busy: null };
    return data;
  })().finally(() => { healthCache.busy = null; });
  return healthCache.busy;
}

// Wächter: Push, wenn ein Favoriten-Repeater zu lange still ist bzw. sein Akku unter die Schwelle fällt,
// und Entwarnung, wenn es wieder passt. Schwellen je Gerät (Push-Abo). Zustand nur im Speicher; die erste
// Prüfung nach dem Start meldet nichts (sonst käme nach jedem Neustart eine Flut für längst bekannte Ausfälle).
const watchState = new Map(); // "endpoint|nodeId|off|bat" -> true
let watchPrimed = false;
const fmtV = (T, v) => `${T.num(v, 2)} V`;
const fmtAgo = (T, ms) => { const h = ms / 3600000; return h < 1 ? T('srv.durMin', { n: Math.round(ms / 60000) }) : h < 48 ? T('srv.durHours', { n: Math.round(h) }) : T('srv.durDays', { n: Math.round(h / 24) }); };
// Texte für ein Push-Abo in dessen Sprache (gemerkt beim Einschalten von Push)
const pushT = new Map();
const tFor = (sub) => { const code = i18n.match(sub?.lang) || i18n.DEFAULT; if (!pushT.has(code)) pushT.set(code, i18n.translator(code)); return pushT.get(code); };
async function watchTick() {
  if (!state.source || state.source.protocol !== 'meshcore') return;
  const subs = push.list().filter((s) => s.watch.on);
  if (!subs.length) { watchPrimed = true; return; }
  const { repeaters } = await repeaterHealth();
  const now = Date.now();
  const live = new Set();
  for (const s of subs) {
    const T = tFor(s);
    for (const r of repeaters) {
      const conds = [
        ['off', Boolean(r.lastHeard) && now - r.lastHeard > s.watch.hours * 3600000,
          { title: T('srv.watchSilent', { name: r.name }), body: T('srv.watchSilentBody', { ago: fmtAgo(T, now - r.lastHeard), n: s.watch.hours }) },
          { title: T('srv.watchBack', { name: r.name }), body: T('srv.watchBackBody') }],
      ];
      const bat = r.status?.battery;
      if (s.watch.volts && bat && now - bat.t < 24 * 3600000) {
        const k = `${s.endpoint}|${r.id}|bat`;
        const low = bat.v < s.watch.volts || (watchState.has(k) && bat.v < s.watch.volts + 0.05); // kleiner Puffer gegen Flattern
        conds.push(['bat', low,
          { title: T('srv.batLow', { name: r.name }), body: T('srv.batLowBody', { v: fmtV(T, bat.v), limit: fmtV(T, s.watch.volts) }) },
          { title: T('srv.batOk', { name: r.name }), body: `${fmtV(T, bat.v)}.` }]);
      }
      for (const [kind, bad, alarm, clear] of conds) {
        const k = `${s.endpoint}|${r.id}|${kind}`;
        live.add(k);
        if (bad && !watchState.has(k)) {
          watchState.set(k, true);
          if (watchPrimed) console.log(`[watch] ${alarm.title} – ${alarm.body}`);
          if (watchPrimed) push.send({ ...alarm, tag: `watch:${r.id}:${kind}`, conv: null, ts: now }, (x) => x.endpoint !== s.endpoint).catch((e) => console.error('[watch]', e.message));
        } else if (!bad && watchState.has(k)) {
          watchState.delete(k);
          if (watchPrimed) console.log(`[watch] ${clear.title}`);
          if (watchPrimed) push.send({ ...clear, tag: `watch:${r.id}:${kind}`, conv: null, ts: now }, (x) => x.endpoint !== s.endpoint).catch((e) => console.error('[watch]', e.message));
        }
      }
    }
  }
  for (const k of watchState.keys()) if (!live.has(k)) watchState.delete(k); // Gerät/Favorit weg
  watchPrimed = true;
}

let msgStatCache = { key: '', at: 0, data: null };
async function messageStats(from, to, starts) {
  const live = to >= Date.now() - 60000;
  const key = `${state.source.id}|${from}|${live ? 'live' : to}|${starts.join(',')}`;
  if (msgStatCache.key === key && Date.now() - msgStatCache.at < (live ? 20000 : 600000)) return msgStatCache.data;
  const me = posOf(nodeById(state.me));
  const sinceQ = state.source.protocol === 'meshcore' ? from : Math.floor(from / 1000);
  let g = newMsgAgg(starts);
  let reactionsKnown = false;
  let paged = false;
  let skipped = [];
  if (state.source.protocol === 'meshcore' && state.channels.length) {
    try {
      skipped = await eachReadableChannel((c) => channelMessagesInto(g, c.index, from, to, starts, me));
      if (skipped.length === state.channels.length) throw Object.assign(new Error('kein Kanal lesbar'), { status: 403 });
      // DMs (Reaktionen auf DMs liefert v1 nicht – die sind selten); ohne DM-Leserecht ohne DMs weiter
      try {
        const dms = asArray(await mm(`${sp()}/messages?channel=-1&limit=20000&since=${sinceQ}`, { timeout: 60000 }), 'messages');
        if (dms.length >= 20000) g.truncated = true;
        for (const r of dms) { const m = buildMsg(r); if (m && m.ts >= from && m.ts < to) addMsg(g, m, starts, me); }
      } catch (e) { if (e.status === 403) skipped.push('Direktnachrichten'); else throw e; }
      paged = true;
      reactionsKnown = true;
    } catch (e) {
      if (e.status === 401) throw e;
      console.error('[stats] Kanal-Endpunkt nicht nutzbar, nehme v1:', e.status || '', e.message);
      g = newMsgAgg(starts);
      skipped = [];
    }
  }
  if (!paged) {
    const LIMIT = 20000;
    const raw = asArray(await mm(`${sp()}/messages?limit=${LIMIT}&since=${sinceQ}`, { timeout: 60000 }), 'messages');
    if (state.source.protocol === 'meshcore' && live && raw.some((r) => !state.msgs.has(str(r.id)) && !state.scopes.has(str(r.id)))) {
      await fetchReactions(false).catch(() => {});
    }
    const byId = new Map();
    for (const r of raw) { const m = buildMsg(r); if (m && m.ts >= from && m.ts < to) byId.set(m.id, m); }
    for (const { msg } of state.msgs.values()) if (msg.ts >= from && msg.ts < to) byId.set(msg.id, msg);
    for (const m of byId.values()) addMsg(g, m, starts, me);
    g.truncated = raw.length >= LIMIT;
    // Reaktionen liefert v1 nicht; bekannt nur für die zuletzt geladenen Nachrichten
    const loadedFrom = Math.min(...[...state.msgs.values()].map((e) => e.msg.ts));
    reactionsKnown = Number.isFinite(loadedFrom) && loadedFrom <= from;
  }
  const out = { ...finishMsgAgg(g, starts, reactionsKnown), skipped };
  msgStatCache = { key, at: Date.now(), data: out };
  return out;
}

// Zeitraum aus der Anfrage prüfen: höchstens 8 Tage (Last für MeshMonitor und kleine Geräte), nicht in der
// Zukunft, 1–40 aufsteigende Balken
function parseRange(q) {
  const now = Date.now();
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  let from = Math.floor(Number(q.get('from')));
  let to = Math.floor(Number(q.get('to')));
  if (!Number.isFinite(from)) from = Math.floor(Number(q.get('since'))); // ältere App-Version
  if (!Number.isFinite(from) || from <= 0) from = midnight.getTime();
  if (!Number.isFinite(to) || to > now || to <= from) to = now;
  const MAX_RANGE = 8 * 86400000;
  if (to - from > MAX_RANGE) from = to - MAX_RANGE;
  let starts = String(q.get('b') || '').split(',').map(Number).filter((x) => Number.isFinite(x) && x >= from && x < to);
  starts = [...new Set(starts)].sort((a, b) => a - b).slice(0, 40);
  if (!starts.length || starts[0] !== from) {
    starts = Array.from({ length: Math.min(24, Math.ceil((to - from) / 3600000)) || 1 }, (_, i) => from + i * 3600000);
  }
  return { from, to: Math.max(to, from + 1), starts };
}

async function rangeStats(q) {
  const { from, to, starts } = parseRange(q);
  const now = Date.now();
  if (Date.now() - state.lastMeta > 60000) await refreshMeta().catch(() => {});
  const msgs = await messageStats(from, to, starts);
  let packets = null;
  if (state.source.protocol === 'meshcore') {
    try {
      const start = await packetLogStart().catch(() => null);
      const e = await packetStats(from, to, starts);
      const a = e.acc;
      // Derselbe Repeater taucht je nach Hash-Größe als "b4" und "b46f" auf -> über den erkannten Node zusammenfassen
      const ranked = (map, snrMap) => {
        const merged = new Map();
        for (const [h, n] of map) {
          const node = nodeForHash(h);
          const k = node?.id || `#${h}`;
          const x = merged.get(k) || { hash: h, name: node ? node.long || node.short || null : nameForHash(h), id: node?.id || null, n: 0, snr: null };
          x.n += n;
          const sn = snrMap?.get(h);
          if (sn != null) x.snr = x.snr == null ? sn : Math.max(x.snr, sn);
          merged.set(k, x);
        }
        return [...merged.values()].sort((x, y) => y.n - x.n).slice(0, 6);
      };
      packets = {
        // Ab wann hat MeshMonitor überhaupt Pakete für diesen Zeitraum? (null = ab Beginn des Zeitraums)
        coverageFrom: start && start > from + 60000 ? start : null,
        total: a.total, bytes: a.bytes, perBucket: a.perBucket, truncated: e.truncated,
        types: top(a.types, 10).map(([name, n]) => ({ name, n })),
        routes: top(a.routes, 4).map(([name, n]) => ({ name, n })),
        hopHist: a.hopHist,
        snr: a.snrN ? { avg: a.snrSum / a.snrN, min: a.snrMin, max: a.snrMax } : null,
        rssi: a.rssiN ? { avg: a.rssiSum / a.rssiN } : null,
        lastHop: ranked(a.lastHop, a.lastHopSnr),
        relays: ranked(a.relay),
        relayCount: a.relay.size, adverts: a.adverts, advertNodes: a.advertNodes.size, senders: a.senders.size,
        farDirect: a.farDirect, maxHops: a.maxHops ? { ...a.maxHops, path: a.maxHops.path.map((h) => nameForHash(h) || `#${h}`), points: [...a.maxHops.path.map((h) => ({ hash: h, label: nameForHash(h) || `#${h}` })), { me: true, label: 'Du' }] } : null,
      };
    } catch (e) {
      if (e.status === 403) packets = { error: 'forbidden' }; else { console.error('[stats] Pakete:', e.status || '', e.message); packets = { error: e.message }; }
    }
  }
  // "Zuletzt gehört" kennt nur den neuesten Zeitpunkt -> nur für Zeiträume, die bis jetzt reichen
  let nodes = null;
  if (to >= now - 60000) {
    const heard = state.nodes.filter((n) => n.id !== state.me && (n.lastHeard || 0) >= from);
    const byType = {};
    for (const n of heard) byType[n.type ?? 0] = (byType[n.type ?? 0] || 0) + 1;
    nodes = { heard: heard.length, known: state.nodes.length, byType };
  }
  return { from, to, starts, generated: now, source: state.source.name, msgs, packets, nodes };
}

// Weg einer empfangenen Nachricht mit Repeater-Namen
function routeOf(m) {
  if (m.mine) return null;
  // Breite der Repeater-Kennungen im Paket: "a3" = 1 Byte, "a37f" = 2 Byte, "a37f02" = 3 Byte
  if (m.path) return { hops: m.path.map((h) => ({ hash: h, name: nameForHash(h) })), route: null, bytes: Math.max(...m.path.map((h) => h.length)) / 2 };
  if (m.direct) return { hops: [], route: 'DIRECT' };
  if (m.hops === 0) return { hops: [], route: null };
  return null;
}

function heardFor(id) {
  const map = state.heard.get(id);
  if (!map) return [];
  return [...map.values()].sort((a, b) => a.hops - b.hops || (b.snr ?? -99) - (a.snr ?? -99));
}

const ownChannelMsgs = () => [...state.msgs.values()].map((e) => e.msg).filter((m) => m.mine && !m.dm && m.channel != null && m.channel >= 0);

function processPackets(list, own) {
  const touched = new Set();
  for (const p of list) {
    if (p.id != null) {
      if (state.seenPackets.has(p.id)) continue;
      state.seenPackets.add(p.id);
    }
    const t = toMs(p.timestamp);
    if (t && t > state.lastPacketTs && t < Date.now() + 60000) state.lastPacketTs = t;
    if (p.payload_type_name !== 'GRP_TXT' && p.payload_type !== 5) continue;
    const path = Array.isArray(p.path_hops) ? p.path_hops.map((x) => str(x).toLowerCase()).filter(Boolean) : [];
    if (!path.length || !p.plaintext || !t) continue; // direkt (0 Hops) = kein Repeater
    const plain = str(p.plaintext);
    const match = own
      .filter((m) => (plain === m.text || plain.endsWith(`: ${m.text}`)) && t >= m.ts - 2000 && t <= m.ts + ECHO_WINDOW_MS)
      .sort((a, b) => a.ts - b.ts)[0];
    if (!match) continue;
    let map = state.heard.get(match.id);
    if (!map) state.heard.set(match.id, (map = new Map()));
    path.forEach((h, i) => {
      const e = map.get(h) || { hash: h, name: null, snr: null, hops: i + 1, count: 0 };
      e.name = e.name || nameForHash(h);
      e.hops = Math.min(e.hops, i + 1);
      if (i === path.length - 1 && p.snr != null) e.snr = e.snr == null ? Number(p.snr) : Math.max(e.snr, Number(p.snr));
      e.count++;
      map.set(h, e);
    });
    touched.add(match.id);
  }
  if (state.seenPackets.size > 30000) {
    let n = state.seenPackets.size - 20000;
    for (const id of state.seenPackets) { if (n-- <= 0) break; state.seenPackets.delete(id); }
  }
  return touched;
}

async function fetchPackets(since, maxPages) {
  const all = [];
  for (let page = 0, offset = 0; page < maxPages; page++) {
    const j = await mm(`${sp()}/packets?since=${since}&limit=1000&offset=${offset}`);
    const arr = asArray(j, 'packets');
    all.push(...arr);
    offset += arr.length;
    if (arr.length < 1000 || (j.total != null && offset >= j.total)) break;
  }
  return all;
}

async function pollEchoes(full) {
  if (state.source?.protocol !== 'meshcore') return;
  const own = ownChannelMsgs();
  if (!own.length) return;
  const now = Date.now();
  let touched = new Set();
  // Nachträglich: eigene Nachrichten der letzten 6 Std., die noch nicht geprüft wurden (z. B. nach Neustart)
  if (full) {
    const todo = own.filter((m) => !state.backfilled.has(m.id) && m.ts > now - 6 * 3600000);
    if (todo.length) {
      const since = Math.min(...todo.map((m) => m.ts)) - 3000;
      touched = processPackets(await fetchPackets(since, 10), own);
      for (const m of todo) state.backfilled.add(m.id);
    }
  }
  // Laufend: nur solange eine eigene Nachricht jünger als das Echo-Fenster ist
  const fresh = own.filter((m) => m.ts > now - ECHO_WINDOW_MS - 10000);
  if (fresh.length) {
    const since = Math.max(state.lastPacketTs - 5000, Math.min(...fresh.map((m) => m.ts)) - 3000);
    for (const id of processPackets(await fetchPackets(since, 3), own)) touched.add(id);
    for (const m of fresh) state.backfilled.add(m.id);
  }
  const changed = [];
  for (const id of touched) {
    const e = state.msgs.get(id);
    if (!e) continue;
    e.msg.heard = heardFor(id);
    e.sig = JSON.stringify(e.msg);
    changed.push(e.msg);
  }
  if (changed.length) broadcast('messages', changed);
}

// MeshCore: empfangene DMs tragen nur ein Schlüssel-Präfix (mc:<12 Hex>), gesendete den vollen Schlüssel.
// Präfix eindeutig auf die volle Node-ID abbilden, damit ein Kontakt nur EINE Unterhaltung hat.
function canonId(id) {
  const m = /^mc:([0-9a-f]{12,63})$/i.exec(id || '');
  if (!m) return id;
  const p = m[1].toLowerCase();
  const hits = (state.pkIndex.get(p.slice(0, 12)) || []).filter((full) => full.slice(3).toLowerCase().startsWith(p));
  return hits.length === 1 ? hits[0] : id;
}

// ---------------------------------------------------------------- Push-Benachrichtigungen
function senderName(m) {
  if (m.name) return m.name;
  const n = state.nodes.find((x) => x.id === m.from);
  return n?.long || n?.short || (m.from || '').replace(/^name:/, '').slice(0, 12) || '?';
}
const EMOJI_ONLY = /^(?=.*(?:\p{Extended_Pictographic}|\p{Regional_Indicator}))(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Regional_Indicator}|\uFE0F|\u200D){1,16}$/u;

// MeshCore: Die v1-API meldet `delivered` nie als true. Das ACK steht nur im MeshCore-Teil als
// deliveryStatus ('sent' | 'delivered' | 'failed', failed = alle Versuche ohne ACK) plus Laufzeit.
function applyDelivery(m) {
  const d = m.mine && m.dm ? state.delivery.get(m.id) : null;
  if (!d) return false;
  const before = `${m.state}|${m.rtt ?? ''}`;
  m.state = d.state;
  if (d.rtt != null) m.rtt = d.rtt;
  return before !== `${m.state}|${m.rtt ?? ''}`;
}
// ---------------------------------------------------------------- Live-Pakete für die Karte
// MeshMonitor schickt "packet:flight" nur über Socket.io. Dieselben Angaben stehen im Paket-Log der v1-API:
// solange eine Karte "Live" anfragt (letzte 20 s), alle 3 s die neuen Pakete holen – EIN Abruf für alle Geräte.
// Nur im Speicher: höchstens 300 Einträge, nichts älter als 60 s. Kein Inhalt, nur Absender, Weg, Typ, SNR.
const LIVE_MS = 3000;
const live = { buf: [], seq: 0, wantAt: 0, since: 0, seen: new Set(), timer: null, busy: false, error: null };
function liveFlight(pk) {
  const t = toMs(pk.timestamp);
  if (!t) return null;
  const path = (Array.isArray(pk.path_hops) ? pk.path_hops : []).map((x) => str(x).toLowerCase()).filter((x) => /^[0-9a-f]{2,6}$/.test(x)).slice(0, 16);
  const sender = pkOf(pk.sender_public_key);
  const src = /^[0-9a-f]{2}$/i.test(str(pk.src_hash)) ? str(pk.src_hash).toLowerCase() : null;
  if (!sender && !src && !path.length) return null; // weder Absender noch Weg: nichts zu zeichnen
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    t, kind: str(pk.payload_type_name || pk.payload_type).slice(0, 20), route: str(pk.route_type_name).slice(0, 12),
    from: sender ? `mc:${sender}` : null, src, path, snr: num(pk.snr), rssi: num(pk.rssi),
    hops: num(pk.hop_count), size: num(pk.payload_size), name: str(pk.advert_name).slice(0, 40) || null, // Name nur bei Adverts
  };
}
async function liveTick() {
  if (live.busy || !state.source || state.source.protocol !== 'meshcore') return;
  live.busy = true;
  try {
    const since = live.since || Date.now() - 5000;
    const arr = asArray(await mm(`${sp()}/packets?since=${since}&limit=200`), 'packets');
    const fresh = [];
    for (const pk of arr) {
      const key = pk.id != null ? String(pk.id) : `${pk.timestamp}|${pk.raw_hex || ''}`;
      if (live.seen.has(key)) continue;
      live.seen.add(key);
      const t = toMs(pk.timestamp);
      if (t && t > live.since) live.since = t;
      const f = liveFlight(pk);
      if (f) fresh.push(f);
    }
    fresh.sort((a, b) => a.t - b.t).forEach((f) => { f.seq = ++live.seq; live.buf.push(f); });
    const cut = Date.now() - 60000;
    while (live.buf.length && (live.buf.length > 300 || live.buf[0].t < cut)) live.buf.shift();
    if (live.seen.size > 5000) live.seen = new Set([...live.seen].slice(-2000));
    if (!live.since) live.since = since;
    live.error = null;
  } catch (e) { live.error = e.status === 403 ? 'FORBIDDEN' : e.message; }
  finally { live.busy = false; }
}
function liveWanted() {
  live.wantAt = Date.now();
  if (live.timer) return;
  live.since = Date.now() - 5000;
  live.timer = setInterval(() => {
    if (Date.now() - live.wantAt > 20000) { clearInterval(live.timer); live.timer = null; live.buf = []; live.seen.clear(); return; }
    liveTick();
  }, LIVE_MS);
  liveTick();
}

// Eigene DMs der letzten 10 Min., deren ACK noch aussteht -> MeshCore-Teil öfter abfragen
const DELIVERY_WINDOW_MS = 10 * 60000;
const pendingDms = () => [...state.msgs.values()].map((e) => e.msg)
  .filter((m) => m.mine && m.dm && m.state !== 'delivered' && m.state !== 'failed' && m.ts > Date.now() - DELIVERY_WINDOW_MS);

// Eigene DM jünger als 2 Min.: "gehört von" kann noch nachkommen, auch wenn das ACK schon da ist
const recentOwnDms = () => [...state.msgs.values()].some((e) => e.msg.mine && e.msg.dm && e.msg.ts > Date.now() - 2 * ECHO_WINDOW_MS);

async function fetchReactions(full) {
  const list = asArray(await mm(`/api/sources/${encodeURIComponent(state.source.id)}/meshcore/messages?limit=${full ? 1000 : 200}`, { raw: true }), 'messages');
  for (const r of list) {
    if (!r?.id) continue;
    if (r.reactionEmoji && r.reactionTargetId) state.reactions.set(str(r.id), { target: str(r.reactionTargetId), emoji: str(r.reactionEmoji) });
    // scopeCode: 0 = ohne Scope, >0 = mit Scope (Name nur, wenn MeshMonitor die Region kennt), null = unbekannt
    const code = r.scopeCode == null ? null : Number(r.scopeCode);
    const name = str(r.scopeName).trim() || null;
    state.scopes.set(str(r.id), { name, code: Number.isFinite(code) ? code : null });
    // Eigene DM: welche Repeater sie hörbar weitergesendet haben (MeshMonitor sammelt das selbst)
    if (Array.isArray(r.heardBy) && r.heardBy.length && (r.channel === -1 || r.toPublicKey || r.isDm || state.msgs.get(str(r.id))?.msg.dm)) {
      const list = r.heardBy.slice(0, 32).map((h) => {
        const hash = str(h?.hash).toLowerCase().slice(0, 16);
        return hash ? { hash, name: str(h.name) || nameForHash(hash) || null, snr: Number.isFinite(Number(h.snr)) && h.snr != null ? Number(h.snr) : null, hops: Number.isFinite(Number(h.hops)) && h.hops != null ? Number(h.hops) : 1 } : null;
      }).filter(Boolean).sort((a, b) => a.hops - b.hops || (b.snr ?? -99) - (a.snr ?? -99));
      if (JSON.stringify(list) !== JSON.stringify(state.dmHeard.get(str(r.id)) || [])) { state.dmHeard.set(str(r.id), list); state.dmHeardDirty.add(str(r.id)); }
    }
    const ds = str(r.deliveryStatus).toLowerCase();
    if (ds === 'delivered' || ds === 'failed' || ds === 'sent') {
      state.delivery.set(str(r.id), { state: ds, rtt: Number.isFinite(Number(r.roundTripMs)) && r.roundTripMs != null ? Math.round(Number(r.roundTripMs)) : null });
    }
  }
}

// Je Gerät entscheiden: App gerade offen -> kein Push; Chat stumm -> nie; Kanal auf "alle" -> jede Nachricht.
// standard = DM, Erwähnung oder Reaktion auf eine eigene Nachricht (das meldet MeshLink Chat ohne Einstellung).
const pushSkip = (conv, standard) => (sub) => {
  if ((state.visible.get(sub.endpoint) || 0) > Date.now()) return true;
  const pref = sub.prefs?.[`${state.source?.id}|${conv}`];
  if (pref === 'mute') return true;
  return !standard && pref !== 'all';
};

function maybePush(m) {
  if (!push.count() || m.mine || m.ownOther) return;
  if (m.ts < Date.now() - 10 * 60000) return; // nichts Altes nachträglich melden
  const fail = (e) => console.error('[push]', e.message);
  if (m.reaction) {
    // Wie im Messenger: Bescheid geben, wenn jemand auf MEINE Nachricht reagiert
    const target = state.msgs.get(str(m.replyId))?.msg;
    if (!target?.mine) return;
    const conv = target.dm ? `dm:${target.to}` : `ch:${target.channel}`;
    push.send((sub) => { const T = tFor(sub); return { title: T('notif.reacted', { name: senderName(m) }), body: T('notif.reactBody', { emoji: m.emoji, text: target.text.slice(0, 80) }), tag: `react:${target.id}`, conv, ts: m.ts }; }, pushSkip(conv, true)).catch(fail);
    return;
  }
  const mention = !m.dm && [...state.myNames].some((n) => m.text.includes(`@[${n}]`));
  const ch = state.channels.find((c) => c.index === m.channel);
  const conv = m.dm ? `dm:${m.from}` : `ch:${m.channel}`;
  push.send((sub) => {
    const T = tFor(sub);
    const chName = ch?.name || (m.channel === 0 ? T('channel.primary') : T('channel.n', { i: m.channel }));
    return {
      title: m.dm ? senderName(m) : T('notif.inConv', { name: senderName(m), conv: chName }),
      body: m.text.replace(/@\[([^\]]{1,40})\]/g, '@$1').slice(0, 200),
      tag: conv,
      conv,
      ts: m.ts,
    };
  }, pushSkip(conv, m.dm || mention)).catch(fail);
}

// Quelle wechseln: kompletter Neustart des Zustands für die neue Quelle (nichts wird gespeichert)
async function switchSource(id) {
  if (!state.sources.some((s) => s.id === id)) throw Object.assign(new Error('Unbekannte Quelle'), { status: 400 });
  for (let i = 0; polling && i < 100; i++) await new Promise((r) => setTimeout(r, 50));
  state.activeSourceId = id;
  Object.assign(state, {
    source: null, me: cfg.myNodeId, nodes: [], channels: [], lastMeta: 0, lastFull: 0, newest: 0, nodesSig: '',
    lastPacketTs: 0, relays: [], pushReady: false,
  });
  state.myNames = new Set(cfg.myName ? [cfg.myName] : []);
  for (const c of [state.msgs, state.heard, state.seenPackets, state.backfilled, state.otherNames, state.pkIndex, state.reactions, state.scopes, state.delivery, state.dmHeard, state.dmRoute]) c.clear();
  await tick();
  broadcast('reset', { source: state.source });
  return state.source;
}

let pollTimer = null;
let polling = false;
async function tick() {
  if (polling) return;
  polling = true;
  try {
    if (!state.source) await resolveSource();
    if (Date.now() - state.lastMeta > 60000) await refreshMeta();
    const full = !state.newest || Date.now() - state.lastFull > 300000;
    await pollMessages();
    if (full) { state.pushReady = true; catchUp = false; }
    await pollEchoes(full).catch((e) => console.error('[echo]', e.status || '', e.message));
    setStatus(true, null);
  } catch (e) {
    console.error('[poll]', e.status || '', e.message);
    setStatus(false, e.message);
  } finally {
    polling = false;
  }
}
function schedule(delay) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await tick();
    schedule(clients.size ? cfg.pollMs : cfg.idlePollMs);
  }, delay);
}

// ---------------------------------------------------------------- Auth

const pwKey = () => crypto.createHmac('sha256', cfg.secret).update(cfg.password).digest();
function sign(exp) {
  return crypto.createHmac('sha256', pwKey()).update(String(exp)).digest('base64url');
}
function makeSession() {
  const exp = Date.now() + cfg.sessionDays * 86400000;
  return `${exp}.${sign(exp)}`;
}
function validSession(req) {
  const m = /(?:^|;\s*)mc_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  let raw;
  try { raw = decodeURIComponent(m[1]); } catch { return false; }
  const [exp, sig] = raw.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function checkPassword(pw) {
  const a = crypto.createHash('sha256').update(String(pw)).digest();
  const b = crypto.createHash('sha256').update(cfg.password).digest();
  return crypto.timingSafeEqual(a, b);
}
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || /https/.test(req.headers['cf-visitor'] || '');
const clientIp = (req) => req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?';

// Login-Bremse: 8 Fehlversuche je Adresse, zusätzlich 40 insgesamt (die Adresse im Header ließe sich fälschen)
const attempts = new Map(); // ip -> {count, until}
const GLOBAL_KEY = '*';
const limitFor = (k) => (k === GLOBAL_KEY ? 40 : 8);
function rateLimited(ip) {
  return [ip, GLOBAL_KEY].some((k) => {
    const a = attempts.get(k);
    return Boolean(a && a.until >= Date.now() && a.count >= limitFor(k));
  });
}
function noteFailure(ip) {
  for (const [k, v] of attempts) if (v.until < Date.now()) attempts.delete(k); // abgelaufene entfernen
  for (const k of [ip, GLOBAL_KEY]) {
    const a = attempts.get(k);
    if (!a) attempts.set(k, { count: 1, until: Date.now() + 15 * 60000 });
    else a.count++;
  }
}

// ---------------------------------------------------------------- HTTP

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://tile.openstreetmap.org https://*.tile.openstreetmap.fr https://server.arcgisonline.com https://*.tile.opentopomap.org; style-src 'self'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS, ...headers });
  res.end(JSON.stringify(obj));
}

async function readBody(req, limit = 16384) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// Versionskennung aus dem Inhalt der App-Dateien. Ändert sich bei jedem Deploy mit Codeänderung.
const APP_VERSION = (() => {
  const h = crypto.createHash('sha1');
  for (const f of ['app.js', 'style.css', 'sw.js', 'index.html', ...i18n.files()]) {
    try { h.update(fs.readFileSync(path.isAbsolute(f) ? f : path.join(PUBLIC_DIR, f))); } catch { /* fehlt */ }
  }
  return h.digest('hex').slice(0, 10);
})();

function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: 'bad path' }); }
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    const ext = path.extname(file);
    if (rel === '/index.html') {
      // App-Dateien mit Version verlinken -> Browser lädt nach jedem Deploy garantiert neu.
      // Dazu die Sprache: Wörterbuch als JSON-Block (kein Skript, wird nicht ausgeführt), "<" maskiert.
      const lang = i18n.clientData(i18n.pick(req));
      data = Buffer.from(data.toString('utf8')
        .replace('<html lang="de">', `<html lang="${lang.lang}">`)
        .replace('<script type="application/json" id="i18n">{}</script>', () => `<script type="application/json" id="i18n">${JSON.stringify(lang).replace(/</g, '\\u003c')}</script>`)
        .replace('src="/app.js"', `src="/app.js?v=${APP_VERSION}"`)
        .replace('href="/style.css"', `href="/style.css?v=${APP_VERSION}"`));
    } else if (rel === '/manifest.webmanifest') {
      // Beschreibung und Sprache der installierten App in der Sprache des Geräts
      const T = i18n.translator(i18n.pick(req));
      try { data = Buffer.from(JSON.stringify({ ...JSON.parse(data.toString('utf8')), description: T('app.description'), lang: T.lang }, null, 2)); } catch { /* Datei wie sie ist */ }
    }
    // Versionierte Dateien dürfen lange gecacht werden, alles andere wird jedes Mal geprüft
    const versioned = url.searchParams.get('v') === APP_VERSION;
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : ext === '.png' || ext === '.svg' ? 'public, max-age=86400' : 'no-cache',
      ...(rel === '/index.html' || rel === '/manifest.webmanifest' ? { Vary: 'Cookie, Accept-Language' } : {}),
      ...SEC_HEADERS,
    });
    res.end(data);
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const T = i18n.translator(i18n.pick(req)); // Texte in der Sprache dieses Geräts

  if (p === '/api/login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (rateLimited(ip)) return send(res, 429, { error: T('srv.tooManyLogins') });
    const body = await readBody(req);
    if (!checkPassword(body.password || '')) {
      noteFailure(ip);
      await new Promise((r) => setTimeout(r, 600));
      return send(res, 401, { error: T('srv.wrongPassword') });
    }
    attempts.delete(ip);
    const cookie = `mc_session=${encodeURIComponent(makeSession())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${cfg.sessionDays * 86400}${isHttps(req) ? '; Secure' : ''}`;
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }

  if (p === '/api/logout' && req.method === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'mc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
  }

  if (!validSession(req)) return send(res, 401, { error: 'unauthorized' });

  // CSRF-Schutz für schreibende Requests: nur same-origin
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    let originHost = null;
    try { originHost = origin ? new URL(origin).host : null; } catch { originHost = ''; } // z. B. "null"
    if (origin && originHost !== req.headers.host) return send(res, 403, { error: 'bad origin' });
  }

  if (p === '/api/bootstrap' && req.method === 'GET') {
    if (!state.source) await tick();
    const msgs = [...state.msgs.values()].map((e) => e.msg).sort((a, b) => a.ts - b.ts);
    return send(res, 200, { ...metaPayload(), messages: msgs, read: Object.fromEntries(state.read), connected: state.connected, error: state.error });
  }

  if (p === '/api/events' && req.method === 'GET') {
    // Obergrenze für gleichzeitig offene Live-Verbindungen (je offenem Tab eine) – der Browser versucht es später erneut
    if (clients.size >= 50) return send(res, 503, { error: T('srv.tooManyConns') });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...SEC_HEADERS,
    });
    res.write(`retry: 3000\nevent: status\ndata: ${JSON.stringify({ connected: state.connected, error: state.error })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    if (clients.size === 1) schedule(0); // sofort auf schnelles Polling umschalten
    return;
  }

  if (p === '/api/send' && req.method === 'POST') {
    if (!state.source) await tick();
    if (!state.source) return send(res, 503, { error: state.error || T('status.mmDown') });
    const b = await readBody(req);
    const text = String(b.text || '').trim();
    if (!text) return send(res, 400, { error: T('srv.emptyMsg') });
    const body = { text };
    if (b.to) body.toNodeId = String(b.to);
    else {
      body.channel = Number(b.channel ?? 0);
      if (!Number.isInteger(body.channel) || body.channel < 0 || body.channel > 255) return send(res, 400, { error: T('srv.badChannel') });
    }
    if (b.replyId != null && b.replyId !== '') body.replyId = Number(b.replyId);
    if (b.emoji) body.emoji = 1;
    // Scope nur für diese Nachricht ('' = ausdrücklich ohne Scope); nur Kanal-Nachrichten
    if (!b.to && typeof b.scope === 'string' && b.scope.length <= 63) body.scope = b.scope.replace(/[^0-9A-Za-z-]/g, '');
    if (state.source.protocol === 'meshcore') { delete body.replyId; delete body.emoji; }
    try {
      const r = unwrap(await mm(`${sp()}/messages`, { method: 'POST', body }));
      setTimeout(() => schedule(0), 300);
      setTimeout(() => schedule(0), 2500);
      return send(res, 200, { ok: true, id: r?.messageId ?? r?.id ?? null, result: r });
    } catch (e) {
      console.error('[send]', e.status || '', e.message, JSON.stringify(e.body || {}).slice(0, 500));
      return send(res, e.status && e.status < 500 ? e.status : 502, { error: e.message, code: e.code });
    }
  }

  // Karte: Nodes mit Position (frisch, max. 60 s alt), Zeitpunkte der Nodes ohne Position und Verbindungen
  if (p === '/api/map' && req.method === 'GET') {
    if (!state.source) await tick();
    if (Date.now() - state.lastMeta > 60000) await refreshMeta().catch(() => {});
    const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days')) || 1));
    const withPos = [];
    const noPos = [];
    for (const n of state.nodes) {
      if (n.lat != null && n.lon != null) withPos.push({ id: n.id, long: n.long, short: n.short, type: n.type, fav: n.fav, local: n.local || n.id === state.me, lastHeard: n.lastHeard, hops: n.hops, snr: n.snr, lat: n.lat, lon: n.lon });
      else noPos.push(n.lastHeard || 0);
    }
    return send(res, 200, { nodes: withPos, noPos, me: state.me, links: await mapLinks(days) });
  }

  // MeshCore-Funktionen der MeshMonitor-REST-API (/api/sources/…/meshcore, gleicher Token)
  const mcp = () => `/api/sources/${encodeURIComponent(state.source.id)}/meshcore`;
  if (p === '/api/scopes' && req.method === 'GET') {
    if (!state.source) await tick();
    if (state.source?.protocol !== 'meshcore') return send(res, 200, { defaultScope: null, regions: [] });
    const [def, reg] = await Promise.allSettled([mm(`${mcp()}/config/default-scope`, { raw: true }), mm(`${mcp()}/saved-regions`, { raw: true })]);
    const regions = reg.status === 'fulfilled' && Array.isArray(reg.value?.regions) ? reg.value.regions.map((r) => str(r?.name)).filter(Boolean) : [];
    return send(res, 200, {
      defaultScope: def.status === 'fulfilled' && typeof def.value?.scope === 'string' ? def.value.scope : null,
      regions: [...new Set(regions)].slice(0, 100),
      readable: def.status === 'fulfilled',
    });
  }
  if (p === '/api/advert' && req.method === 'POST') {
    if (!state.source) return send(res, 503, { error: T('status.mmDown') });
    const b = await readBody(req);
    const mode = b.mode === 'flood' ? 'flood' : 'zero_hop';
    try {
      await mm(`${mcp()}/advert`, { raw: true, method: 'POST', body: { mode } });
      return send(res, 200, { ok: true, mode });
    } catch (e) { return mmError(res, e, T); }
  }
  // ---- Kontakt-Werkzeuge: Ping, Pfad zurücksetzen/suchen, gespeicherter Pfad, Nachbarn
  const pkFromBody = async () => { const b = await readBody(req); return { b, pk: pkOf(b.id) }; };
  if (p === '/api/node/ping' && req.method === 'POST') {
    const { pk } = await pkFromBody();
    if (!pk || !state.source) return send(res, 400, { error: T('srv.unknownNode') });
    try { return send(res, 200, { ok: true, ...(unwrap(await mm(`${mcp()}/contacts/${pk}/ping`, { raw: true, method: 'POST', body: {}, timeout: 45000 })) || {}) }); } catch (e) { return mmError(res, e, T); }
  }
  if ((p === '/api/node/reset-path' || p === '/api/node/discover-path') && req.method === 'POST') {
    const { pk } = await pkFromBody();
    if (!pk || !state.source) return send(res, 400, { error: T('srv.unknownNode') });
    try {
      const r = unwrap(await mm(`${mcp()}/contacts/${pk}/${p.endsWith('reset-path') ? 'reset-path' : 'discover-path'}`, { raw: true, method: 'POST', body: {}, timeout: 30000 }));
      contactCache.at = 0;
      return send(res, 200, { ok: true, waitMs: Number(r?.suggestedTimeoutMs ?? r?.discoveryTimeoutMs) || null });
    } catch (e) { return mmError(res, e, T); }
  }
  if (p === '/api/node/contact' && req.method === 'GET') {
    const pk = pkOf(url.searchParams.get('id'));
    if (!pk || !state.source) return send(res, 400, { error: T('srv.unknownNode') });
    try {
      const c = await companionContact(pk);
      if (!c) return send(res, 200, { known: false });
      const len = c.pathLen ?? c.path_len ?? c.outPathLen ?? null;
      const hops = parsePath(c.outPath ?? c.out_path) || [];
      const flood = len == null || Number(len) < 0 || Number(len) === 255;
      return send(res, 200, { known: true, flood: flood && !hops.length, hops: hops.map((h) => ({ hash: h, name: nameForHash(h) })) });
    } catch (e) { return mmError(res, e, T); }
  }
  if (p === '/api/node/neighbours' && req.method === 'GET') {
    const pk = pkOf(url.searchParams.get('id'));
    if (!pk || !state.source) return send(res, 400, { error: T('srv.unknownNode') });
    const live = url.searchParams.get('live') === '1';
    try {
      let list;
      let ts = null;
      if (live) {
        const r = unwrap(await mm(`${mcp()}/contacts/${pk}/neighbours?count=50&orderBy=2`, { raw: true, timeout: 60000 })) || {};
        ts = Date.now();
        list = (r.neighbours || []).map((n) => ({ key: str(n.fullPublicKey || '').toLowerCase() || null, prefix: str(n.publicKeyPrefix).toLowerCase(), name: n.name || null, snr: n.snr ?? null, secs: n.heardSecondsAgo ?? null }));
      } else {
        const items = asArray(unwrap(await mm(`${mcp()}/neighbors?node=${pk}`, { raw: true })), 'items');
        const rows = (Array.isArray(items) ? items : []).filter((i) => str(i.publicKey).toLowerCase() === pk);
        ts = Math.max(0, ...rows.map((r) => toMs(r.timestamp) || 0)) || null;
        list = rows.map((n) => ({ key: str(n.neighborPublicKey).toLowerCase(), prefix: str(n.neighborPublicKey).slice(0, 2).toLowerCase(), name: n.neighborName || null, snr: n.snr ?? null, secs: n.lastHeardSecs ?? null }));
      }
      const out = list.map((n) => {
        const node = (n.key && nodeById(`mc:${n.key}`)) || (!n.key && n.prefix ? nodeForHash(n.prefix) : null);
        return { id: node?.id || (n.key ? `mc:${n.key}` : null), hash: n.prefix, name: n.name || node?.long || node?.short || null, snr: n.snr, secs: n.secs };
      }).sort((a, b) => (b.snr ?? -99) - (a.snr ?? -99));
      return send(res, 200, { ts, neighbours: out.slice(0, 100) });
    } catch (e) { return mmError(res, e, T); }
  }

  // Favorit setzen/entfernen (MeshMonitor und Companion-Kontakt)
  if (p === '/api/node/favorite' && req.method === 'POST') {
    const { b, pk } = await pkFromBody();
    if (!pk || !state.source) return send(res, 400, { error: T('srv.unknownNode') });
    const fav = Boolean(b.fav);
    try {
      await mm(`${mcp()}/nodes/${pk}/favorite`, { raw: true, method: 'POST', body: { isFavorite: fav } });
      const n = nodeById(`mc:${pk}`);
      if (n) n.fav = fav;
      state.nodesSig = '';
      broadcast('meta', metaPayload());
      return send(res, 200, { ok: true, fav });
    } catch (e) { return mmError(res, e, T); }
  }

  // ---- Room-Server
  if (p === '/api/rooms' && req.method === 'GET') {
    if (!state.source) await tick();
    if (state.source?.protocol !== 'meshcore') return send(res, 200, { rooms: [] });
    try {
      const list = asArray(await mm(`${mcp()}/rooms/servers`, { raw: true }), 'rooms');
      return send(res, 200, { rooms: list.map((r) => ({ id: `mc:${str(r.publicKey).toLowerCase()}`, name: r.advName || r.name || str(r.publicKey).slice(0, 8), lastSeen: toMs(r.lastSeen), snr: r.snr ?? null, loggedIn: Boolean(r.loggedIn) })) });
    } catch (e) { return mmError(res, e, T); }
  }
  if (p === '/api/rooms/login' && req.method === 'POST') {
    const { b, pk } = await pkFromBody();
    if (!pk || !state.source) return send(res, 400, { error: T('srv.unknownRoom') });
    try {
      const r = b.saved
        ? await mm(`${mcp()}/rooms/login-with-saved`, { raw: true, method: 'POST', body: { publicKey: pk }, timeout: 90000 })
        : await mm(`${mcp()}/rooms/login`, { raw: true, method: 'POST', body: { publicKey: pk, password: str(b.password).slice(0, 64), rememberPassword: Boolean(b.remember) }, timeout: 90000 });
      const d = unwrap(r);
      if (r?.success === false || d?.success === false) return send(res, 422, { error: d?.error || r?.error || 'Anmeldung abgelehnt', code: 'ROOM_LOGIN_REJECTED' });
      return send(res, 200, { ok: true });
    } catch (e) { return mmError(res, e, T); }
  }
  if (p === '/api/rooms/posts' && req.method === 'GET') {
    const pk = pkOf(url.searchParams.get('id'));
    if (!pk || !state.source) return send(res, 400, { error: T('srv.unknownRoom') });
    try {
      const list = asArray(await mm(`${mcp()}/messages/room/${pk}?limit=150`, { raw: true }), 'messages');
      const me = pkOf(state.me);
      const posts = list.filter((m) => !m.reactionEmoji).map((m) => ({
        id: str(m.id), text: str(m.text), ts: toMs(m.receivedAt ?? m.timestamp) || 0,
        name: m.authorName || m.fromName || m.senderName || null,
        mine: Boolean((me && str(m.fromPublicKey).toLowerCase() === me) || m.fromPublicKey === 'local' || /^sent-/.test(str(m.id))),
      })).sort((a, b) => a.ts - b.ts);
      return send(res, 200, { posts });
    } catch (e) { return mmError(res, e, T); }
  }
  if (p === '/api/rooms/post' && req.method === 'POST') {
    const { b, pk } = await pkFromBody();
    const text = str(b.text).trim();
    if (!pk || !state.source || !text) return send(res, 400, { error: T('srv.badPost') });
    try {
      await mm(`${mcp()}/rooms/post`, { raw: true, method: 'POST', body: { roomPublicKey: pk, text }, timeout: 30000 });
      return send(res, 200, { ok: true });
    } catch (e) { return mmError(res, e, T); }
  }

  // Reaktion senden (MeshCore)
  if (p === '/api/react' && req.method === 'POST') {
    if (!state.source) return send(res, 503, { error: T('status.mmDown') });
    const b = await readBody(req);
    const id = str(b.id);
    const emoji = str(b.emoji);
    if (!id || id.length > 128 || !emoji || emoji.length > 64) return send(res, 400, { error: T('srv.badReaction') });
    try {
      await mm(`${mcp()}/messages/${encodeURIComponent(id)}/reaction`, { raw: true, method: 'POST', body: { emoji } });
      setTimeout(() => schedule(0), 800);
      setTimeout(() => schedule(0), 3000);
      return send(res, 200, { ok: true });
    } catch (e) { return mmError(res, e, T); }
  }

  // Echtes Resend: gleiche Bytes, gleicher Zeitstempel -> wer sie schon hat, verwirft die Kopie
  if (p === '/api/resend' && req.method === 'POST') {
    if (!state.source) return send(res, 503, { error: T('status.mmDown') });
    const b = await readBody(req);
    const id = str(b.id);
    if (!id || id.length > 128) return send(res, 400, { error: T('srv.badMessage') });
    try {
      const r = unwrap(await mm(`${mcp()}/messages/${encodeURIComponent(id)}/resend`, { raw: true, method: 'POST', body: {} }));
      setTimeout(() => schedule(0), 2500);
      return send(res, 200, { ok: true, resendCount: r?.resendCount ?? null });
    } catch (e) { return mmError(res, e, T); }
  }

  // Node-Details: Telemetrie-Verlauf (nur lesen, nichts wird gespeichert)
  if (p === '/api/node/telemetry' && req.method === 'GET') {
    const pk = pkOf(url.searchParams.get('id'));
    if (!pk || !state.source) return send(res, 400, { error: T('srv.unknownNode') });
    const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days')) || 7));
    // b = Tagesanfänge (ms) in der Zeitzone des Geräts, für "Pakete pro Tag"
    const bounds = (url.searchParams.get('b') || '').split(',').map(Number).filter((x) => Number.isFinite(x) && x > 0).slice(0, 31).sort((a, b) => a - b);
    try { return send(res, 200, await nodeTelemetry(pk, days, bounds)); } catch (e) { return mmError(res, e, T); }
  }
  // Status (Repeater/Room) bzw. Sensorwerte (LPP) jetzt abfragen – sendet eine Anfrage ins Mesh
  if (p === '/api/node/status' && req.method === 'POST') {
    const b = await readBody(req);
    const pk = pkOf(b.id);
    if (!pk || !state.source) return send(res, 400, { error: T('srv.unknownNode') });
    const type = b.type === 'lpp' ? 'lpp' : 'status';
    try {
      const r = unwrap(await mm(`${sp()}/actions/request-telemetry`, { method: 'POST', body: { destination: `mc:${pk}`, type }, timeout: 90000 }));
      return send(res, 200, { ok: true, written: r?.written ?? null, series: (await nodeTelemetry(pk, 1).catch(() => ({}))).series || {} });
    } catch (e) { return mmError(res, e, T); }
  }
  // Traceroute starten (läuft im Hintergrund in MeshMonitor) und Ergebnisse lesen
  if (p === '/api/node/trace' && req.method === 'POST') {
    const b = await readBody(req);
    const pk = pkOf(b.id);
    if (!pk || !state.source) return send(res, 400, { error: T('srv.unknownNode') });
    try {
      await mm(`${sp()}/actions/traceroute`, { method: 'POST', body: { destination: `mc:${pk}` } });
      return send(res, 200, { ok: true, at: Date.now() });
    } catch (e) { return mmError(res, e, T); }
  }
  // Traceroute über einen selbst gewählten Pfad (Repeater in Reihenfolge, der letzte ist das Ziel).
  // MeshMonitor tract nur den gespeicherten Pfad eines Kontakts – also: Pfad des Ziels kurz auf die Wahl setzen
  // (nur ein Befehl ans Gerät, nichts geht über Funk), Trace hin und zurück, danach den alten Pfad wiederherstellen.
  if (p === '/api/node/trace-custom' && req.method === 'POST') {
    if (!state.source || state.source.protocol !== 'meshcore') return send(res, 400, { error: T('srv.mcOnly') });
    const b = await readBody(req);
    const ids = Array.isArray(b.hops) ? b.hops.map(str).slice(0, 9) : [];
    const nodes = ids.map((x) => nodeById(x));
    if (!ids.length || ids.length > 8 || nodes.some((n) => !n || !pkOf(n.id) || (n.type !== 2 && n.type !== 3))) {
      return send(res, 400, { error: T('srv.traceHops', { n: 8 }) });
    }
    if (new Set(ids).size !== ids.length) return send(res, 400, { error: T('srv.traceDup') });
    if (customTraceBusy) return send(res, 409, { error: T('trace.busy'), code: 'TRACE_BUSY' });
    const pks = nodes.map((n) => pkOf(n.id));
    const target = pks[pks.length - 1];
    // Hash-Breite: 1 Byte, wenn jede gewählte Station damit eindeutig ist, sonst 2 (Trace kann nur 1 oder 2)
    const relays = state.nodes.filter((n) => (n.type === 2 || n.type === 3) && pkOf(n.id)).map((n) => pkOf(n.id));
    const unique = (w) => pks.every((k) => relays.filter((r) => r.startsWith(k.slice(0, w * 2))).length === 1);
    const width = unique(1) ? 1 : 2;
    const outHops = pks.slice(0, -1).map((k) => k.slice(0, width * 2));
    customTraceBusy = true;
    let original = null;
    let restored = false;
    const t0 = Date.now();
    const tag = `[trace-custom] ${nodes.map((n) => n.long || n.short || pkOf(n.id).slice(0, 8)).join(' › ')}`;
    console.log(`${tag}: Start (${width}-Byte-Kennungen, Pfad zum Ziel: ${outHops.join(',') || 'direkt'})`);
    try {
      original = await companionContact(target, true);
      if (!original) {
        console.log(`${tag}: Ziel ist kein Kontakt des Companions`);
        return send(res, 409, { error: T('srv.notContact'), code: 'NOT_A_CONTACT' });
      }
      await mm(`${mcp()}/contacts/${target}/out-path`, { raw: true, method: 'PUT', body: { outPath: outHops.join(','), hashBytes: width }, timeout: 20000 });
      console.log(`${tag}: Pfad gesetzt, sende Trace …`);
      let r;
      try {
        r = unwrap(await mm(`${mcp()}/contacts/${target}/trace-path`, { raw: true, method: 'POST', body: { autoReturn: true }, timeout: 75000 }));
      } catch (e) {
        if (e.status === 504 || e.name === 'TimeoutError') {
          console.log(`${tag}: keine Antwort nach ${Math.round((Date.now() - t0) / 1000)} s`);
          return send(res, 200, { ok: false, timeout: true, width, ms: Date.now() - t0 });
        }
        console.error(`${tag}: Trace fehlgeschlagen:`, e.status || '', e.code || '', e.message);
        throw e;
      }
      console.log(`${tag}: Antwort nach ${Math.round((Date.now() - t0) / 1000)} s, Weg ${(r?.path || []).join(',')}, SNR ${(r?.hops || []).map((h) => h?.snr).join('/')} / ${r?.lastSnr}`);
      const tokens = (Array.isArray(r?.path) ? r.path : []).map((t) => str(t).toLowerCase());
      const hops = (Array.isArray(r?.hops) ? r.hops : []).map((h) => (h?.snr == null ? null : Number(h.snr)));
      return send(res, 200, {
        ok: true, width,
        path: tokens.map((t) => { const n = nodeForHash(t); return { hash: t, id: n?.id || null, name: n ? n.long || n.short : null }; }),
        snrs: hops, lastSnr: r?.lastSnr ?? null, ms: Date.now() - t0,
      });
    } catch (e) {
      console.error(`${tag}: Fehler:`, e.status || '', e.code || '', e.message);
      return mmError(res, e, T);
    } finally {
      // Alten Pfad wiederherstellen (auch nach Fehlern). Flood bzw. unbekannt -> Pfad zurücksetzen.
      if (original) {
        try {
          const len = original.pathLen ?? original.path_len ?? original.outPathLen;
          const old = parsePath(original.outPath ?? original.out_path) || [];
          if (len == null || Number(len) < 0 || Number(len) === 255) await mm(`${mcp()}/contacts/${target}/reset-path`, { raw: true, method: 'POST', body: {}, timeout: 20000 });
          else await mm(`${mcp()}/contacts/${target}/out-path`, { raw: true, method: 'PUT', body: { outPath: old.join(','), hashBytes: old.length ? old[0].length / 2 : 1 }, timeout: 20000 });
          restored = true;
          console.log(`${tag}: alter Pfad des Ziels wiederhergestellt`);
        } catch (e) { console.error('[trace-custom] Pfad nicht wiederhergestellt:', e.status || '', e.message); }
        if (!restored) console.error(`[trace-custom] Bitte in MeshMonitor den Pfad von ${target.slice(0, 12)}… zurücksetzen`);
      }
      customTraceBusy = false;
      contactCache.at = 0;
    }
  }

  if (p === '/api/node/traces' && req.method === 'GET') {
    const pk = pkOf(url.searchParams.get('id'));
    if (!pk || !state.source) return send(res, 400, { error: T('srv.unknownNode') });
    try {
      // MeshMonitor filtert erst NACH dem Limit (die neuesten N Traces der ganzen Quelle) – deshalb
      // selbst filtern und großzügig abrufen, sonst fehlen Traces zu ruhigeren Nodes.
      const rows = asArray(await mm(`${sp()}/traceroutes?limit=200`), 'traceroutes');
      const traces = rows.map((t) => traceView(t, pk)).filter(Boolean).sort((a, c) => c.ts - a.ts).slice(0, 5);
      return send(res, 200, { traces });
    } catch (e) { return mmError(res, e, T); }
  }

  // Gelesen-Stand geräteübergreifend: der jeweils neuere Zeitpunkt gewinnt (nur im Speicher, max. 1000 Chats)
  if (p === '/api/read' && req.method === 'POST') {
    const b = await readBody(req);
    const changed = {};
    for (const [k, v] of Object.entries(b.read && typeof b.read === 'object' ? b.read : {}).slice(0, 200)) {
      const t = Number(v);
      if (k.length > 200 || !/^(ch|dm):/.test(k) || !Number.isFinite(t) || t <= 0) continue;
      const ts = Math.min(t, Date.now() + 5000);
      if (ts > (state.read.get(k) || 0) && (state.read.has(k) || state.read.size < 1000)) { state.read.set(k, ts); changed[k] = ts; }
    }
    if (Object.keys(changed).length) broadcast('read', changed);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/live' && req.method === 'GET') {
    if (!state.source) await tick();
    if (state.source?.protocol !== 'meshcore') return send(res, 200, { flights: [], seq: 0, unsupported: true });
    liveWanted();
    const after = Number(url.searchParams.get('after')) || 0;
    if (live.error === 'FORBIDDEN') return send(res, 403, { error: T('live.noPerm'), code: 'FORBIDDEN' });
    // after größer als der Zähler (Dienst neu gestartet) -> von vorn
    const list = after > live.seq ? live.buf : live.buf.filter((f) => f.seq > after);
    return send(res, 200, { seq: live.seq, flights: list.slice(-100), error: live.error || null });
  }
  // Paket-Analyzer: eine Seite aus MeshMonitors Paket-Log, gefiltert von MeshMonitor selbst. Wird nur durchgereicht
  // und verschlankt – MeshLink Chat speichert davon nichts. Höchstens 100 Pakete je Abruf, höchstens 2000 tief blättern.
  if (p === '/api/packets' && req.method === 'GET') {
    if (!state.source) await tick();
    if (state.source?.protocol !== 'meshcore') return send(res, 200, { packets: [], total: 0, unsupported: true });
    const q = url.searchParams;
    const limit = Math.min(100, Math.max(1, Number(q.get('limit')) || 50));
    const offset = Math.min(2000, Math.max(0, Number(q.get('offset')) || 0));
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    const int = (k, max) => { const v = q.get(k); return v != null && /^\d{1,3}$/.test(v) && Number(v) <= max ? v : null; };
    const hex = (k, re) => { const v = str(q.get(k)).toLowerCase(); return re.test(v) ? v : null; };
    const type = int('type', 15); if (type != null) qs.set('payload_type', type);
    const route = int('route', 3); if (route != null) qs.set('route_type', route);
    const via = hex('via', /^(?:[0-9a-f]{2}){1,3}$/); if (via) qs.set('path_hash', via);
    const src = hex('src', /^(?:[0-9a-f]{2}){1,3}$/); if (src) qs.set('src_hash', src);
    const from = hex('from', /^[0-9a-f]{2,64}$/); if (from) qs.set('sender', from);
    const search = str(q.get('q')).trim().slice(0, 64); if (search) qs.set('search', search);
    const after = Number(q.get('after')) || 0; if (after) qs.set('since', String(after + 1));
    try {
      const j = await mm(`${sp()}/packets?${qs}`);
      const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
      const packets = asArray(j, 'packets').map((pk) => ({
        id: pk.id ?? null,
        t: toMs(pk.timestamp),
        type: num(pk.payload_type), kind: str(pk.payload_type_name).slice(0, 20) || null,
        route: num(pk.route_type), routeName: str(pk.route_type_name).slice(0, 20) || null,
        hops: num(pk.hop_count),
        path: (Array.isArray(pk.path_hops) ? pk.path_hops : []).map((x) => str(x).toLowerCase()).filter((x) => /^[0-9a-f]{2,6}$/.test(x)).slice(0, 64),
        snr: num(pk.snr), rssi: num(pk.rssi), size: num(pk.payload_size),
        raw: /^[0-9a-f]*$/i.test(str(pk.raw_hex)) ? str(pk.raw_hex).toLowerCase().slice(0, 1024) : null,
        src: /^[0-9a-f]{2,6}$/i.test(str(pk.src_hash)) ? str(pk.src_hash).toLowerCase() : null,
        from: pkOf(pk.sender_public_key) ? `mc:${pkOf(pk.sender_public_key)}` : null,
        name: str(pk.advert_name).slice(0, 40) || null,
        text: typeof pk.plaintext === 'string' ? pk.plaintext.slice(0, 400) : null,
      }));
      return send(res, 200, { packets, total: num(j?.total) ?? null, offset, limit });
    } catch (e) {
      if (e.status === 403) return send(res, 403, { error: `${T('live.noPerm')} (packetmonitor:read)`, code: 'FORBIDDEN' });
      return mmError(res, e, T);
    }
  }
  // Reach (experimentell): Wen hört ein Repeater direkt, wer hört ihn? Aus den Wegen der Flood-Pakete im Paket-Log:
  // im Weg „… A › X › B …“ hat X A gehört und B hat X gehört; X vorne = X hörte den Absender, X hinten = du hörst X.
  // Nur Pakete, die bei dir angekommen sind. Je Kennungslänge (1–3 Byte) ein Abruf, max. 1000; nichts gespeichert.
  if (p === '/api/node/reach' && req.method === 'GET') {
    const pk = pkOf(url.searchParams.get('id'));
    if (!pk || !state.source) return send(res, 400, { error: T('srv.unknownNode') });
    if (state.source.protocol !== 'meshcore') return send(res, 200, { unsupported: true });
    try {
      const pages = await Promise.all([1, 2, 3].map((w) => mm(`${sp()}/packets?path_hash=${pk.slice(0, w * 2)}&limit=1000`).then((j) => ({ w, list: asArray(j, 'packets') }))));
      const seen = new Set();
      const hears = new Map(); const reaches = new Map();
      let used = 0; let oldest = null; let skipped = 0;
      const byHash = (h, anyType) => {
        const c = state.nodes.filter((n) => n.id.startsWith('mc:') && n.id.slice(3).toLowerCase().startsWith(h));
        if (anyType) return { n: c.length === 1 ? c[0] : null, cand: c.length };
        const pref = c.filter((n) => n.type === 2 || n.type === 3);
        return { n: pref.length === 1 ? pref[0] : c.length === 1 ? c[0] : null, cand: pref.length || c.length };
      };
      const bump = (map, key, base, t) => {
        const e = map.get(key) || { ...base, n: 0, last: 0 };
        e.n++; if (t > e.last) e.last = t;
        map.set(key, e);
      };
      const hopEntry = (h) => { const { n, cand } = byHash(h, false); return n ? { key: n.id, id: n.id, name: n.long || n.short || null, hash: h } : { key: `#${h}`, id: null, name: null, hash: h, amb: cand > 1 ? cand : 0 }; };
      for (const { w, list } of pages) {
        const h = pk.slice(0, w * 2);
        for (const pkt of list) {
          const key = pkt.id ?? `${pkt.timestamp}|${pkt.raw_hex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const rt = Number(pkt.route_type ?? { TRANSPORT_FLOOD: 0, FLOOD: 1, DIRECT: 2, TRANSPORT_DIRECT: 3 }[pkt.route_type_name]);
          // Direkt geroutet: im Weg steht die geplante Route, nicht wer wen gehört hat. Trace: im Pfad stehen SNR-Werte.
          if (rt === 2 || rt === 3 || Number(pkt.payload_type) === 9) { skipped++; continue; }
          const path = (Array.isArray(pkt.path_hops) ? pkt.path_hops : []).map((x) => str(x).toLowerCase());
          const t = toMs(pkt.timestamp) || 0;
          let hit = false;
          path.forEach((x, i) => {
            if (x !== h) return;
            hit = true;
            if (i === 0) {
              const sender = pkOf(pkt.sender_public_key);
              const sn = sender ? nodeById(`mc:${sender}`) : null;
              if (sender) bump(hears, `mc:${sender}`, { id: `mc:${sender}`, name: sn?.long || sn?.short || str(pkt.advert_name) || null, hash: sender.slice(0, 4), origin: true }, t);
              else if (/^[0-9a-f]{2,6}$/i.test(str(pkt.src_hash))) {
                const sh = str(pkt.src_hash).toLowerCase();
                const { n, cand } = byHash(sh, true);
                bump(hears, n ? n.id : `src#${sh}`, n ? { id: n.id, name: n.long || n.short || null, hash: sh, origin: true } : { id: null, name: null, hash: sh, origin: true, amb: cand > 1 ? cand : 0 }, t);
              }
            } else { const e = hopEntry(path[i - 1]); bump(hears, e.key, e, t); }
            if (i === path.length - 1) bump(reaches, 'me', { id: state.me || null, me: true, name: 'Du', hash: null }, t);
            else { const e = hopEntry(path[i + 1]); bump(reaches, e.key, e, t); }
          });
          if (hit) { used++; if (!oldest || t < oldest) oldest = t; }
        }
      }
      const out = (m) => [...m.values()].filter((e) => e.id !== `mc:${pk}`).sort((a, b) => b.n - a.n || b.last - a.last).slice(0, 60)
        .map(({ key, ...e }) => e);
      return send(res, 200, { hears: out(hears), reaches: out(reaches), packets: used, skipped, since: oldest });
    } catch (e) {
      if (e.status === 403) return send(res, 403, { error: `${T('live.noPerm')} (packetmonitor:read)`, code: 'FORBIDDEN' });
      return mmError(res, e, T);
    }
  }
  if (p === '/api/repeaters' && req.method === 'GET') {
    if (!state.source) await tick();
    if (state.source?.protocol !== 'meshcore') return send(res, 200, { repeaters: [] });
    if (Date.now() - state.lastMeta > 60000) await refreshMeta().catch(() => {});
    try { return send(res, 200, await repeaterHealth()); } catch (e) { return mmError(res, e, T); }
  }
  if (p === '/api/mentions' && req.method === 'GET') {
    if (!state.source) await tick();
    if (!state.source) return send(res, 503, { error: state.error || T('status.mmDown') });
    const days = Math.min(7, Math.max(1, Number(url.searchParams.get('days')) || 7));
    try { return send(res, 200, await mentionsSince(days)); } catch (e) { return mmError(res, e, T); }
  }

  if (p === '/api/stats' && req.method === 'GET') {
    if (!state.source) await tick();
    if (!state.source) return send(res, 503, { error: state.error || T('status.mmDown') });
    try { return send(res, 200, await rangeStats(url.searchParams)); } catch (e) { return mmError(res, e, T); }
  }

  if (p === '/api/push/key' && req.method === 'GET') {
    return send(res, 200, { key: push.publicKey, persistent: push.persistent, subscriptions: push.count() });
  }
  if (p === '/api/push/subscribe' && req.method === 'POST') {
    const b = await readBody(req);
    try { push.add(b.subscription, b.prefs, b.watch, b.lang); } catch (e) { return send(res, 400, { error: T('srv.badSubscription') }); }
    return send(res, 200, { ok: true, persistent: push.persistent });
  }
  if (p === '/api/push/unsubscribe' && req.method === 'POST') {
    const b = await readBody(req);
    push.remove(String(b.endpoint || ''));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/push/test' && req.method === 'POST') {
    const r = await push.send((sub) => ({ title: 'MeshLink Chat', body: tFor(sub)('srv.pushTest'), tag: 'test', conv: null, ts: Date.now() }));
    return send(res, 200, { ok: r.some((x) => x.ok), results: r });
  }
  if (p === '/api/presence' && req.method === 'POST') {
    const b = await readBody(req);
    const ep = String(b.endpoint || '');
    if (ep) {
      if (b.visible) state.visible.set(ep, Date.now() + 45000); else state.visible.delete(ep);
      for (const [k, v] of state.visible) if (v < Date.now()) state.visible.delete(k);
    }
    return send(res, 200, { ok: true });
  }

  if (p === '/api/source' && req.method === 'POST') {
    const b = await readBody(req);
    try {
      return send(res, 200, { ok: true, source: await switchSource(String(b.id || '')) });
    } catch (e) {
      return send(res, e.status || 502, { error: e.status === 400 ? T('srv.unknownSource') : e.message });
    }
  }

  if (p === '/api/debug' && req.method === 'GET') {
    return send(res, 200, await probe());
  }

  return send(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------- Probe (Diagnose der echten API)

async function probe() {
  const out = { mmUrl: cfg.mmUrl, tokenSet: Boolean(cfg.mmToken) };
  const tryGet = async (label, p, raw = false) => {
    try {
      const j = await mm(p, { raw });
      const arr = asArray(j, 'sources', 'nodes', 'channels', 'messages', 'packets');
      out[label] = arr.length || Array.isArray(unwrap(j))
        ? { count: arr.length, keys: Object.keys(arr[0] || {}), sample: arr.slice(-2) }
        : j;
    } catch (e) {
      out[label] = { error: e.message, status: e.status };
    }
  };
  await tryGet('sources', '/sources');
  try { await resolveSource(); out.chosenSource = state.source; } catch (e) { out.chosenSource = { error: e.message }; }
  if (state.source) {
    await tryGet('status', `${sp()}/status`);
    await tryGet('channels', `${sp()}/channels`);
    await tryGet('nodes', `${sp()}/nodes`);
    await tryGet('messages', `${sp()}/messages?limit=20`);
    await tryGet('packets', `${sp()}/packets?limit=5`);
    if (state.source.protocol === 'meshcore') {
      await tryGet('meshcoreMessages', `/api/sources/${encodeURIComponent(state.source.id)}/meshcore/messages?limit=5`, true);
    }
    await refreshMeta().catch(() => {});
    out.normalizedSample = (Array.isArray(out.messages?.sample) ? out.messages.sample : []).map(normMsg);
  }
  out.detectedMe = state.me;
  out.mmVersion = state.mmVersion || null;
  out.caps = msgCaps();
  out.ownNames = [...state.myNames];
  return out;
}

// ---------------------------------------------------------------- Start

// Sprache der Konsolen-Ausgaben (Verbindungstest, Start-Warnungen): MESHLINK_LANG, sonst die Systemsprache, sonst Englisch
const C = i18n.translator(i18n.match(process.env.MESHLINK_LANG) || i18n.match(String(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '').split(/[._@]/)[0].replace('_', '-')) || i18n.DEFAULT);
if (process.argv.includes('--check')) {
  // Kurzer Verbindungstest für install.sh
  (async () => {
    try {
      await resolveSource();
      await refreshMeta();
      await pollMessages();
      console.log(`  ✔ ${C('cli.connected', { v: VERSION, url: cfg.mmUrl })}`);
      console.log(`  ✔ ${C('cli.source', { name: state.source.name, id: state.source.id, proto: state.source.protocol })}`);
      console.log(`  ✔ ${C('cli.counts', { ch: state.channels.length, nodes: state.nodes.length, msgs: state.msgs.size })}`);
      console.log(state.me ? `  ✔ ${C('cli.me', { id: state.me })}` : `  ⚠ ${C('cli.noMe')}`);
      const caps = msgCaps();
      console.log(`  ${state.mmVersion ? '✔' : '⚠'} ${C('cli.version', { v: state.mmVersion || C('common.unknown'), dm: caps.dm, ch: caps.channel })}`);
      if (state.source.protocol === 'meshcore') {
        await pollEchoes(true).catch((e) => console.log(`  ⚠ ${C('cli.echoes', { msg: e.message })}`));
        const own = ownChannelMsgs().filter((m) => m.ts > Date.now() - 6 * 3600000);
        for (const m of own.slice(-3)) {
          const h = heardFor(m.id);
          console.log(`  📡 „${m.text.slice(0, 28)}“ → ${C('cli.heard', { n: h.length })}${h.length ? ': ' + h.map((r) => `${r.name || '#' + r.hash}${r.snr != null ? ` (${r.snr})` : ''}`).join(', ') : ''}`);
        }
        const inc = [...state.msgs.values()].map((e) => e.msg).filter((m) => !m.mine && !m.reaction);
        const withRoute = inc.filter((m) => m.route);
        console.log(`  ↳ ${C('cli.routes', { k: withRoute.length, n: inc.length })}`);
        for (const m of withRoute.slice(-3)) {
          console.log(`  ↳ ${C(m.dm ? 'cli.dmFrom' : 'cli.chFrom', { name: m.name || m.from.slice(0, 11) })}: ${m.route.hops.length ? m.route.hops.map((x) => x.name || '#' + x.hash).join(' › ') : m.route.route === 'DIRECT' ? C('cli.fixedRoute') : C('common.direct')}`);
        }
      }
      process.exit(0);
    } catch (e) {
      console.error(`  ✘ ${C('common.error', { msg: e.message })}${e.status ? ` (HTTP ${e.status})` : ''}`);
      if (e.status === 401) console.error(`    → ${C('cli.checkToken')}`);
      if (e.status === 403) console.error(`    → ${C('cli.needPerms')}`);
      if (!e.status) console.error(`    → ${C('cli.checkUrl')}`);
      process.exit(1);
    }
  })();
} else if (process.argv.includes('--probe')) {
  probe().then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n', () => process.exit(0)); })
    .catch((e) => { console.error(e); process.exit(1); });
} else {
  if (!cfg.mmToken) console.warn(C('cli.noToken'));
  if (!cfg.password || cfg.password.length < 8) {
    console.error(C('cli.noPassword'));
    process.exit(1);
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/healthz') return send(res, 200, { ok: true, upstream: state.connected, version: VERSION, build: APP_VERSION });
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method' });
      return serveStatic(req, res, url);
    } catch (e) {
      console.error('[http]', e);
      // 401 bedeutet für die App „abgemeldet“ – Fehler von MeshMonitor deshalb nie als 401 durchreichen
      if (!res.headersSent) send(res, e.status === 401 ? 502 : e.status || 500, { error: e.message });
    }
  });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`MeshLink Chat ${VERSION} läuft auf ${cfg.host}:${cfg.port} → MeshMonitor ${cfg.mmUrl}`);
    schedule(0);
    // Repeater-Wächter: alle 2 Min. prüfen (nur wenn ein Gerät ihn eingeschaltet hat; sonst kostet das nichts)
    setTimeout(() => watchTick().catch((e) => console.error('[watch]', e.status || '', e.message)), 20000);
    setInterval(() => watchTick().catch((e) => console.error('[watch]', e.status || '', e.message)), Number(process.env.WATCH_MS) || 120000);
  });
  const stop = () => { for (const c of clients) c.end(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
