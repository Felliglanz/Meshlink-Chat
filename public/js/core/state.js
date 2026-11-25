/* MeshLink Chat – Zustand der App (S), Version, localStorage. */
// Eigene Version (aus der URL dieses Moduls). Weicht die Server-Version ab, wurde neu ausgerollt -> neu laden.
export const APP_VERSION = (() => { try { return new URL(import.meta.url).searchParams.get('v'); } catch { return null; } })();
export function checkVersion(v) {
  if (!v || v === APP_VERSION) return;
  let last = null;
  try { last = sessionStorage.getItem('mc.reloadedFor'); sessionStorage.setItem('mc.reloadedFor', v); } catch { /* egal */ }
  if (last !== v) location.reload();
}

export function load(k, d) { try { const v = localStorage.getItem('mc.' + k); return v ? JSON.parse(v) : d; } catch { return d; } }
export function save(k, v) { try { localStorage.setItem('mc.' + k, JSON.stringify(v)); } catch { /* egal */ } }

export const S = {
  me: '', source: null, nodes: new Map(), channels: [],
  msgs: new Map(), byPacket: new Map(), names: new Map(), myNames: new Set(), otherNames: new Set(), otherSources: [],
  extraOwn: new Set(load('extraOwn', [])),
  expanded: new Set(),
  connected: false, error: null, sse: false,
  view: 'boot', conv: null, replyTo: null,
  sentIds: new Set(), pending: new Map(),
  lastRead: null, // Gelesen-Stand der aktuellen Quelle: {chat: ms}
  readBy: load('readBy', null), // je Quelle: {quelle: {chat: ms}} – Kanalnummern gibt es in jeder Quelle
  chSort: load('chSort', 'device'), // Reihenfolge der Kanäle (nur dieses Gerät)
  notify: load('notify', false),
  es: null, booted: false, tmpSeq: 0,
};
