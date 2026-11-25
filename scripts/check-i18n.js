#!/usr/bin/env node
'use strict';
/*
 * Prüft die Sprachdateien in public/i18n/:
 *   - Jeder im Code benutzte Schlüssel steht in de.json und en.json (sonst Fehler).
 *   - Weitere Sprachen: fehlende Schlüssel werden nur gemeldet (dort gilt dann Englisch).
 *   - Platzhalter wie {name} müssen in jeder Sprache dieselben sein wie im Englischen.
 *   - Mehrzahl-Einträge ({ "one": …, "other": … }) brauchen mindestens "other".
 *   - Schlüssel, die der Code nicht (mehr) benutzt, werden als Hinweis gelistet.
 * Aufruf: node scripts/check-i18n.js        Rückgabe 1 bei Fehlern
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'public', 'i18n');
// Alle Module der App (public/js/**) und der Server
const appFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? appFiles(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
const CODE = [...appFiles(path.join(ROOT, 'public', 'js')), ...['server/server.js', 'server/push.js'].map((f) => path.join(ROOT, f))];
const REQUIRED = ['de', 'en'];

let errors = 0;
const err = (msg) => { errors++; console.log(`  ✘ ${msg}`); };
const warn = (msg) => console.log(`  ⚠ ${msg}`);

const langs = new Map();
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json')).sort()) {
  try { langs.set(f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))); } catch (e) { err(`${f}: kein gültiges JSON – ${e.message}`); }
}
for (const c of REQUIRED) if (!langs.has(c)) err(`${c}.json fehlt`);
const en = langs.get('en') || {};
const groups = new Set(Object.keys(en).filter((k) => k !== '_meta').map((k) => k.split('.')[0]));

// Benutzte Schlüssel: jede Zeichenkette 'bereich.name', deren Bereich in en.json vorkommt
const used = new Set();
for (const f of CODE) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/'([a-z][a-zA-Z0-9]*)\.([a-zA-Z0-9.]+)'/g)) if (groups.has(m[1]) && !/^(json|js|css|html|png|svg)$/.test(m[2])) used.add(`${m[1]}.${m[2]}`); // Dateinamen wie push.json zählen nicht
  for (const m of src.matchAll(/\bT\(\s*'([^']+)'/g)) used.add(m[1]); // direkte Aufrufe immer, auch mit unbekanntem Bereich
}

const variants = (v) => (v && typeof v === 'object' ? Object.values(v) : [v]);
const holes = (v) => new Set(variants(v).flatMap((s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1])));

for (const [code, d] of langs) {
  console.log(`${code}.json – ${d._meta?.name || '(ohne _meta.name)'}`);
  if (!d._meta?.name || !d._meta?.locale) warn('_meta.name oder _meta.locale fehlt');
  const missing = [...used].filter((k) => !(k in d));
  if (missing.length) {
    if (REQUIRED.includes(code)) missing.forEach((k) => err(`fehlt: ${k}`));
    else warn(`${missing.length} Texte fehlen (dort erscheint Englisch): ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ' …' : ''}`);
  }
  for (const [k, v] of Object.entries(d)) {
    if (k === '_meta') continue;
    if (v && typeof v === 'object' && !('other' in v)) err(`${k}: Mehrzahl ohne "other"`);
    if (typeof v !== 'string' && (typeof v !== 'object' || v === null)) { err(`${k}: kein Text`); continue; }
    if (code !== 'en' && k in en) {
      const want = holes(en[k]);
      for (const h of holes(v)) if (!want.has(h)) err(`${k}: unbekannter Platzhalter {${h}}`);
    }
    if (!(k in en) && code !== 'en') warn(`${k}: steht nicht in en.json`);
  }
}
const unused = Object.keys(en).filter((k) => k !== '_meta' && !used.has(k));
if (unused.length) console.log(`Hinweis: ${unused.length} Schlüssel werden im Code nicht benutzt: ${unused.join(', ')}`);
console.log(errors ? `\n${errors} Fehler` : `\nAlles in Ordnung (${used.size} Texte im Code, ${langs.size} Sprachen)`);
process.exit(errors ? 1 : 0);
