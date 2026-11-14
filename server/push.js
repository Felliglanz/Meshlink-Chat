'use strict';
/*
 * Web Push ohne Abhängigkeiten (RFC 8030 / 8291 aes128gcm / 8292 VAPID), nur node:crypto.
 * - VAPID-Schlüssel werden deterministisch aus SESSION_SECRET abgeleitet -> nichts zu speichern.
 * - Abonnements (max. 10) liegen in $STATE_DIRECTORY/push.json, sonst nur im Speicher.
 *   Je Abo (= Gerät) zusätzlich die Chat-Einstellungen "alle Nachrichten" / "stumm" (max. 100 Einträge)
 *   und die Einstellung des Repeater-Wächters (an/aus, Stunden ohne Empfang, Akku-Schwelle)
 *   sowie die Sprache des Geräts (Sprachcode, z. B. "de"), damit Push-Texte in seiner Sprache kommen.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_SUBS = 10;
const MAX_PREFS = 100;
// Chat-Einstellungen eines Geräts: { "<Quelle>|<Chat>": "all" | "mute" } – alles andere wird verworfen
// Repeater-Wächter: { on, hours (1–72), volts (2,5–4,5 V oder null = Akku nicht prüfen) }
function cleanWatch(w) {
  if (!w || typeof w !== 'object') return { on: false, hours: 6, volts: null };
  const hours = Math.min(72, Math.max(1, Math.round(Number(w.hours) || 6)));
  const v = Number(w.volts);
  return { on: w.on === true, hours, volts: Number.isFinite(v) && v >= 2.5 && v <= 4.5 ? Math.round(v * 100) / 100 : null };
}
function cleanPrefs(p) {
  const out = {};
  if (!p || typeof p !== 'object' || Array.isArray(p)) return out;
  for (const [k, v] of Object.entries(p).slice(0, MAX_PREFS)) {
    if (typeof k === 'string' && k.length <= 200 && (v === 'all' || v === 'mute')) out[k] = v;
  }
  return out;
}
// Sprachcode wie "de", "en" oder "pt-br"; alles andere wird verworfen
const cleanLang = (l) => (typeof l === 'string' && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(l) ? l.toLowerCase() : null);
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

function createPush({ secret, contact, stateDir, log = console }) {
  // ---- VAPID-Schlüssel (P-256), stabil über Neustarts
  let priv;
  let ecdh;
  for (let i = 0; ; i++) {
    priv = Buffer.from(crypto.hkdfSync('sha256', secret, 'meshlink-chat', `vapid-p256-${i}`, 32));
    try { ecdh = crypto.createECDH('prime256v1'); ecdh.setPrivateKey(priv); break; } catch { /* Skalar ungültig: nächster */ }
  }
  const pub = ecdh.getPublicKey(); // 65 Byte, unkomprimiert
  const signKey = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64u(priv), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) },
    format: 'jwk',
  });
  const publicKey = b64u(pub);

  // ---- Abonnements
  const file = stateDir ? path.join(stateDir, 'push.json') : null;
  let subs = [];
  if (file) {
    try { subs = JSON.parse(fs.readFileSync(file, 'utf8')).filter((s) => s?.endpoint && s?.keys?.p256dh && s?.keys?.auth).slice(-MAX_SUBS).map((s) => ({ ...s, prefs: cleanPrefs(s.prefs), watch: cleanWatch(s.watch), lang: cleanLang(s.lang) })); } catch { subs = []; }
  }
  function persist() {
    if (!file) return;
    try {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(subs), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) { log.error('[push] speichern fehlgeschlagen:', e.message); }
  }
  // prefs/watch/lang weggelassen = bisherige Einstellungen dieses Geräts behalten
  function add(sub, prefs, watch, lang) {
    if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('invalid subscription');
    const old = subs.find((s) => s.endpoint === sub.endpoint);
    subs = subs.filter((s) => s.endpoint !== sub.endpoint);
    subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, added: old?.added || Date.now(), prefs: prefs === undefined ? old?.prefs || {} : cleanPrefs(prefs), watch: watch === undefined ? old?.watch || cleanWatch(null) : cleanWatch(watch), lang: cleanLang(lang) || old?.lang || null });
    subs = subs.slice(-MAX_SUBS);
    persist();
  }
  function remove(endpoint) {
    const n = subs.length;
    subs = subs.filter((s) => s.endpoint !== endpoint);
    if (subs.length !== n) persist();
  }

  // ---- VAPID-JWT (ES256), pro Push-Dienst 12 h gecacht
  const jwtCache = new Map();
  function vapidHeader(endpoint) {
    const aud = new URL(endpoint).origin;
    const c = jwtCache.get(aud);
    if (c && c.exp - 3600 > Date.now() / 1000) return c.header;
    const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
    const data = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64u(JSON.stringify({ aud, exp, sub: contact }))}`;
    const sig = crypto.sign('sha256', Buffer.from(data), { key: signKey, dsaEncoding: 'ieee-p1363' });
    const header = `vapid t=${data}.${b64u(sig)}, k=${publicKey}`;
    jwtCache.set(aud, { exp, header });
    return header;
  }

  // ---- Inhalt verschlüsseln (RFC 8291, aes128gcm)
  function encrypt(sub, payload) {
    const uaPub = unb64u(sub.keys.p256dh);
    const auth = unb64u(sub.keys.auth);
    const as = crypto.createECDH('prime256v1');
    as.generateKeys();
    const asPub = as.getPublicKey();
    const shared = as.computeSecret(uaPub);
    const salt = crypto.randomBytes(16);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, keyInfo, 32));
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
    const header = Buffer.alloc(21);
    salt.copy(header, 0);
    header.writeUInt32BE(4096, 16);
    header.writeUInt8(asPub.length, 20);
    return Buffer.concat([header, asPub, body]);
  }

  async function sendOne(sub, data) {
    const body = encrypt(sub, Buffer.from(JSON.stringify(data)));
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidHeader(sub.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: 'high',
        ...(data.tag ? { Topic: crypto.createHash('sha1').update(data.tag).digest('base64url').slice(0, 32) } : {}),
      },
      body,
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404 || res.status === 410) { remove(sub.endpoint); return { ok: false, status: res.status, removed: true }; }
    if (!res.ok) log.error('[push]', res.status, (await res.text().catch(() => '')).slice(0, 200));
    return { ok: res.ok, status: res.status };
  }

  // skip(sub) entscheidet je Gerät (App gerade offen, Chat stumm, …); data darf eine Funktion (sub) => Inhalt sein,
  // dann bekommt jedes Gerät die Texte in seiner Sprache
  async function send(data, skip = () => false) {
    const results = await Promise.allSettled(subs.filter((s) => !skip(s)).map((s) => sendOne(s, typeof data === 'function' ? data(s) : data)));
    return results.map((r) => (r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason?.message }));
  }

  return {
    publicKey,
    persistent: Boolean(file),
    count: () => subs.length,
    list: () => subs.map((s) => ({ endpoint: s.endpoint, watch: s.watch || cleanWatch(null), lang: s.lang || null })),
    add,
    remove,
    send,
    _encrypt: encrypt, // für Tests
  };
}

module.exports = { createPush };
