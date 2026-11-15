'use strict';
/* Nur für lokale Tests: simuliert die MeshMonitor v1-API (Meshtastic-Quelle). */
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.MOCK_PORT || 18080);
const TOKEN = process.env.MOCK_TOKEN || 'mm_v1_test';
const ME = { nodeId: '!a1b2c3d4', nodeNum: 0xa1b2c3d4, longName: 'Max Home', shortName: 'MAX' };
const nodes = [
  ME,
  { nodeId: '!11112222', nodeNum: 0x11112222, longName: 'Bergstation', shortName: 'BERG', hopsAway: 2, snr: 4.5 },
  { nodeId: '!33334444', nodeNum: 0x33334444, longName: 'Kai Mobil', shortName: 'KAI', hopsAway: 1, snr: -3.25 },
  { nodeId: '!55556666', nodeNum: 0x55556666, longName: 'Repeater Hafen', shortName: 'HAFN', hopsAway: 3 },
].map((n) => ({ ...n, lastHeard: Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 7200) }));
const channels = [{ id: 0, name: 'LongFast', role: 1 }, { id: 1, name: 'Hamburg', role: 2 }, { id: 2, name: '', role: 0 }];
let messages = [];
let pid = 1000;
function add(from, to, channel, text, extra = {}) {
  const packetId = ++pid;
  const now = Date.now();
  const m = {
    id: `${from.nodeNum}_${packetId}`, fromNodeNum: from.nodeNum, fromNodeId: from.nodeId,
    toNodeId: to ? to.nodeId : '!ffffffff', toNodeNum: to ? to.nodeNum : 4294967295,
    text, channel: to ? -1 : channel, portnum: 1, timestamp: now, rxTime: Math.floor(now / 1000), createdAt: now,
    hopStart: 3, hopLimit: 3 - (from.hopsAway || 0), packetId, replyId: null, emoji: 0, ...extra,
  };
  messages.push(m);
  return m;
}
const [, berg, kai] = nodes;
add(berg, null, 0, 'Moin zusammen, jemand QRV?');
const q = add(kai, null, 0, 'Ja, Signal ist heute top 📡');
add(ME, null, 0, 'Hier auch, Grüße aus dem Bastelkeller', { deliveryState: 'delivered' });
add(berg, null, 0, '👍', { emoji: 1, replyId: q.packetId });
add(kai, ME, 0, 'Hey Max, hast du die neue Firmware schon drauf?');
add(ME, kai, 0, 'Noch nicht, mach ich am Wochenende', { deliveryState: 'delivered' });
add(berg, null, 1, 'Test im Hamburg-Kanal');

setInterval(() => {
  const who = [berg, kai][Math.floor(Math.random() * 2)];
  const texts = ['Kurzer Check-in 👋', 'Wetter ist gut hier', 'Wer hört mich?', 'Traceroute läuft', 'Gleich unterwegs'];
  add(who, Math.random() < 0.3 ? ME : null, 0, texts[Math.floor(Math.random() * texts.length)]);
}, Number(process.env.MOCK_INTERVAL || 20000));

