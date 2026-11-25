/* MeshLink Chat – Gemeinsame Bausteine: Avatar, Sheets, Toasts, Hinweise. */

import { T } from './core/i18n.js';
import { $, esc, hue } from './core/util.js';
import { S } from './core/state.js';
import { ICON } from './core/icons.js';
import { shortName } from './data.js';
export function stateIcon(st) {
  if (!st) return '';
  if (/fail|error|nak|timeout/.test(st)) return `<span class="st st-fail" title="${esc(T('state.failed'))}">!</span>`;
  if (/deliver|ack|confirm|received|read/.test(st)) return `<span class="st st-ok" title="${esc(T('state.delivered'))}">✓✓</span>`;
  if (/sent|transmit|broadcast/.test(st)) return `<span class="st" title="${esc(T('state.sent'))}">✓</span>`;
  return `<span class="st st-wait" title="${esc(T('state.pending'))}">◷</span>`;
}
// Art eines Kanals (MeshCore): Hashtag-Kanal (Name mit #, Schlüssel aus dem Namen), privat (eigener Schlüssel)
// oder Public (bekannter Schlüssel). Weiß der Server es genau (kind), gilt das; sonst entscheidet der Name.
function channelKind(idx) {
  if (S.source?.protocol !== 'meshcore') return 'hashtag';
  const c = S.channels.find((x) => x.index === idx);
  if (c?.kind === 'hashtag' || c?.kind === 'private' || c?.kind === 'public') return c.kind;
  const name = String(c?.name || '').trim();
  if (name.startsWith('#')) return 'hashtag';
  return /^public$/i.test(name) || (!name && idx === 0) ? 'public' : 'private';
}
const KIND_LABEL = () => ({ hashtag: T('channel.kindHashtag'), private: T('channel.kindPrivate'), public: T('channel.kindPublic') });
export function avatar(id, cls = '') {
  if (id.startsWith('ch:')) {
    const kind = channelKind(Number(id.slice(3)));
    // Feste Farbe je Art (grün = Hashtag, lila = privat), damit man die Art auf einen Blick sieht
    return `<div class="avatar ch-${kind} ${cls}" style="--h:${kind === 'private' ? 270 : 140}" title="${esc(KIND_LABEL()[kind])}">${{ hashtag: ICON.hash, private: ICON.lock, public: ICON.globe }[kind]}</div>`;
  }
  return `<div class="avatar ${cls}" style="--h:${hue(id)}">${esc(shortName(id.replace(/^dm:/, '')).slice(0, cls === 'tiny' ? 3 : 4))}</div>`;
}

export function permHint(e, perm) {
  if (e.status === 403) return T('perm.noPerm', { perm });
  if (e.status === 429) return T('perm.tooSoon', { s: e.retryAfter || 60 });
  if (e.code === 'TX_DISABLED') return T('perm.txDisabled');
  if (e.code === 'MESHCORE_TRACE_FAILED') return T('perm.traceFailed');
  if (e.status === 503) return T('perm.notConnected');
  return e.message;
}

export function openSheet(html, onClick) {
  const root = $('#sheet-root');
  root.innerHTML = `<div class="backdrop" data-close></div><div class="sheet" role="dialog">${html}</div>`;
  root.classList.add('open');
  root.onclick = (e) => {
    if (e.target.closest('[data-close]')) { closeSheet(); return; }
    onClick?.(e);
  };
}
export function closeSheet() { const r = $('#sheet-root'); r.classList.remove('open'); r.innerHTML = ''; }

// ------------------------------------------------------------------ Benachrichtigungen

let toastTimer = null;
export function toast(text, onClick) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  t.onclick = () => { t.classList.remove('show'); onClick?.(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}
