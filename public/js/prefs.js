/* MeshLink Chat – Benachrichtigung je Chat. */

import { T } from './core/i18n.js';
import { esc } from './core/util.js';
import { load, S, save } from './core/state.js';
import { ICON } from './core/icons.js';
import { closeSheet, openSheet, toast } from './ui.js';
import { convTitle } from './data.js';
import { scheduleRender } from './nav.js';
import { subscribePush } from './push.js';
// ------------------------------------------------------------------ Benachrichtigung je Chat (pro Gerät)
// 'all' = jede Nachricht melden (Kanäle), 'mute' = stumm: kein Zähler, kein Hinweis, kein Push. Ohne Eintrag: Standard.
S.convPrefs = load('convPrefs', {});
const prefKey = (key) => `${S.source?.id || ''}|${key}`;
export const convPref = (key) => S.convPrefs[prefKey(key)] || null;
export const isMuted = (key) => convPref(key) === 'mute';
export function openConvPrefs(key) {
  const cur = convPref(key);
  const isCh = key.startsWith('ch:');
  const pushOn = Boolean(S.pushEndpoint);
  const opt = (val, label, sub) => `<button class="sheet-btn scope-opt ${cur === val ? 'active' : ''}" data-pref="${val || 'std'}"><span>${label}<small>${sub}</small></span>${cur === val ? `<i>${ICON.check}</i>` : ''}</button>`;
  openSheet(`
    <div class="sheet-title">${T('prefs.title', { name: esc(convTitle(key)) })}</div>
    ${opt(null, T('prefs.std'), isCh ? T('prefs.stdChannel') : T('prefs.stdDm'))}
    ${isCh ? opt('all', T('prefs.all'), T('prefs.allSub')) : ''}
    ${opt('mute', T('prefs.mute'), T('prefs.muteSub'))}
    <div class="hint">${T('common.thisDeviceOnly')}${pushOn ? '' : ` ${T('prefs.pushOff')}`}</div>
    <button class="sheet-btn cancel" data-close>${T('common.close')}</button>`, (e) => {
    const b = e.target.closest('[data-pref]');
    if (!b) return;
    const o = { ...S.convPrefs };
    if (b.dataset.pref === 'std') delete o[prefKey(key)]; else o[prefKey(key)] = b.dataset.pref;
    S.convPrefs = o; save('convPrefs', o);
    closeSheet();
    toast({ std: T('prefs.toastStd'), all: T('prefs.toastAll'), mute: T('prefs.toastMute') }[b.dataset.pref]);
    if (S.pushEndpoint) subscribePush().catch(() => {}); // Einstellung an den Server geben (für Push)
    scheduleRender();
  });
}