// ---- MeshCore-Modus (MOCK_PROTO=meshcore): Format wie echte MeshMonitor-Daten
if (process.env.MOCK_PROTO === 'meshcore') {
  const pk = (c) => c.repeat(64);
  const MEPK = pk('9');
  nodes.length = 0;
  nodes.push(
    // Wie bei MeshMonitor beobachtet: eigener Node in der v1-Liste ohne Position (die steht nur in der Kontaktliste)
    { nodeId: `mc:${MEPK}`, publicKey: MEPK, longName: null, shortName: null, isLocalNode: true, ...(process.env.MOCK_MEPOS ? { latitude: 51.2112, longitude: 9.9702 } : {}) },
    { nodeId: `mc:${pk('b')}`, publicKey: pk('b'), longName: 'R2-D2', shortName: 'R2', advType: 1, isFavorite: true, hopsAway: 0, lastHeard: Math.floor(Date.now() / 1000) - 60, latitude: 51.2301, longitude: 10.0012 },
    { nodeId: `mc:${pk('e')}`, publicKey: pk('e'), longName: 'Joe Mobil', shortName: null, advType: 1, hopsAway: 2, lastHeard: Math.floor(Date.now() / 1000) - 5 * 86400, latitude: 51.1801, longitude: 9.8402 },
    { nodeId: 'mc:b46f' + '1'.repeat(60), publicKey: 'b46f' + '1'.repeat(60), longName: 'RPT Nordhang', advType: 2, isFavorite: true, lastHeard: Math.floor(Date.now() / 1000) - 300, latitude: 51.2402, longitude: 9.9301 },
    { nodeId: 'mc:b3f8' + '2'.repeat(60), publicKey: 'b3f8' + '2'.repeat(60), longName: 'RPT Hafen', advType: 2, lastHeard: Math.floor(Date.now() / 1000) - 3600, latitude: 51.2052, longitude: 10.0103 },
    { nodeId: 'mc:b3f8' + '3'.repeat(60), publicKey: 'b3f8' + '3'.repeat(60), longName: 'Bob Handy', advType: 1 },
    { nodeId: 'mc:' + 'c4'.repeat(32), publicKey: 'c4'.repeat(32), longName: 'Clubhaus-Brett', advType: 3, lastHeard: Math.floor(Date.now() / 1000) - 120, latitude: 51.215, longitude: 9.9900 },
  );
  var packets = []; let pkid = 1;
  // Gruppen-Paket zu einer Nachricht: Bytes hängen nur an Nachricht + Zeitstempel (wie verschlüsselt), nicht am Weg
  var grpPacket = (m, dt, path, snr) => setTimeout(() => packets.unshift({ protocol: 'meshcore', id: pkid++, timestamp: Date.now(), payload_type: 5, payload_type_name: 'GRP_TXT', route_type_name: 'FLOOD',
    path_hops: path, snr, plaintext: `${m.fromName}: ${m.text}`, _pl: '11' + crypto.createHash('sha256').update(`${m.id}|${m.timestamp}`).digest('hex').slice(0, 56) }), dt);
  // Rohdaten (raw_hex) wie im MeshCore-Funkformat erzeugen, damit der Paket-Analyzer etwas zu zerlegen hat
  var mockRaw = (p) => {
    if (p.raw_hex !== undefined) return p;
    const RT = { TRANSPORT_FLOOD: 0, FLOOD: 1, DIRECT: 2, TRANSPORT_DIRECT: 3 };
    const route = RT[p.route_type_name] ?? ((p.path_hops || []).length ? 1 : 2);
    if (p.payload_type == null) p.payload_type = { REQ: 0, RESPONSE: 1, TXT_MSG: 2, ACK: 3, ADVERT: 4, GRP_TXT: 5, ANON_REQ: 7, PATH: 8, TRACE: 9 }[p.payload_type_name] ?? 5;
    if (p.payload_type_name == null) p.payload_type_name = ['REQ', 'RESPONSE', 'TXT_MSG', 'ACK', 'ADVERT', 'GRP_TXT', 'GRP_DATA', 'ANON_REQ', 'PATH', 'TRACE'][p.payload_type];
    p.route_type = route; p.route_type_name = p.route_type_name || ['TRANSPORT_FLOOD', 'FLOOD', 'DIRECT', 'TRANSPORT_DIRECT'][route];
    const seed = (p.id || 1) * 2654435761 >>> 0; let r = seed;
    const rnd = (n) => Array.from({ length: n }, () => { r = (r * 1103515245 + 12345) >>> 0; return (r >>> 16) & 0xff; });
    const out = [(p.payload_type << 2) | route];
    if (route === 0 || route === 3) out.push(0x34, 0x12, 0, 0);
    const hops = p.path_hops || []; const hs = Math.max(1, ...hops.map((h) => h.length / 2));
    p.path_hops = hops.map((h) => (h + '000000').slice(0, hs * 2));
    const sk = p.sender_public_key || (p.src_hash || 'ab').padEnd(64, '5');
    let payload;
    if (p.payload_type === 9) { // TRACE: im Pfad stehen SNR-Werte (×4), die Repeater-Kennungen im Payload
      out.push(hops.length); hops.forEach((_, i) => out.push((24 - i * 6) & 0xff));
      payload = [...rnd(4), 0, 0, 0, 0, 0, ...p.path_hops.flatMap((h) => Buffer.from(h.slice(0, 2), 'hex').toJSON().data)];
    } else {
      out.push((hs - 1) << 6 | hops.length); p.path_hops.forEach((h) => out.push(...Buffer.from(h, 'hex')));
      if (p.payload_type === 4) {
        const name = Buffer.from(p.advert_name || 'Node'); const ll = Buffer.alloc(8); ll.writeInt32LE(51227700, 0); ll.writeInt32LE(10073500, 4);
        const ts = Buffer.alloc(4); ts.writeUInt32LE(Math.floor(p.timestamp / 1000));
        payload = [...Buffer.from(sk, 'hex'), ...ts, ...rnd(64), 0x80 | 0x10 | 2, ...ll, ...name];
      } else if (p.payload_type === 3) payload = rnd(4);
      else if (p.payload_type === 5) payload = p._pl ? [...Buffer.from(p._pl, 'hex')] : [0x11, ...rnd(Math.max(8, (p.payload_size || 40) - 1))]; // _pl: feste Bytes einer Nachricht (alle Kopien gleich)
      else if (p.payload_type === 7) payload = [0x7a, ...Buffer.from(sk, 'hex'), ...rnd(18)];
      else payload = [0xbb, parseInt(sk.slice(0, 2), 16), ...rnd(Math.max(6, (p.payload_size || 30) - 2))];
    }
    out.push(...payload);
    p.payload_size = payload.length;
    p.raw_hex = Buffer.from(out).toString('hex');
    return p;
  };
  // Paket-Log des heutigen Tages (für die Statistik): gemischte Typen, Wege, Empfangswerte
  {
    const mid = new Date(); mid.setHours(0, 0, 0, 0);
    const span = Math.max(60000, Date.now() - mid.getTime() - 60000);
    const types = [['ADVERT', 4], ['GRP_TXT', 5], ['GRP_TXT', 5], ['TXT_MSG', 2], ['ACK', 3], ['PATH', 8], ['REQ', 0], ['RESPONSE', 1], ['ANON_REQ', 7], ['TRACE', 9]];
    const paths = [[], [], ['b46f'], ['b3f8'], ['b46f', 'b3f8'], ['7a', 'b3f8', 'b46f'], ['11', '22', '33', '7a', 'b46f']];
    const senders = [pk('b'), pk('e'), 'b46f' + '1'.repeat(60), 'b3f8' + '2'.repeat(60), 'c4'.repeat(32)];
    for (let i = 0; i < 400; i++) {
      const [name, type] = types[i % types.length]; const path = paths[(i * 3) % paths.length]; const spk = senders[Math.floor(i / 10) % senders.length];
      packets.push({ protocol: 'meshcore', id: pkid++, timestamp: mid.getTime() + Math.floor((span * ((i * 37) % 400)) / 400), payload_type: type, payload_type_name: name,
        route_type: path.length ? 1 : 2, route_type_name: i % 4 ? 'FLOOD' : 'DIRECT', hop_count: path.length, path_hops: path, snr: -8 + ((i * 13) % 80) / 4, rssi: -118 + (i % 40),
        payload_size: 20 + (i % 90), src_hash: spk.slice(0, 2), sender_public_key: name === 'ADVERT' || i % 3 === 0 ? spk : null, advert_name: name === 'ADVERT' ? 'Node' : null, plaintext: null });
    }
    // Paket-Log reicht wie bei MeshMonitor nur begrenzt zurück: hier bis gestern 12 Uhr
    for (let i = 0; i < 120; i++) {
      const t = mid.getTime() - 12 * 3600000 + i * 360000;
      packets.push({ protocol: 'meshcore', id: pkid++, timestamp: t, payload_type: 4, payload_type_name: i % 3 ? 'GRP_TXT' : 'ADVERT', route_type_name: 'FLOOD', hop_count: 1, path_hops: ['b46f'], snr: 3, rssi: -100, payload_size: 40, src_hash: 'bb', sender_public_key: null });
    }
    packets.sort((x, y) => y.timestamp - x.timestamp);
  }
  // Live-Verkehr: alle 0,7–2 s ein neues Paket (MOCK_LIVE=0 schaltet ab)
  if (process.env.MOCK_LIVE !== '0') {
    const kinds = [['ADVERT', 4], ['GRP_TXT', 5], ['TXT_MSG', 2], ['ACK', 3], ['PATH', 8], ['TRACE', 9], ['REQ', 0]];
    const from = [pk('b'), pk('e'), 'b46f' + '1'.repeat(60), 'b3f8' + '2'.repeat(60), 'c4'.repeat(32), 'ab' + '7'.repeat(62)];
    const ways = [[], ['b4'], ['b3'], ['b4', 'b3'], ['c4', 'b4'], ['b3', '7a', 'b4']];
    const liveTick = () => {
      const [name, type] = kinds[Math.floor(Math.random() * kinds.length)];
      const spk = from[Math.floor(Math.random() * from.length)]; const path = ways[Math.floor(Math.random() * ways.length)];
      packets.unshift({ protocol: 'meshcore', id: pkid++, timestamp: Date.now(), payload_type: type, payload_type_name: name, route_type_name: path.length ? 'FLOOD' : 'DIRECT',
        hop_count: path.length, path_hops: path, snr: Math.round((-10 + Math.random() * 22) * 4) / 4, rssi: -120 + Math.floor(Math.random() * 40), payload_size: 30,
        src_hash: spk.slice(0, 2), sender_public_key: name === 'ADVERT' ? spk : null });
      if (packets.length > 3000) packets.length = 3000;
      setTimeout(liveTick, 700 + Math.random() * 1300);
    };
    setTimeout(liveTick, 2000);
  }
  // Vorhandene Traces (4.17.3-Form): 25 neuere zu einem anderen Repeater, dann eine Runde hin+zurück zu b46f…
  // (eigene Traceroute über b3: Palindrom b3,b4,b3 + Rückkehr zu dir). Mit limit=20 + toNodeId fände man sie nicht.
  const traces = [];
  { const RP2 = 'b3f8' + '2'.repeat(60); const RPT0 = 'b46f' + '1'.repeat(60);
    for (let i = 0; i < 25; i++) traces.push({ protocol: 'meshcore', fromNodeId: `mc:${MEPK}`, toNodeId: `mc:${RP2}`, timestamp: Date.now() - (i + 1) * 60000,
      hops: [{ index: 0, publicKey: RP2, hash: 'b3', snr: 8 }, { index: 1, publicKey: MEPK, hash: MEPK.slice(0, 2), snr: 7.5 }] });
    traces.push({ protocol: 'meshcore', fromNodeId: `mc:${MEPK}`, toNodeId: `mc:${RPT0}`, timestamp: Date.now() - 3 * 3600000,
      hops: [{ index: 0, publicKey: RP2, hash: 'b3', snr: 9.25 }, { index: 1, publicKey: RPT0, hash: 'b4', snr: 6.5 }, { index: 2, publicKey: RP2, hash: 'b3', snr: 4.75 }, { index: 3, publicKey: MEPK, hash: MEPK.slice(0, 2), snr: 10 }] }); }
  // Status-Telemetrie des Repeaters: stündlich, 7 Tage. Zähler seit Gerätestart; vor ~3 Tagen ein Neustart
  // (Zähler und Laufzeit beginnen bei 0), vor ~2,5 Tagen 5 Std. ohne Messung (Lücke). Verkehr schwankt über den Tag.
  const telem = [];
  { const now = Date.now(); const boot = now - 3 * 86400000 - 1800000;
    let recv = 9000; let sent = 6000; let up = 5 * 86400;
    for (let i = 0; i < 7 * 24; i++) {
      const t = now - (7 * 24 - i) * 3600000 + 600000;
      const hr = new Date(t).getHours();
      const rate = Math.round(40 + 30 * Math.sin(((hr - 6) / 24) * 2 * Math.PI));
      if (t >= boot && t - 3600000 < boot) { recv = Math.round(((t - boot) / 3600000) * rate); sent = Math.round(recv * 0.6); up = Math.round((t - boot) / 1000); } else { recv += rate; sent += Math.round(rate * 0.6); up += 3600; }
      if (i >= 100 && i < 105) continue; // Lücke
      telem.push(
        { telemetryType: 'mc_status_battery_volts', value: 3.9 + 0.15 * Math.sin(i / 8), timestamp: t },
        { telemetryType: 'mc_status_noise_floor', value: -110 - 4 * Math.cos(i / 5), timestamp: t },
        { telemetryType: 'mc_status_packets_recv', value: recv, timestamp: t },
        { telemetryType: 'mc_status_packets_sent', value: sent, timestamp: t },
        { telemetryType: 'mc_status_uptime_secs', value: up, timestamp: t },
      );
    }
    globalThis.mockCounters = { recv, sent, up, at: now };
  }
  channels.length = 0;
  // psk wie MeshMonitor (Hex): Public = bekannter Schlüssel, #test = aus dem Namen, clubhaus und #geheim = eigener Schlüssel
  const tagPsk = (n) => crypto.createHash('sha256').update(n).digest('hex').slice(0, 32);
  channels.push({ id: 0, name: 'Public', displayName: 'Public', scope: 'de', psk: '8b3387e9c5cdea6ac9e5edbaa115cd72', protocol: 'meshcore' },
    { id: 4, name: '#test', displayName: '#test', scope: 'de', psk: tagPsk('#test'), protocol: 'meshcore' },
    { id: 10, name: 'clubhaus', displayName: 'clubhaus', scope: 'de-nord', psk: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', protocol: 'meshcore' },
    { id: 11, name: '#geheim', displayName: '#geheim', scope: 'de', psk: Buffer.from('0f1e2d3c4b5a69788796a5b4c3d2e1f0', 'hex').toString('base64'), protocol: 'meshcore' });
  messages = [];
  let n = 0;
  const mk = (o) => { const t = Date.now() - 600000 + (n++) * 20000; messages.push({ protocol: 'meshcore', id: `${t}-x${n}`, fromNodeId: null, fromNodeNum: null, fromPublicKey: null, fromName: null, toNodeId: '!ffffffff', toPublicKey: null, text: '', channel: 0, messageType: 'text', timestamp: t, rxSnr: 10, rxRssi: -80, hopCount: 3, routePath: null, delivered: false, deliveredAt: null, createdAt: t, ...o }); };
  mk({ fromName: 'Alex', text: 'test', channel: 4 });
  mk({ fromName: 'Echo-Bot', text: '👋@[Alex]|5 Hops bis Bergdorf', channel: 4 });
  mk({ fromName: 'Chris Mobil', text: '@[Mesh@Home🤖] hörst du mich?', channel: 0 });
  mk({ fromName: 'Alex', text: 'Treffpunkt 📍 51.22012, 9.99310 – Plan unter https://example.org/plan.', channel: 0 });
  mk({ fromName: 'Mesh-Mobil🤖', text: 'Test vom zweiten Node', channel: 0 });
  mk({ id: `sent-${Date.now() - 100000}-a`, fromNodeId: `mc:${MEPK}`, fromPublicKey: MEPK, fromName: 'Mesh@Home🤖', text: '@[Chris Mobil] ja, laut und klar', channel: 0, hopCount: null });
  mk({ fromNodeId: `mc:${pk('b').slice(0, 12)}`, fromName: 'R2-D2', toNodeId: `mc:${MEPK}`, toPublicKey: MEPK, text: 'BrrrrPeep - Hello Master Max 👋', channel: -1 });
  mk({ id: `sent-${Date.now() - 50000}-b`, fromNodeId: `mc:${MEPK}`, fromPublicKey: MEPK, fromName: 'Mesh@Home🤖', toNodeId: `mc:${pk('b')}`, toPublicKey: pk('b'), text: 'Ping', channel: -1, hopCount: null });
  mk({ fromName: '??', text: 'kaputt', channel: 52062 });
  messages.reverse(); // neueste zuerst wie das Original
  // Viele Nodes für die Karte: MOCK_NODES=600 verteilt so viele Repeater/Companions rund um Düsseldorf
  for (let i = 0; i < Number(process.env.MOCK_NODES || 0); i++) {
    const key = (i.toString(16).padStart(4, '0') + 'f'.repeat(60)).slice(0, 64);
    const t = [2, 2, 2, 2, 1, 3][i % 6];
    nodes.push({ nodeId: `mc:${key}`, publicKey: key, longName: `${t === 2 ? 'RPT' : t === 3 ? 'Room' : 'Node'} ${i}`, advType: t, lastHeard: Math.floor(Date.now() / 1000) - (i % 50) * 600,
      latitude: 50.8 + ((i * 7919) % 1000) / 1000 * 0.9, longitude: 9.5000 + ((i * 104729) % 1000) / 1000 * 1.3 });
  }
  // Lasttest: MOCK_BULK=60000 legt so viele Kanalnachrichten über 30 Tage verteilt an
  if (Number(process.env.MOCK_BULK) > 0) {
    const N = Number(process.env.MOCK_BULK); const now = Date.now();
    for (let i = 0; i < N; i++) {
      const t = now - 3600000 - Math.floor((i / N) * 30 * 86400000);
      messages.push({ protocol: 'meshcore', id: `${t}-bulk${i}`, fromName: `Bot ${i % 40}`, toNodeId: '!ffffffff', text: `Massennachricht ${i}`, channel: 0, timestamp: t, createdAt: t, hopCount: i % 5, routePath: i % 3 ? 'b4,b3' : null, scopeCode: 0x1a2b, scopeName: 'de-nord', reactionEmoji: i % 50 === 0 ? '👍' : null });
    }
  }
  // Verlauf der letzten 10 Tage (für die Statistik rückwirkend)
  {
    const names = ['Alex', 'Chris Mobil', 'Echo-Bot', 'Joe Mobil', 'Bob Handy'];
    const mid = new Date(); mid.setHours(0, 0, 0, 0);
    for (let d = 1; d <= 10; d++) {
      for (let i = 0; i < 3 + ((d * 7) % 9); i++) {
        const t = mid.getTime() - d * 86400000 + (6 + ((i * 5 + d) % 16)) * 3600000 + i * 60000;
        messages.push({ protocol: 'meshcore', id: `${t}-h${d}-${i}`, fromNodeId: null, fromPublicKey: null, fromName: names[(i + d) % names.length], toNodeId: '!ffffffff', text: `Verlauf Tag -${d} Nr. ${i}`, channel: [0, 4, 10][(i + d) % 3], messageType: 'text', timestamp: t, hopCount: 1 + (i % 4), routePath: ['b4', 'b4,b3', 'b46f,b3f8,7a', null][i % 4], delivered: false, createdAt: t });
      }
    }
  }
  http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const J = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    // Testhilfe: neue eingehende Nachricht erzeugen (/mock/inject?type=dm|mention|channel)
    // Testhilfen für den Repeater-Wächter: Akku setzen bzw. Repeater "verstummen" lassen
    if (url.pathname === '/mock/battery') {
      telem.push({ telemetryType: 'mc_status_battery_volts', value: Number(url.searchParams.get('v')), timestamp: Date.now() });
      return J(200, { ok: true });
    }
    if (url.pathname === '/mock/silent') {
      const n = nodes.find((x) => x.longName === url.searchParams.get('name'));
      if (n) n.lastHeard = Math.floor(Date.now() / 1000) - Number(url.searchParams.get('h') || 10) * 3600;
      return J(200, { ok: Boolean(n) });
    }
    if (url.pathname === '/mock/inject') {
      const t = Date.now(); const type = url.searchParams.get('type');
      const base = { protocol: 'meshcore', id: `${t}-inj`, fromNodeNum: null, fromPublicKey: null, toPublicKey: null, messageType: 'text', timestamp: t - 7 * 60000, createdAt: t, delivered: false, hopCount: 2, routePath: type === 'mention' ? 'b46f,b3f8' : 'b4,b3', scopeCode: type === 'dm' ? 0 : type === 'mention' ? 0x3fa1 : 0x1a2b, scopeName: type === 'channel' ? 'de-nord' : null };
      if (type === 'react') {
        const mine = messages.find((x) => /^sent-/.test(x.id) && !x.reactionEmoji && x.channel >= 0);
        messages.unshift({ ...base, id: `${t}-rx`, fromNodeId: null, fromName: 'Chris Mobil', toNodeId: '!ffffffff', text: '👍', channel: mine.channel, reactionEmoji: '👍', reactionTargetId: mine.id });
        return J(200, { ok: true, target: mine.text });
      }
      if (type === 'dm') messages.unshift({ ...base, fromNodeId: `mc:${pk('b').slice(0, 12)}`, fromName: 'R2-D2', toNodeId: `mc:${MEPK}`, text: 'Neue DM für dich 🚀', channel: -1 });
      else if (type === 'mention') messages.unshift({ ...base, fromNodeId: null, fromName: 'Chris Mobil', toNodeId: '!ffffffff', text: '@[Mesh@Home🤖] bist du da?', channel: 4 });
      else messages.unshift({ ...base, fromNodeId: null, fromName: 'Alex', toNodeId: '!ffffffff', text: 'normale Kanalnachricht', channel: 4 });
      // Passende Pakete mit Weg (erste Kopie = angekommene Nachricht, zweite über einen anderen Weg)
      const m0 = messages[0];
      const pkt = (dt, path) => packets.unshift({ protocol: 'meshcore', id: pkid++, timestamp: t + dt, snr: 7.5,
        ...(m0.channel === -1 ? { payload_type: 2, payload_type_name: 'TXT_MSG', src_hash: 'bb', route_type_name: 'FLOOD' }
          : { payload_type: 5, payload_type_name: 'GRP_TXT', plaintext: `${m0.fromName}: ${m0.text}`, route_type_name: 'FLOOD' }), path_hops: path });
      pkt(-300, ['b4', 'b3']); pkt(900, ['b4', 'b3', '7a']);
      return J(200, { ok: true });
    }
    // /api/health: Version nur für angemeldete Aufrufer (wie MeshMonitor); MOCK_MMVER=4.17.2 testet die alten Grenzen
    if (url.pathname === '/api/health') return J(200, req.headers.authorization === `Bearer ${TOKEN}` ? { status: 'ok', version: process.env.MOCK_MMVER || '4.17.3' } : { status: 'ok' });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return J(401, { success: false, error: { message: 'Invalid token' } });
    const b = '/api/v1/sources/mc1';
    if (url.pathname === '/api/v1/sources') return J(200, { success: true, data: [{ id: 'mc1', name: 'Mesh@Home', type: 'meshcore', isPrimary: true }, { id: 'v3', name: 'Mesh-Mobil', type: 'meshcore', enabled: true, isPrimary: false }] });
    if (url.pathname === '/api/v1/sources/v3/messages') return J(200, { success: true, data: [{ protocol: 'meshcore', id: 'sent-1', fromName: 'Mesh-Mobil🤖', toNodeId: '!ffffffff', text: 'Hallo von V3', channel: 0, createdAt: Date.now() - 5000, timestamp: Date.now() - 5000 }] });
    if (url.pathname === '/api/v1/sources/v3/nodes') return J(200, { success: true, data: [{ nodeId: 'mc:' + 'a'.repeat(64), publicKey: 'a'.repeat(64), isLocalNode: true, longName: null }, { nodeId: 'mc:' + 'c'.repeat(64), publicKey: 'c'.repeat(64), longName: 'Nur-V3-Kontakt', advType: 1, isFavorite: true }] });
    if (url.pathname === '/api/v1/sources/v3/channels') return J(200, { success: true, data: [{ id: 0, name: 'Public' }, { id: 1, name: '#v3-kanal' }] });
    if (url.pathname === '/api/v1/sources/v3/status') return J(200, { success: true, data: {} });
    if (url.pathname === '/api/v1/sources/v3/packets') return J(200, { success: true, total: 0, data: [] });
    if (url.pathname === `${b}/nodes`) return J(200, { success: true, data: nodes.map((x) => ({ ...x, protocol: 'meshcore' })) });
    if (url.pathname === `${b}/channels`) return J(200, { success: true, data: channels });
    if (url.pathname === `${b}/status`) return J(200, { success: true, data: { localNodeId: null, connected: true } });
    if (url.pathname === `${b}/messages` && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      const ch = url.searchParams.get('channel');
      // wie MeshMonitor v1: Reaktionen nie, channel=-1 = nur DMs
      return J(200, { success: true, count: 0, data: messages.filter((m) => m.createdAt > since && !m.reactionEmoji && (ch == null || (Number(ch) === -1 ? m.channel === -1 : m.channel === Number(ch)))).slice(0, Number(url.searchParams.get('limit') || 100)) });
    }
    if (url.pathname === `${b}/packets`) {
      const sp = url.searchParams;
      const since = Number(sp.get('since') || 0); const off = Number(sp.get('offset') || 0); const lim = Number(sp.get('limit') || 100);
      const pt = sp.get('payload_type'); const rt = sp.get('route_type'); const ph = sp.get('path_hash'); const sh = sp.get('src_hash'); const snd = sp.get('sender'); const sq = sp.get('search')?.toLowerCase();
      const f = packets.map(mockRaw).filter((x) => x.timestamp > since && (pt == null || x.payload_type === Number(pt)) && (rt == null || x.route_type === Number(rt))
        && (!ph || (x.path_hops || []).includes(ph)) && (!sh || x.src_hash === sh) && (!snd || (x.sender_public_key || '').startsWith(snd))
        && (!sq || `${x.advert_name || ''} ${x.plaintext || ''} ${x.payload_type_name}`.toLowerCase().includes(sq)));
      return J(200, { success: true, total: f.length, offset: off, limit: lim, data: f.slice(off, off + lim).map(({ _pl, ...x }) => x) });
    }
    if (url.pathname === `${b}/messages` && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c; const q = JSON.parse(body);
      console.log('[mock-mc] send', q);
      // Grenzen wie 4.17.3: DM 160, Kanal 160 − Name − 2 ("Mesh@Home🤖" = 13 Bytes → 145); geteilt wird nie
      const cap = q.toNodeId ? 160 : 160 - Buffer.byteLength('Mesh@Home🤖') - 2;
      if (Buffer.byteLength(q.text) > cap) return J(413, { success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: `Message exceeds the MeshCore maximum of ${cap} bytes; MeshCore messages are not split` } });
      const t = Date.now();
      messages.unshift({ protocol: 'meshcore', id: `sent-${t}-z`, fromNodeId: `mc:${MEPK}`, fromPublicKey: MEPK, fromName: 'Mesh@Home🤖', toNodeId: q.toNodeId || '!ffffffff', text: q.text, channel: q.toNodeId ? -1 : q.channel, delivered: false, createdAt: t, timestamp: t, hopCount: null, scopeName: q.toNodeId ? null : (q.scope ?? 'de') || null, scopeCode: q.toNodeId ? null : (q.scope === '' ? 0 : 0x1111) });
      // DM: ACK nach 4 s wie MeshMonitor im MeshCore-Teil (deliveryStatus); "#noack" = nach 8 s fehlgeschlagen
      if (q.toNodeId) {
        const mm = messages[0]; mm.deliveryStatus = 'sent';
        setTimeout(() => { if (q.text.includes('#noack')) mm.deliveryStatus = 'failed'; else { mm.deliveryStatus = 'delivered'; mm.roundTripMs = 2345; } }, q.text.includes('#noack') ? 8000 : 4000);
        // gehört von (ab 4.17.3 im MeshCore-Teil als heardBy); "#noheard" = keiner
        if (!q.text.includes('#noheard')) setTimeout(() => { mm.heardBy = [{ hash: 'b4', name: 'RPT Mitte', snr: 7.5, hops: 1 }, { hash: 'b3', name: null, snr: 3.25, hops: 2 }]; }, 2000);
      }
      if (!q.toNodeId) {
        // Wie MeshMonitor: eigene Aussendung (ohne Weg) und Echos der Repeater, alle mit denselben verschlüsselten Bytes.
        // "#noecho" = keine Echos (z. B. für Resend-Tests); "#clash" = jemand anderes schreibt gleichzeitig denselben Text
        const m = messages[0];
        grpPacket(m, 300, [], null);
        if (!q.text.includes('#noecho')) { grpPacket(m, 1500, ['b46f'], 11.75); grpPacket(m, 2500, ['b3f8'], 12.25); grpPacket(m, 3500, ['b3f8', 'fd67'], -7.75); }
        if (q.text.includes('#clash')) grpPacket({ ...m, id: `${m.id}-fremd`, fromName: 'Alex' }, 2000, ['c4c4'], 4);
      }
      return J(201, { success: true, data: { messageId: `sent-${t}-z`, deliveryState: 'pending' } });
    }
    // MeshCore-REST (nicht v1): Scope, Regionen, Advert, Resend, Reaktionen, Kontakt-Werkzeuge, Rooms
    const mc = '/api/sources/mc1/meshcore';
    const RP1 = 'b46f' + '1'.repeat(60); const RP2 = 'b3f8' + '2'.repeat(60); const ROOM = 'c4'.repeat(32);
    const fv = /^\/api\/sources\/mc1\/meshcore\/nodes\/([0-9a-f]{64})\/favorite$/.exec(url.pathname);
    if (fv && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c; const q = JSON.parse(body || '{}');
      const n = nodes.find((x) => x.publicKey === fv[1]); if (n) n.isFavorite = q.isFavorite;
      return J(200, { success: true, data: { isFavorite: q.isFavorite } });
    }
    // Kontaktliste des Companions (Repeater-Joe "Bob Handy" ist absichtlich KEIN Kontakt auf dem Gerät)
    if (url.pathname === `${mc}/contacts` && req.method === 'GET') {
      globalThis.cp ||= {};
      const list = nodes.filter((x) => x.publicKey && !x.isLocalNode && x.longName !== 'Bob Handy')
        .map((x) => ({ publicKey: x.publicKey, advName: x.longName, advType: x.advType, ...(globalThis.cp[x.publicKey] ?? { outPath: 'b3,b4', pathLen: 2 }) }));
      list.unshift({ publicKey: MEPK, advName: 'Mesh@Home (local)', name: 'Mesh@Home', latitude: 51.2112, longitude: 9.9702, advType: 1, isLocal: true });
      return J(200, { success: true, data: list, count: list.length });
    }
    const ct = /^\/api\/sources\/mc1\/meshcore\/contacts\/([0-9a-f]{64})(?:\/([a-z-]+))?$/.exec(url.pathname);
    if (ct) {
      const [, key, act] = ct;
      globalThis.cp ||= {};
      const cur = globalThis.cp[key] ?? { outPath: 'b3,b4', pathLen: 2 };
      // Wie MeshMonitor: KEIN Einzelabruf eines Kontakts (nur die Liste GET /contacts)
      if (!act) return J(404, { success: false, error: 'Not found' });
      if (act === 'out-path' && req.method === 'PUT') {
        let body = ''; for await (const c of req) body += c; const q = JSON.parse(body || '{}');
        globalThis.cp[key] = { outPath: q.outPath, pathLen: q.outPath ? q.outPath.split(',').length : 0 };
        console.log('[mock-mc] out-path', key.slice(0, 6), q);
        return J(200, { success: true, ackConfirmed: true });
      }
      if (act === 'trace-path' && req.method === 'POST') {
        let body = ''; for await (const c of req) body += c; const q = JSON.parse(body || '{}');
        await new Promise((r) => setTimeout(r, 1200));
        const out = cur.pathLen > 0 ? cur.outPath.split(',') : [];
        const tok = key.slice(0, (out[0]?.length || 2));
        if (key.startsWith('c4')) { await new Promise((r) => setTimeout(r, 4000)); return J(504, { success: false, error: { code: 'MESHCORE_TRACE_TIMEOUT', message: 'No reply within 8 s.' } }); } // Room antwortet nie
        if (out.includes('7a')) return J(504, { success: false, error: { code: 'MESHCORE_TRACE_TIMEOUT', message: 'No reply' } });
        const outbound = [...out, tok];
        const path = q.autoReturn ? [...outbound, ...[...outbound].reverse().slice(1)] : out;
        return J(200, { success: true, hops: path.map((_, i) => ({ index: i, snr: 9 - i * 2.25 })), lastSnr: 4.5, path });
      }
      if (act === 'reset-path') { globalThis.cp[key] = { outPath: '', pathLen: -1 }; return J(200, { success: true }); }
      if (act === 'discover-path') { setTimeout(() => { globalThis.cp[key] = { outPath: 'b4', pathLen: 1 }; }, 2000); return J(200, { success: true, data: { suggestedTimeoutMs: 5000 } }); }
      if (act === 'ping') { await new Promise((r) => setTimeout(r, 800)); return key === RP1 ? J(200, { success: true, data: { hopHash: 'b4', rttMs: 412, snrToTarget: 8.25, snrFromTarget: 6.5 } }) : J(504, { success: false, error: 'No reply', code: 'MESHCORE_PING_TIMEOUT' }); }
      if (act === 'neighbours') { await new Promise((r) => setTimeout(r, 1000)); return J(200, { success: true, data: { total: 2, neighbours: [{ publicKeyPrefix: 'b3f822', fullPublicKey: RP2, name: 'RPT Hafen', snr: 9.5, heardSecondsAgo: 120 }, { publicKeyPrefix: '9999', fullPublicKey: MEPK, name: 'Mesh@Home', snr: -3.25, heardSecondsAgo: 30 }] } }); }
    }
    if (url.pathname === `${mc}/neighbors`) return J(200, { success: true, data: { items: [{ publicKey: RP1, neighborPublicKey: RP2, snr: 7.75, lastHeardSecs: 600, timestamp: Date.now() - 3600000, neighborName: 'RPT Hafen' }].filter((i) => !url.searchParams.get('node') || i.publicKey === url.searchParams.get('node')) } });
    globalThis.room ||= { in: false, posts: [{ id: 'r1', text: 'Treffen am Samstag 14 Uhr', fromName: 'Chris Mobil', receivedAt: Date.now() - 7200000 }, { id: 'r2', text: 'Bin dabei 👍', fromName: 'Joe Mobil', receivedAt: Date.now() - 3600000 }] };
    if (url.pathname === `${mc}/rooms/servers`) return J(200, { success: true, data: [{ publicKey: ROOM, advName: 'Clubhaus-Brett', lastSeen: Date.now() - 120000, snr: 6, loggedIn: globalThis.room.in }] });
    if ((url.pathname === `${mc}/rooms/login` || url.pathname === `${mc}/rooms/login-with-saved`) && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c; const q = JSON.parse(body || '{}');
      if (url.pathname.endsWith('login') && q.password !== 'geheim' && q.password !== '') return J(200, { success: false, error: 'Login failed' });
      globalThis.room.in = true; return J(200, { success: true, data: { loggedIn: true } });
    }
    if (url.pathname === `${mc}/messages/room/${ROOM}`) return J(200, { success: true, data: globalThis.room.posts }); // 4.17.3: gespeicherte Beiträge auch ohne Login
    if (url.pathname === `${mc}/rooms/post` && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c; const q = JSON.parse(body || '{}');
      globalThis.room.posts.push({ id: `sent-${Date.now()}`, text: q.text, fromPublicKey: MEPK, receivedAt: Date.now() });
      return J(200, { success: true, message: 'Room post sent' });
    }
    // Kanal-Verlauf mit Blättern (wie MeshMonitor: neueste Seite zuerst, innerhalb der Seite älteste zuerst)
    const chm = /^\/api\/sources\/mc1\/meshcore\/messages\/channel\/(\d+)$/.exec(url.pathname);
    if (chm) {
      if (process.env.MOCK_DENY_CH && Number(chm[1]) === Number(process.env.MOCK_DENY_CH)) return J(403, { success: false, error: 'Insufficient permissions', required: { resource: `channel_${chm[1]}`, action: 'read' } });
      const idx = Number(chm[1]); const lim = Math.min(1000, Number(url.searchParams.get('limit') || 100)); const off = Number(url.searchParams.get('offset') || 0);
      const all = messages.filter((x) => x.channel === idx).sort((x, y) => y.createdAt - x.createdAt);
      const page = all.slice(off, off + lim + 1); const hasMore = page.length > lim;
      const rows = page.slice(0, lim).reverse().map((x) => ({ id: x.id, fromPublicKey: `channel-${idx}`, fromName: x.fromName, text: x.text, timestamp: x.timestamp, receivedAt: x.createdAt, hopCount: x.hopCount ?? null, routePath: x.routePath ?? null, snr: x.rxSnr, rssi: x.rxRssi, scopeCode: x.scopeCode ?? null, scopeName: x.scopeName ?? null, reactionEmoji: x.reactionEmoji ?? null, reactionTargetId: x.reactionTargetId ?? null }));
      return J(200, { success: true, data: rows, count: rows.length, hasMore });
    }
    if (url.pathname === `${mc}/messages` && req.method === 'GET') return J(200, { success: true, data: messages.slice(0, Number(url.searchParams.get('limit') || 50)) });
    const rr = /^\/api\/sources\/mc1\/meshcore\/messages\/([^/]+)\/reaction$/.exec(url.pathname);
    if (rr && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c; const q = JSON.parse(body || '{}');
      const target = messages.find((x) => x.id === decodeURIComponent(rr[1]));
      if (!target) return J(404, { success: false, error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
      const t = Date.now();
      messages.unshift({ protocol: 'meshcore', id: `sent-${t}-r`, fromNodeId: `mc:${MEPK}`, fromPublicKey: MEPK, fromName: 'Mesh@Home🤖', toNodeId: target.channel === -1 ? target.fromNodeId : '!ffffffff', text: q.emoji, channel: target.channel, createdAt: t, timestamp: t, reactionEmoji: q.emoji, reactionTargetId: target.id });
      return J(200, { success: true, data: { id: `sent-${t}-r` } });
    }
    if (url.pathname === `${mc}/config/default-scope`) return J(200, { success: true, scope: 'de' });
    if (url.pathname === `${mc}/saved-regions`) return J(200, { success: true, regions: [{ id: 1, name: 'de-nord' }, { id: 2, name: 'de' }, { id: 3, name: 'nl' }] });
    if (url.pathname === `${mc}/advert` && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c; console.log('[mock-mc] advert', body);
      return J(200, { success: true, data: { mode: JSON.parse(body || '{}').mode } });
    }
    // Repeater-Verwaltung wie MeshMonitor (…/meshcore/admin/*): Passwort "admin" = Admin, "" = Gast,
    // "noreply" = keine Antwort, sonst abgelehnt. Befehle nur mit Admin-Sitzung; gefährliche nur mit confirm.
    const am = /^\/api\/sources\/mc1\/meshcore\/admin\/(session|status)\/([0-9a-f]{64})$/.exec(url.pathname);
    const A = globalThis.mockAdmin || (globalThis.mockAdmin = { sessions: new Set(), saved: new Map(), conf: new Map() });
    const later = (ms, fn) => new Promise((r) => setTimeout(() => r(fn()), ms));
    const readJson = async () => { let body = ''; for await (const c of req) body += c; return JSON.parse(body || '{}'); };
    if (url.pathname === `${mc}/admin/credentials-capability`) return J(200, { success: true, data: { canRemember: true } });
    if (am && am[1] === 'session' && req.method === 'GET') return J(200, { success: true, data: A.sessions.has(am[2]) ? { active: true, loggedInAt: Date.now() - 600000, isAdmin: true } : { active: false, reason: 'none' } });
    if (am && am[1] === 'session' && req.method === 'DELETE') { A.sessions.delete(am[2]); return J(200, { success: true }); }
    if (am && am[1] === 'status') {
      if (!A.sessions.has(am[2])) return later(1500, () => J(404, { success: false, error: 'No status received' }));
      return later(1500, () => J(200, { success: true, data: { batteryMv: 4040, uptimeSecs: 682562, queueLen: 0, noiseFloor: -95, lastRssi: -56, lastSnr: 12.75, packetsRecv: 243396, packetsSent: 42298, airTimeSecs: 33377, rxAirTimeSecs: 198189, sentFlood: 32607, sentDirect: 9691, recvFlood: 219978, recvDirect: 23186, errors: 0, floodDups: 51234, directDups: 812, recvErrors: 17 } }));
    }
    if ((url.pathname === `${mc}/admin/login` || url.pathname === `${mc}/admin/login-with-saved`) && req.method === 'POST') {
      const q = await readJson(); const pkq = String(q.publicKey || '');
      const saved = url.pathname.endsWith('-with-saved');
      if (saved && !A.saved.has(pkq)) return J(404, { success: false, error: 'No saved credential for this node', code: 'NO_STORED_CREDENTIAL' });
      const pw = saved ? A.saved.get(pkq) : String(q.password ?? '');
      console.log('[mock-mc] admin login', pkq.slice(0, 8), saved ? '(gespeichert)' : '');
      if (pw === 'noreply') return later(3000, () => J(401, { success: false, error: 'Login failed', reason: 'no_reply', attempts: 3 }));
      if (pw !== 'admin' && pw !== '') return later(1500, () => J(401, { success: false, error: 'Login failed', reason: 'rejected', attempts: 1 }));
      return later(2000, () => {
        if (pw === 'admin') A.sessions.add(pkq); else A.sessions.delete(pkq);
        if (q.rememberPassword) A.saved.set(pkq, pw);
        return J(200, { success: true, message: 'Login successful', persisted: Boolean(q.rememberPassword) });
      });
    }
    if (url.pathname === `${mc}/admin/cli` && req.method === 'POST') {
      const q = await readJson(); const pkq = String(q.publicKey || ''); const cmd = String(q.command || '').trim();
      console.log('[mock-mc] admin cli', pkq.slice(0, 8), cmd);
      if (/\b(reboot|erase|clkreboot|factory|poweroff|shutdown)\b(?!\.)|\bset\s+prv\.key\b/i.test(cmd) && q.confirm !== true) return J(400, { success: false, error: 'Destructive command requires confirm:true in the request body', code: 'DANGER_CONFIRM_REQUIRED' });
      if (!A.sessions.has(pkq)) return later(4000, () => J(504, { success: false, error: 'CLI command timed out', code: 'CLI_TIMEOUT' }));
      const c = A.conf.get(pkq) || { name: 'RPT Mitte', repeat: 'on', 'advert.interval': '0', 'flood.advert.interval': '12', lat: '51.2277', lon: '10.0735', 'guest.password': '' };
      A.conf.set(pkq, c);
      const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
      let reply;
      const m = /^(get|set)\s+(\S+)(?:\s+(.*))?$/i.exec(cmd);
      if (cmd === 'ver') reply = 'v1.12.0 (Build: 03-Okt-2026)';
      else if (cmd === 'clock') reply = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} - ${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()} UTC`;
      else if (cmd === 'clock sync') reply = 'OK - clock set';
      else if (cmd === 'advert') reply = 'OK - Advert sent';
      else if (cmd === 'neighbors') reply = 'RPT Hafen  SNR: 9.5 dB  heard: 3m ago\nRPT Nordhang  SNR: -4.2 dB  heard: 1h12m ago';
      else if (/^reboot$/i.test(cmd)) reply = '';
      else if (m && m[1].toLowerCase() === 'get') reply = m[2] === 'radio' ? '> 869.618,62.5,8,8' : m[2] in c ? `> ${c[m[2]]}` : '??: unknown config';
      else if (m && m[1].toLowerCase() === 'set') { if (m[2] in c) { c[m[2]] = m[3] || ''; reply = 'OK'; } else reply = 'unknown config: ' + m[2]; }
      else if (/^password\s+/.test(cmd)) reply = 'password now: ********';
      else reply = 'Unknown command';
      return later(1200, () => J(200, { success: true, data: { reply, elapsedMs: 1180 } }));
    }
    const rs = /^\/api\/sources\/mc1\/meshcore\/messages\/([^/]+)\/resend$/.exec(url.pathname);
    if (rs && req.method === 'POST') {
      const id = decodeURIComponent(rs[1]); const m = messages.find((x) => x.id === id);
      console.log('[mock-mc] resend', id);
      if (!m) return J(404, { success: false, error: 'Message not found', code: 'MESSAGE_NOT_FOUND' });
      m.resends = (m.resends || 0) + 1;
      // Resend: gleiche Bytes wie das Original -> eigene Aussendung und Echos; dazu ein fremder Absender mit demselben Text (darf nicht zählen)
      if (m.channel >= 0) {
        grpPacket(m, 300, [], null); grpPacket(m, 1500, ['b46f'], 10); grpPacket(m, 2600, ['b46f', '7a7a'], -3.5);
        grpPacket({ ...m, id: `${m.id}-fremd`, fromName: 'Alex' }, 2000, ['b3f8'], 6);
      }
      return J(200, { success: true, data: { id, resendCount: m.resends, lastResendAt: Date.now() } });
    }
    // Node-Details (Status, Telemetrie, Traceroute, Nachbarn)
    const RPT = 'b46f' + '1'.repeat(60);
    if (url.pathname === `${b}/actions/request-telemetry` && req.method === 'POST') {
      if (Date.now() - (globalThis.lastTx || 0) < 60000) return J(429, { success: false, error: 'Too soon', code: 'RATE_LIMITED', retryAfter: 42 });
      globalThis.lastTx = Date.now();
      await new Promise((r) => setTimeout(r, 1500));
      { const c = globalThis.mockCounters; const h = (Date.now() - c.at) / 3600000; const add = Math.round(h * 45);
        telem.push(...['battery_volts', 'uptime_secs', 'noise_floor', 'packets_recv', 'packets_sent'].map((k, i) => ({ telemetryType: `mc_status_${k}`, value: [4.05, Math.round(c.up + h * 3600), -112, c.recv + add, c.sent + Math.round(add * 0.6)][i], timestamp: Date.now() }))); }
      return J(200, { success: true, data: { written: 5, type: 'status', protocol: 'meshcore' } });
    }
    if (url.pathname.startsWith(`${b}/telemetry/`)) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const since = Number(url.searchParams.get('since') || 0);
      return J(200, { success: true, data: id === `mc:${RPT}` ? telem.filter((t) => t.timestamp >= since) : [] });
    }
    if (url.pathname === `${b}/actions/traceroute` && req.method === 'POST') {
      // 4.17.3: Trace ohne Rückweg-Palindrom; letzte Zeile = dein Funkgerät hört den letzten Hop
      setTimeout(() => traces.unshift({ protocol: 'meshcore', fromNodeId: `mc:${MEPK}`, toNodeId: `mc:${RPT}`, timestamp: Date.now(),
        hops: [{ index: 0, publicKey: null, hash: 'b3', snr: 9.25 }, { index: 1, publicKey: RPT, hash: 'b4', snr: 6.5 }, { index: 2, publicKey: MEPK, hash: MEPK.slice(0, 2), snr: 5 }] }), 4000);
      return J(200, { success: true, data: { message: 'Traceroute request sent' } });
    }
    // wie 4.17.3: erst die neuesten <limit> Traces der Quelle, DANN nach toNodeId filtern
    if (url.pathname === `${b}/traceroutes`) return J(200, { success: true, data: traces.slice(0, Number(url.searchParams.get('limit') || 100)).filter((t) => !url.searchParams.get('toNodeId') || t.toNodeId === url.searchParams.get('toNodeId')) });
    if (url.pathname === `${b}/network/direct-neighbors`) return J(200, { success: true, data: { x: { publicKey: RPT, bestSnr: 8.5, lastHeard: Date.now() - 600000, packetCount: 40 }, y: { publicKey: 'b3f8' + '2'.repeat(60), bestSnr: -7, lastHeard: Date.now() - 3600000, packetCount: 5 } } });
    return J(404, { success: false });
  }).listen(PORT, () => console.log(`Mock MeshMonitor (meshcore) auf :${PORT}`));
  return;
}

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
  const p = url.pathname;
  if (p === '/api/v1/sources') return json(res, 200, { success: true, data: { sources: [{ id: 'default', name: 'Heim-Node', type: 'meshtastic_tcp', enabled: true, isPrimary: true }] } });
  if (p === '/api/v1/sources/default/nodes') return json(res, 200, { success: true, data: nodes.map((n) => ({ ...n, protocol: 'meshtastic' })) });
  if (p === '/api/v1/sources/default/channels') return json(res, 200, { success: true, data: channels });
  if (p === '/api/v1/sources/default/status') return json(res, 200, { success: true, data: { connected: true, localNode: { nodeId: ME.nodeId } } });
  if (p === '/api/v1/sources/default/messages' && req.method === 'GET') {
    const limit = Number(url.searchParams.get('limit') || 100);
    return json(res, 200, { success: true, data: messages.slice(-limit) });
  }
  if (p === '/api/v1/sources/default/messages' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    const b = JSON.parse(body || '{}');
    console.log('[mock] send', b);
    if (!b.text) return json(res, 400, { success: false, error: { code: 'INVALID_INPUT', message: 'text required' } });
    const to = b.toNodeId ? nodes.find((n) => n.nodeId === b.toNodeId) || { nodeId: b.toNodeId, nodeNum: 1 } : null;
    const m = add(ME, to, b.channel ?? 0, b.text, { replyId: b.replyId ?? null, emoji: b.emoji ? 1 : 0, deliveryState: 'pending' });
    setTimeout(() => { m.deliveryState = 'delivered'; }, 4000);
    return json(res, 201, { success: true, data: { messageId: m.id, deliveryState: 'pending', messageCount: 1, text: m.text } });
  }
  return json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: p } });
}).listen(PORT, () => console.log(`Mock MeshMonitor auf :${PORT}, Token ${TOKEN}`));
