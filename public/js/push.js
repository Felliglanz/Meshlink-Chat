/* MeshLink Chat – Web Push und Benachrichtigungen. */

import { LANG, T } from './core/i18n.js';
import { S, save } from './core/state.js';
import { api } from './core/api.js';
import { toast } from './ui.js';
import { convOf, convTitle, isMine, isOwnOther, mentionsMe, nodeName, targetOf } from './data.js';
import { convPref, isMuted } from './prefs.js';
import { go } from './nav.js';

// ------------------------------------------------------------------ Web Push

const pushSupported = () => window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function keyToBytes(b64) {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export async function subscribePush() {
  const reg = await navigator.serviceWorker.ready;
  const { key, persistent } = await api('/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  const want = keyToBytes(key);
  const cur = sub?.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
  if (sub && cur && (cur.length !== want.length || cur.some((v, i) => v !== want[i]))) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
  await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), prefs: S.convPrefs, watch: S.watch, lang: LANG } });
  S.pushEndpoint = sub.endpoint;
  return { persistent };
}

export async function enablePush() {
  if (!pushSupported()) {
    toast(window.isSecureContext ? T('push.unsupported') : T('push.https'));
    return;
  }
  const p = await Notification.requestPermission();
  if (p !== 'granted') { toast(T('push.denied')); return; }
  try {
    const { persistent } = await subscribePush();
    S.notify = true; save('notify', true);
    toast(persistent ? T('push.on') : T('push.onVolatile'));
    sendPresence(true);
  } catch (e) { toast(T('push.failed', { msg: e.message })); }
}

// Abo dieses Geräts beim Server und im Browser entfernen
export async function dropPushSubscription() {
  if (!pushSupported()) return;
  try {
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 2000))]);
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch { /* egal */ }
  S.pushEndpoint = null;
}

export async function disablePush() {
  await dropPushSubscription();
  S.notify = false; save('notify', false);
  toast(T('push.off'));
}

// Beim Start: Abo beim Server auffrischen (falls er es nach einem Neustart nicht mehr kennt)
export async function ensurePush() {
  if (!S.notify || !pushSupported() || Notification.permission !== 'granted') return;
  try { await subscribePush(); sendPresence(!document.hidden); } catch { /* still */ }
}

// Dem Server sagen, ob DIESES Gerät die App gerade offen hat (dann kein Push, sondern Hinweis in der App)
export function sendPresence(visible) {
  if (!S.pushEndpoint) return;
  fetch('/api/presence', {
    method: 'POST', credentials: 'same-origin', keepalive: true,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visible, endpoint: S.pushEndpoint }),
  }).catch(() => {});
}
setInterval(() => { if (!document.hidden) sendPresence(true); }, 30000);

export function notify(fresh) {
  const relevant = fresh.filter((m) => {
    if (isMine(m) || isOwnOther(m) || m.id.startsWith('tmp-')) return false;
    if (m.reaction) { const t = targetOf(m); return t && isMine(t) && !isMuted(convOf(t)); }
    if (isMuted(convOf(m))) return false;
    return m.dm || mentionsMe(m) || convPref(convOf(m)) === 'all';
  }).filter((m) => !(S.view === 'chat' && S.conv === convOf(m) && !document.hidden));
  if (!relevant.length) return;
  if (document.hidden) {
    if (S.pushEndpoint) return; // der Server schickt eine echte Push-Nachricht – nicht doppelt anzeigen
    if (!S.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
    navigator.serviceWorker?.ready.then((reg) => {
      for (const m of relevant.slice(-3)) {
        const key = convOf(m.reaction ? targetOf(m) : m);
        const title = m.reaction ? T('notif.reacted', { name: nodeName(m.from) }) : key.startsWith('dm:') ? nodeName(m.from) : T('notif.inConv', { name: nodeName(m.from), conv: convTitle(key) });
        reg.showNotification(title, {
          body: m.reaction ? T('notif.reactBody', { emoji: m.emoji, text: targetOf(m)?.text || '' }) : m.text,
          tag: key, renotify: true, icon: '/icons/icon-192.png', badge: '/icons/badge-96.png', data: { conv: key },
        });
      }
    });
  } else {
    const m = relevant[relevant.length - 1];
    if (m.reaction) return;
    const key = convOf(m);
    toast(`${key.startsWith('ch:') ? T('notif.inConv', { name: nodeName(m.from), conv: convTitle(key) }) : nodeName(m.from)}: ${m.text}`, () => go('chat', key));
  }
}
