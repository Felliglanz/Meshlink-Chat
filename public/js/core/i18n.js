/* MeshLink Chat – Sprache: Wörterbuch aus der Seite, T(), Zahlen-/Datumsformat. */

// ------------------------------------------------------------------ Sprache
// Der Server bettet das Wörterbuch der gewählten Sprache in die Seite ein (public/i18n/<code>.json, schon mit
// Englisch/Deutsch aufgefüllt). T(schlüssel, { name: … }) liefert den Text; {name} wird ersetzt, Mehrzahl über { n }.
// Platzhalter werden NICHT escaped – in HTML also esc(…) übergeben.
export const I18N = (() => { try { return JSON.parse(document.getElementById('i18n').textContent); } catch { return {}; } })();
export const LANG = I18N.lang || document.documentElement.lang || 'en';
const DICT = I18N.dict || {};
// Zahlen- und Datumsformat: passende Browser-Variante (z. B. de-AT, en-US), sonst die aus der Sprachdatei
export const LOC = (() => {
  const want = (navigator.languages || []).find((l) => l.toLowerCase().split('-')[0] === LANG.split('-')[0]);
  for (const l of [want, DICT._meta?.locale, LANG]) { try { if (l) return Intl.getCanonicalLocales(l)[0]; } catch { /* nächste */ } }
  return 'en';
})();
const PLURAL = new Intl.PluralRules(LOC);
export function T(key, p = {}) {
  let v = DICT[key];
  if (v == null) return key;
  if (typeof v === 'object') v = v[PLURAL.select(Number(p.n) || 0)] ?? v.other ?? '';
  return String(v).replace(/\{(\w+)\}/g, (all, k) => (p[k] == null ? all : String(p[k])));
}
// Eigene Wahl als Cookie (liest der Server beim Laden der Seite); null = wie der Browser
export function setLanguage(code) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = code ? `ml_lang=${encodeURIComponent(code)}; Path=/; Max-Age=31536000; SameSite=Strict${secure}` : `ml_lang=; Path=/; Max-Age=0; SameSite=Strict${secure}`;
  location.reload();
}
export const ownLanguage = () => /(?:^|;\s*)ml_lang=([^;]+)/.exec(document.cookie)?.[1] || null;
