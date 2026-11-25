/* MeshLink Chat – Farbschema: System, Hell oder Dunkel (Wahl nur auf diesem Gerät). */

import { load, save } from './state.js';

export const THEMES = ['system', 'light', 'dark'];
export const themePref = () => { const t = load('theme', 'system'); return THEMES.includes(t) ? t : 'system'; };

// data-theme am <html> schaltet die Farben (style.css); Statusleiste des Handys passend zur Kopfleiste färben
export function applyTheme() {
  const t = themePref();
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
  const bar = getComputedStyle(root).getPropertyValue('--bar').trim();
  if (bar) document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.removeAttribute('media'); m.setAttribute('content', bar); });
}
export function setTheme(t) {
  save('theme', THEMES.includes(t) ? t : 'system');
  applyTheme();
}
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
applyTheme();
