/* MeshLink Chat – Scope (Region) je Kanal. */

import { LOC, T } from './core/i18n.js';
import { $, esc } from './core/util.js';
import { load, S, save } from './core/state.js';
import { api } from './core/api.js';
import { ICON, ic } from './core/icons.js';
import { closeSheet, openSheet, toast } from './ui.js';
import { channelName, channelScope } from './data.js';
import { scheduleRender } from './nav.js';

// ------------------------------------------------------------------ Scope (Region) je Kanal
// Eigene Wahl gilt nur für Nachrichten aus dieser App, auf diesem Gerät; MeshMonitor bleibt unverändert.
S.scopeOverride = load('scopeOverride', {});
export const scopeKey = (idx) => `${S.source?.id || ''}:${idx}`;
export function effectiveScope(idx) {
  const own = S.scopeOverride[scopeKey(idx)];
  if (typeof own === 'string') return { scope: own, from: 'own' };
  const ch = channelScope(idx);
  if (ch) return { scope: ch, from: 'channel' };
  const def = S.scopeInfo?.defaultScope;
  if (def) return { scope: def, from: 'default' };
  return { scope: '', from: S.scopeInfo?.readable ? 'none' : 'unknown' };
}
export function scopeLabel(idx, long = false) {
  const e = effectiveScope(idx);
  if (e.from === 'unknown') return long ? T('scope.sourceDefaultLong') : T('scope.defaultShort');
  const base = e.scope || T('scope.none');
  if (!long) return base;
  return `${base}${e.from === 'own' ? ` · ${T('scope.own')}` : e.from === 'default' ? ` · ${T('scope.sourceDefault')}` : ''}`;
}
// Dasselbe als HTML mit Symbol davor (Schloss = mit Scope, Globus = ohne bzw. Standard)
export const scopeHtml = (idx, long = false) => `${ic(effectiveScope(idx).scope ? 'lock' : 'globe')}${esc(scopeLabel(idx, long))}`;
export async function loadScopes() {
  if (S.source?.protocol !== 'meshcore') return;
  try { S.scopeInfo = await api('/api/scopes'); scheduleRender(); } catch { /* egal */ }
}

export function openScopePicker(idx) {
  const cur = S.scopeOverride[scopeKey(idx)];
  const ch = channelScope(idx);
  const def = S.scopeInfo?.defaultScope;
  const known = [...new Set([...(S.scopeInfo?.regions || []), ...S.channels.map((c) => c.scope).filter(Boolean), def].filter(Boolean))].sort((a, b) => a.localeCompare(b, LOC));
  const opt = (val, label, sub = '') => {
    const active = val === null ? typeof cur !== 'string' : cur === val;
    return `<button class="sheet-btn scope-opt ${active ? 'active' : ''}" data-scope="${val === null ? '__inherit' : esc(val)}"><span>${label}${sub ? `<small>${sub}</small>` : ''}</span>${active ? `<i>${ICON.check}</i>` : ''}</button>`;
  };
  openSheet(`
    <div class="sheet-title">${T('scope.title', { name: esc(channelName(idx)) })}</div>
    ${opt(null, T('scope.inherit'), ch ? T('scope.inheritChannel', { scope: esc(ch) }) : def ? T('scope.inheritDefault', { scope: esc(def) }) : T('scope.inheritNone'))}
    ${opt('', `${ic('globe')}${T('scope.optNone')}`, T('scope.optNoneSub'))}
    ${known.map((r) => opt(r, `${ic('lock')}${esc(r)}`)).join('')}
    <form class="custom-emoji" id="scope-form"><input id="scope-in" maxlength="63" placeholder="${esc(T('scope.customPh'))}" autocomplete="off" autocapitalize="off"><button class="sheet-btn primary" type="submit">${T('common.apply')}</button></form>
    <div class="hint">${T('scope.hint')}</div>
    <button class="sheet-btn cancel" data-close>${T('common.close')}</button>`, (e) => {
    const b = e.target.closest('[data-scope]');
    if (!b) return;
    setScope(idx, b.dataset.scope === '__inherit' ? null : b.dataset.scope);
  });
  $('#scope-form').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#scope-in').value.trim().replace(/^#/, '').replace(/[^0-9A-Za-z-]/g, '');
    if (v) setScope(idx, v);
  };
}
function setScope(idx, val) {
  const o = { ...S.scopeOverride };
  if (val === null) delete o[scopeKey(idx)]; else o[scopeKey(idx)] = val;
  S.scopeOverride = o; save('scopeOverride', o);
  closeSheet();
  toast(T('scope.sendingWith', { label: scopeLabel(idx) }));
  scheduleRender();
}
