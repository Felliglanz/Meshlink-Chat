'use strict';
/*
 * Sprachen: je Sprache eine Datei public/i18n/<code>.json (z. B. de.json, en.json, fr.json).
 * Eine neue Sprache = neue Datei daneben legen und den Dienst neu starten; sie erscheint dann von selbst
 * in der Auswahl. Fehlt einer Sprache ein Text, gilt der englische, sonst der deutsche.
 *
 * Aufbau einer Datei:
 *   "_meta": { "name": "Deutsch", "locale": "de-DE" }   Anzeigename und Zahlen-/Datumsformat
 *   "chat.empty": "Noch keine Nachrichten."            einfacher Text
 *   "greet": "Hallo {name}"                             {name} = Platzhalter
 *   "msgs": { "one": "{n} Nachricht", "other": "{n} Nachrichten" }   Mehrzahl nach Intl.PluralRules
 * Die Texte sind vertrauenswürdig (Teil des Programms) und dürfen einfaches HTML wie <b> oder <br> enthalten.
 */
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'public', 'i18n');
const FALLBACK = ['de', 'en']; // Reihenfolge des Auffüllens: zuerst Deutsch, darüber Englisch, darüber die Sprache selbst
const CODE_RE = /^([a-z]{2,3}(?:-[a-z0-9]{2,8})?)\.json$/i;

function loadFiles() {
  const raw = new Map();
  let names = [];
  try { names = fs.readdirSync(DIR).sort(); } catch (e) { console.error('[i18n] Ordner fehlt:', DIR, e.message); }
  for (const f of names) {
    const m = CODE_RE.exec(f);
    if (!m) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (d && typeof d === 'object' && !Array.isArray(d)) raw.set(m[1].toLowerCase(), d);
    } catch (e) { console.error(`[i18n] ${f} nicht lesbar:`, e.message); }
  }
  return raw;
}

const raw = loadFiles();
const base = Object.assign({}, ...FALLBACK.map((c) => raw.get(c) || {}));
const dicts = new Map([...raw].map(([code, d]) => [code, { ...base, ...d, _meta: { ...(d._meta || {}) } }]));
const DEFAULT = dicts.has('en') ? 'en' : [...dicts.keys()][0] || 'en';
const languages = [...dicts].map(([code, d]) => ({ code, name: String(d._meta.name || code) }))
  .sort((a, b) => a.name.localeCompare(b.name));

// Sprache einer Anfrage: eigene Wahl (Cookie ml_lang), sonst Browser-Sprache (Accept-Language), sonst Englisch
function match(tag) {
  const t = String(tag || '').trim().toLowerCase();
  if (!t) return null;
  if (dicts.has(t)) return t;
  const short = t.split('-')[0];
  return dicts.has(short) ? short : null;
}
function pick(req) {
  const c = /(?:^|;\s*)ml_lang=([^;]+)/.exec(req?.headers?.cookie || '');
  const own = c && match(decodeURIComponent(c[1]));
  if (own) return own;
  const wanted = String(req?.headers?.['accept-language'] || '').split(',')
    .map((x) => { const [tag, q] = x.split(';q='); return { tag, q: q == null ? 1 : Number(q) || 0 }; })
    .filter((x) => x.q > 0).sort((a, b) => b.q - a.q);
  for (const w of wanted) { const m = match(w.tag); if (m) return m; }
  return DEFAULT;
}

const fill = (s, p) => String(s).replace(/\{(\w+)\}/g, (all, k) => (p[k] == null ? all : String(p[k])));
function translator(code) {
  const d = dicts.get(match(code) || DEFAULT) || {};
  const locale = d._meta?.locale || code || DEFAULT;
  let rules;
  try { rules = new Intl.PluralRules(locale); } catch { rules = new Intl.PluralRules('en'); }
  const T = (key, p = {}) => {
    let v = d[key];
    if (v == null) return key;
    if (typeof v === 'object') v = v[rules.select(Number(p.n) || 0)] ?? v.other ?? '';
    return fill(v, p);
  };
  T.lang = match(code) || DEFAULT;
  T.locale = locale;
  T.num = (v, digits = 0) => Number(v).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return T;
}

// Für die Seite: Wörterbuch der gewählten Sprache (schon aufgefüllt) und die Liste aller Sprachen
const clientData = (code) => ({ lang: match(code) || DEFAULT, langs: languages, dict: dicts.get(match(code) || DEFAULT) || {} });
const files = () => [...raw.keys()].map((c) => path.join(DIR, `${c}.json`));

module.exports = { pick, match, translator, clientData, languages, files, DEFAULT };
