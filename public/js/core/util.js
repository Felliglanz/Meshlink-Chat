/* MeshLink Chat – Kleine Helfer: DOM, Escaping, Zahlen, Zeiten, Entfernungen. */

import { LOC, T } from './i18n.js';

export const $ = (s, el = document) => el.querySelector(s);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '✅'];
export const enc = new TextEncoder();

// ------------------------------------------------------------------ Formatierung

export const hue = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 360; };
export const pad = (n) => String(n).padStart(2, '0');
export const hm = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export function dayLabel(ts) {
  const d = new Date(ts); const t = new Date();
  const y = new Date(); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return T('common.today');
  if (d.toDateString() === y.toDateString()) return T('common.yesterday');
  return d.toLocaleDateString(LOC, { weekday: 'short', day: '2-digit', month: '2-digit', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
}
export function listTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? hm(ts) : d.toLocaleDateString(LOC, { day: '2-digit', month: '2-digit' });
}
export function ago(ts) {
  if (!ts) return T('common.unknown');
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return T('ago.now');
  if (s < 3600) return T('ago.minutes', { n: Math.round(s / 60) });
  if (s < 86400) return T('ago.hours', { n: Math.round(s / 3600) });
  return T('ago.days', { n: Math.round(s / 86400) });
}
export const nf = (v, d = 0) => Number(v).toLocaleString(LOC, { maximumFractionDigits: d, minimumFractionDigits: d });
export const fmtBytes = (b) => (b >= 1048576 ? `${nf(b / 1048576, 1)} MB` : b >= 1024 ? `${nf(b / 1024, 1)} kB` : `${nf(b)} B`);
// Entfernung zwischen zwei Positionen (Luftlinie, Haversine)
export function distKm(a, b) {
  const R = 6371; const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad; const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
// Himmelsrichtung von a nach b (N, NO, O, …)
export function compass(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return T('map.compass').split(' ')[Math.round((((Math.atan2(y, x) / rad) + 360) % 360) / 45) % 8];
}
export const fmtKm = (km) => `${km < 1 ? km.toLocaleString(LOC, { maximumFractionDigits: 2 }) : km.toLocaleString(LOC, { maximumFractionDigits: 1 })} km`;

export function dur(sec) {
  const s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return d ? T('dur.dh', { d, h }) : h ? `${h} h ${m} min` : `${m} min`;
}
export function fmtNum(v) { return Math.abs(v) >= 100 ? Math.round(v).toLocaleString(LOC) : (Math.round(v * 100) / 100).toLocaleString(LOC); }
