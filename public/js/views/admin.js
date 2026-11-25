/* MeshLink Chat – Repeater-Verwaltung (REMOTE_ADMIN=1). */

import { T } from '../core/i18n.js';
import { $, ago, dur, esc } from '../core/util.js';
import { S } from '../core/state.js';
import { api } from '../core/api.js';
import { ICON } from '../core/icons.js';
import { avatar, closeSheet, openSheet, permHint, toast } from '../ui.js';
import { node } from '../data.js';
import { showOnMap, snrColor } from '../map/map.js';
import { fetchNeighbours, nbMore, nbMoreLabel, STATUS_FIELDS } from './node.js';

// ------------------------------------------------------------------ Repeater-Verwaltung (REMOTE_ADMIN=1)
// Ablauf wie in der MeshCore-App: anmelden, dann Status, Konsole und Einstellungen. Alles geht über MeshMonitor;
// jede Abfrage ist Funkverkehr (eine DM hin, eine zurück), deshalb nur auf Knopfdruck. Verlauf nur im Speicher.
const ADM_DANGER = /\b(reboot|erase|clkreboot|factory|poweroff|shutdown)\b(?!\.)|\bset\s+prv\.key\b/i;
const admName = (id) => { const n = node(id); return n?.long || n?.short || T('type.repeater'); };
export const canAdmin = (n) => Boolean(S.admin && S.source?.protocol === 'meshcore' && (n?.type === 2 || n?.type === 3));
// Auftrag beim Server starten und nachfragen, bis er fertig ist (Funk: bis zu 2 Min.)
async function admJob(path, body) {
  const { job } = await api(path, { method: 'POST', body });
  const t0 = Date.now();
  while (Date.now() - t0 < 160000) {
    await new Promise((r) => setTimeout(r, 2000));
    const j = await api(`/api/admin/job?id=${encodeURIComponent(job)}`);
    if (j.state === 'done') return j.result || {};
    if (j.state === 'error') throw Object.assign(new Error(j.error || T('adm.failed')), { code: j.code });
  }
  throw Object.assign(new Error(T('adm.timeout')), { code: 'CLI_TIMEOUT' });
}
function admError(e) {
  if (e.code === 'FORBIDDEN' || e.status === 403) return e.code === 'ADMIN_DISABLED' ? e.message : T('perm.noPerm', { perm: 'remote_admin:write' });
  if (e.code === 'CLI_TIMEOUT') return S.adm?.session?.resumed ? T('adm.timeoutResumed') : T('adm.timeout');
  if (e.code === 'CONTACT_NOT_ON_DEVICE') return T('adm.notOnDevice');
  if (e.code === 'TX_DISABLED') return T('perm.txDisabled');
  return e.message;
}
const admValue = (reply) => String(reply || '').trim().replace(/^>\s?/, '');

// Gespeicherter Weg zum Repeater/Room für den Anmelde-Knopf: die Anmeldung geht per Funk diesen Weg
// (oder per Flood, wenn keiner bekannt ist). null = unbekannt / kein Kontakt auf dem Gerät.
export async function loginRoute(id) {
  try {
    const c = await api(`/api/node/contact?id=${encodeURIComponent(id)}`);
    if (!c?.known) return null;
    if (c.flood) return T('login.routeFlood');
    if (!c.hops.length) return T('login.routeDirect');
    return `${T('common.hops', { n: c.hops.length })} · ${c.hops.map((h) => h.name || `#${h.hash}`).join(' › ')}`;
  } catch { return null; }
}

export function renderAdmin() {
  const app = $('#app');
  const id = S.conv;
  if (!$('.view-admin', app) || app.dataset.admin !== id) {
    app.dataset.admin = id;
    S.adm = { id, tab: 'status', session: null, busy: null, status: null, log: [], out: {}, draft: {}, msg: null };
    app.innerHTML = `
      <div class="view view-admin">
        <header class="bar">
          <button class="icon-btn" id="back" aria-label="${esc(T('common.back'))}">${ICON.back}</button>
          ${avatar('dm:' + id, 'small')}
          <div class="bar-title"><h2>${T('adm.title')}</h2><div class="sub">${esc(admName(id))}</div></div>
        </header>
        <main class="scroll node-page" id="adm-body"></main>
        <footer class="composer-wrap hidden" id="adm-foot">
          <form class="composer" id="adm-form">
            <textarea id="adm-input" rows="1" placeholder="${esc(T('adm.cmdPlaceholder'))}" enterkeyhint="send" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
            <button class="send" type="submit" aria-label="${esc(T('common.send'))}">${ICON.send}</button>
          </form>
        </footer>
        <nav class="adm-tabs">${['status', 'console', 'settings'].map((t) => `<button data-adm-tab="${t}">${{ status: ICON.info, console: ICON.terminal, settings: ICON.gear }[t]}<span>${{ status: T('adm.tabStatus'), console: T('adm.tabConsole'), settings: T('adm.tabSettings') }[t]}</span></button>`).join('')}</nav>
      </div>`;
    $('#back').onclick = () => history.back();
    $('.adm-tabs').onclick = (e) => { const b = e.target.closest('[data-adm-tab]'); if (b) { S.adm.tab = b.dataset.admTab; renderAdminBody(); } };
    $('#adm-body').onclick = onAdminClick;
    $('#adm-body').oninput = (e) => { const k = e.target.dataset?.admIn; if (k) S.adm.draft[k] = e.target.value; };
    $('#adm-form').onsubmit = (e) => { e.preventDefault(); const v = $('#adm-input').value.trim(); if (v) { $('#adm-input').value = ''; admCli(v, { log: true }); } };
    $('#adm-input').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#adm-form').requestSubmit(); } };
    loadAdminSession();
    const a = S.adm;
    loginRoute(id).then((r) => { if (S.adm === a && r) { a.route = r; renderAdminBody(); } });
  }
  renderAdminBody();
}

async function loadAdminSession() {
  const a = S.adm;
  try {
    const s = await api(`/api/admin/session?id=${encodeURIComponent(a.id)}`);
    a.session = { ...s, resumed: s.active };
  } catch (e) { a.session = { active: false, canRemember: false, error: admError(e) }; }
  if (S.adm === a) renderAdminBody();
}

// Feste Befehle der Einstellungen: Werte lesen (get) und schreiben (set); Werkzeuge = einzelne Befehle mit Ausgabe
const ADM_FIELDS = [
  { group: 'info', key: 'name', label: () => T('adm.fName'), max: 31 },
  { group: 'info', key: 'lat', label: () => T('adm.fLat'), num: [-90, 90] },
  { group: 'info', key: 'lon', label: () => T('adm.fLon'), num: [-180, 180] },
  // Repeater-Schlüssel in doppelten Anführungszeichen: check-i18n hielte sie sonst für Text-Schlüssel
  { group: 'adv', key: "advert.interval", label: () => T('adm.fAdvert'), sub: () => T('adm.fAdvertSub'), num: [0, 240], int: true },
  { group: 'adv', key: "flood.advert.interval", label: () => T('adm.fFlood'), sub: () => T('adm.fFloodSub'), num: [0, 168], int: true },
];
const ADM_TOOLS = [
  { key: 'repeat', cmd: 'get repeat', label: () => T('adm.tRepeat'), sub: () => T('adm.tRepeatSub') },
  { key: 'advert', cmd: 'advert', label: () => T('adm.tAdvert'), sub: () => T('adm.tAdvertSub') },
  { key: 'clock', fetch: true, cmd: 'clock', label: () => T('adm.tClock'), sub: () => T('adm.tClockSub') },
  { key: 'sync', cmd: 'clock sync', label: () => T('adm.tSync'), sub: () => T('adm.tSyncSub') },
  { key: 'neighbors', fetch: true, nb: true, label: () => T('adm.tNeighbors'), sub: () => T('adm.tNeighborsSub') },
  { key: 'radio', fetch: true, cmd: 'get radio', label: () => T('adm.tRadio'), sub: () => T('adm.tRadioSub') },
  { key: 'ver', fetch: true, cmd: 'ver', label: () => T('adm.tVer'), sub: () => T('adm.tVerSub') },
  { key: 'guest', label: () => T('adm.tGuest'), sub: () => T('adm.tGuestSub'), input: true },
  { key: 'reboot', cmd: 'reboot', label: () => T('adm.tReboot'), sub: () => T('adm.tRebootSub'), danger: true },
];

function renderAdminBody() {
  const a = S.adm;
  if (!a || !$('#adm-body')) return;
  document.querySelectorAll('[data-adm-tab]').forEach((b) => b.classList.toggle('active', b.dataset.admTab === a.tab));
  const s = a.session;
  const on = Boolean(s?.active);
  $('#adm-foot').classList.toggle('hidden', !(on && a.tab === 'console'));
  const busy = (k) => a.busy === k;
  const out = (k) => (a.out[k] ? `<div class="adm-out ${a.out[k].err ? 'err' : ''}">${esc(a.out[k].text)}</div>` : '');
  let html = '';
  if (!s) html = `<div class="muted adm-pad">${T('common.loading')}</div>`;
  else if (!on) {
    html = `
      <section class="card">
        <div class="card-head"><b>${T('adm.loginTitle')}</b></div>
        ${s.error ? `<div class="node-msg err">${esc(s.error)}</div>` : ''}
        ${s.reason === 'other_radio' ? `<div class="hint left">${T('adm.otherRadio')}</div>` : ''}
        <input class="adm-field" type="password" id="adm-pw" maxlength="15" placeholder="${esc(T('adm.password'))}" autocomplete="off" ${busy('login') ? 'disabled' : ''}>
        ${s.canRemember ? `<label class="adm-check"><input type="checkbox" id="adm-remember"> ${T('adm.remember')}</label>` : ''}
        <button class="sheet-btn primary" data-adm="login" ${a.busy ? 'disabled' : ''}>${busy('login') ? T('adm.loggingIn') : T('adm.login')}${a.route ? `<small class="btn-sub">↪ ${esc(a.route)}</small>` : ''}</button>
        ${s.canRemember ? `<button class="sheet-btn" data-adm="saved" ${a.busy ? 'disabled' : ''}>${busy('saved') ? T('adm.loggingIn') : T('adm.loginSaved')}</button>` : ''}
        ${out('login')}
        <div class="hint">${T('adm.guestHint')}</div>
        <div class="hint">${T('adm.loginHint')}</div>
      </section>`;
  } else {
    const head = `<div class="adm-ok">${ICON.check}<span>${T('adm.loggedIn')}${s.loggedInAt ? ` · ${esc(ago(s.loggedInAt))}` : ''}</span><button class="pill" data-adm="logout">${T('adm.logout')}</button></div>`;
    if (a.tab === 'status') {
      const v = a.status?.values || {};
      const rows = STATUS_FIELDS.filter(([k]) => v[k] != null);
      html = `${head}
        <section class="card">
          <div class="card-head"><b>Status</b>${a.status?.ts ? `<small>${T('node.asOf', { ago: esc(ago(a.status.ts)) })}</small>` : ''}</div>
          ${rows.length ? `<div class="stat-grid">${rows.map(([k, label, f]) => `<div><small>${esc(label)}</small><b>${esc(f(v[k]))}</b></div>`).join('')}</div>` : `<div class="muted">${a.status ? T('node.noValues') : T('adm.statusNone')}</div>`}
          <button class="sheet-btn primary" data-adm="status" ${a.busy ? 'disabled' : ''}>${busy('status') ? T('node.querying') : T('node.queryStatus')}</button>
          ${out('status')}
          <div class="hint">${T('adm.airHint')}</div>
        </section>`;
    } else if (a.tab === 'console') {
      html = `${head}
        <div class="adm-chips">${['ver', 'clock', 'neighbors', 'get repeat', 'get radio'].map((c) => `<button class="pill" data-adm-cmd="${esc(c)}" ${a.busy ? 'disabled' : ''}>${esc(c)}</button>`).join('')}</div>
        <div class="adm-log" id="adm-log">${a.log.length ? a.log.map((l) => `<div class="${l.cmd ? 'adm-cmd' : l.err ? 'adm-err' : 'adm-rep'}">${l.cmd ? `&gt; ${esc(l.cmd)}` : esc(l.text)}</div>`).join('') : `<div class="muted">${T('adm.consoleEmpty')}</div>`}${busy('cli') ? `<div class="muted">${T('adm.waiting')}</div>` : ''}</div>
        <div class="hint">${T('adm.consoleHint')}</div>`;
    } else {
      const field = (f) => {
        const val = a.draft[f.key] ?? '';
        return `
          <div class="adm-row">
            <label><span>${esc(f.label())}</span>${f.sub ? `<small>${esc(f.sub())}</small>` : ''}</label>
            <div class="adm-inline">
              <input class="adm-field" data-adm-in="${esc(f.key)}" value="${esc(val)}" ${f.num ? 'inputmode="decimal"' : ''} maxlength="${f.max || 16}" placeholder="–">
              <button class="pill" data-adm-get="${esc(f.key)}" ${a.busy ? 'disabled' : ''} title="${esc(T('adm.read'))}">${ICON.refresh}</button>
              <button class="pill" data-adm-set="${esc(f.key)}" ${a.busy ? 'disabled' : ''} title="${esc(T('adm.save'))}">${ICON.check}</button>
            </div>
            ${out(`f:${f.key}`)}
          </div>`;
      };
      const tool = (t) => `
        <div class="adm-tool ${t.danger ? 'danger' : ''}">
          <div class="adm-tool-text"><b>${esc(t.label())}</b><small>${esc(t.sub())}</small></div>
          ${t.input ? `<input class="adm-field" data-adm-in="guest" type="password" maxlength="15" placeholder="${esc(T('adm.newPw'))}" value="${esc(a.draft.guest || '')}">` : ''}
          ${t.key === 'repeat'
            ? `<span class="adm-inline"><button class="pill" data-adm-tool="repeat" ${a.busy ? 'disabled' : ''}>${busy('t:repeat') ? '…' : T('adm.read')}</button><button class="pill" data-adm-repeat="on" ${a.busy ? 'disabled' : ''}>${T('common.on')}</button><button class="pill" data-adm-repeat="off" ${a.busy ? 'disabled' : ''}>${T('common.off')}</button></span>`
            : `<button class="pill" data-adm-tool="${t.key}" ${a.busy ? 'disabled' : ''}>${busy(`t:${t.key}`) ? '…' : t.input ? T('adm.save') : t.danger ? T('adm.run') : t.fetch ? T('adm.fetch') : T('adm.send')}</button>`}
          ${out(`t:${t.key}`)}
          ${t.nb && a.nb ? `<div class="adm-nb">${a.nb.neighbours.length ? a.nb.neighbours.map((x) => `<div class="heard-row"><span class="heard-name">${esc(x.name || `#${x.hash}`)}</span><span class="heard-snr" style="color:${snrColor(x.snr)}">${x.snr != null ? `SNR ${esc(x.snr)}` : ''}</span><span class="heard-snr">${x.secs != null ? esc(dur(x.secs)) : ''}</span></div>`).join('') : `<div class="muted">${T('node.nbEmpty')}</div>`}
            <div class="node-actions">${nbMore(a.nb) ? `<button class="pill" data-adm="nbmore" ${a.busy ? 'disabled' : ''}>${busy('t:neighbors') ? '…' : nbMoreLabel(a.nb)}</button>` : ''}${a.nb.neighbours.length ? `<button class="pill" data-adm="nbmap">${T('node.mapBtn')} (${a.nb.neighbours.length})</button>` : ''}</div></div>` : ''}
        </div>`;
      html = `${head}
        <div class="adm-note">${T('adm.airHint')}</div>
        <section class="card"><div class="card-head"><b>${T('adm.gInfo')}</b></div>${ADM_FIELDS.filter((f) => f.group === 'info').map(field).join('')}</section>
        <section class="card"><div class="card-head"><b>${T('adm.gAdvert')}</b></div>${ADM_FIELDS.filter((f) => f.group === 'adv').map(field).join('')}</section>
        <section class="card"><div class="card-head"><b>${T('adm.gTools')}</b></div>${ADM_TOOLS.map(tool).join('')}</section>
        <div class="hint">${T('adm.moreInConsole')}</div>`;
    }
  }
  $('#adm-body').innerHTML = html;
  const log = $('#adm-log');
  if (log) log.scrollIntoView({ block: 'end' });
}

// Einen Befehl senden; gefährliche erst nach Eingabe des Repeater-Namens
async function admCli(command, { log = false, key = 'cli', confirm = false } = {}) {
  const a = S.adm;
  if (!a || a.busy) return null;
  if (ADM_DANGER.test(command) && !confirm) { admConfirm(command, () => admCli(command, { log, key, confirm: true })); return null; }
  a.busy = key;
  if (log) a.log.push({ cmd: command });
  if (key !== 'cli') delete a.out[key];
  renderAdminBody();
  let reply = null;
  try {
    const r = await admJob('/api/admin/cli', { id: a.id, command, confirm });
    reply = r.reply ?? '';
    if (log) a.log.push({ text: reply || T('adm.noOutput') });
    else a.out[key] = { text: reply || T('adm.noOutput') };
    if (a.session) a.session.resumed = false; // Antwort kam: Sitzung trägt
  } catch (e) {
    if (log) a.log.push({ err: true, text: admError(e) });
    else a.out[key] = { err: true, text: admError(e) };
  }
  a.busy = null;
  if (a.log.length > 300) a.log.splice(0, a.log.length - 300);
  if (S.adm === a) renderAdminBody();
  return reply;
}
function admConfirm(command, run) {
  const name = admName(S.adm.id);
  openSheet(`
    <div class="sheet-title">${T('adm.dangerTitle')}</div>
    <div class="hint left">${T('adm.dangerText', { cmd: esc(command), name: esc(name) })}</div>
    <input class="adm-field" id="adm-confirm" placeholder="${esc(name)}" autocomplete="off">
    <button class="sheet-btn danger" data-adm-go disabled>${T('adm.run')}</button>
    <button class="sheet-btn cancel" data-close>${T('common.cancel')}</button>`, (e) => {
    if (e.target.closest('[data-adm-go]') && !e.target.closest('[data-adm-go]').disabled) { closeSheet(); run(); }
  });
  const inp = $('#adm-confirm');
  inp.oninput = () => { $('[data-adm-go]').disabled = inp.value.trim() !== name; };
  inp.focus();
}

async function admNeighbours(more) {
  const a = S.adm;
  if (!a || a.busy) return;
  a.busy = 't:neighbors'; delete a.out['t:neighbors']; renderAdminBody();
  try { a.nb = await fetchNeighbours(a.id, more ? a.nb : null); } catch (e) {
    a.out['t:neighbors'] = { err: true, text: e.status === 504 || /timeout/i.test(e.message) ? T('node.nbNoAnswer') : permHint(e, 'nodes:read') };
  }
  a.busy = null;
  if (S.adm === a) renderAdminBody();
}

async function onAdminClick(e) {
  const a = S.adm;
  if (!a) return;
  const b = e.target.closest('[data-adm], [data-adm-cmd], [data-adm-get], [data-adm-set], [data-adm-tool], [data-adm-repeat]');
  if (!b || b.disabled) return;
  const act = b.dataset.adm;
  if (act === 'login' || act === 'saved') {
    const password = $('#adm-pw')?.value || '';
    if (act === 'login' && !password) { a.out.login = { err: true, text: T('adm.pwMissing') }; renderAdminBody(); return; }
    const remember = Boolean($('#adm-remember')?.checked);
    a.busy = act; delete a.out.login; renderAdminBody();
    try {
      const r = await admJob('/api/admin/login', act === 'saved' ? { id: a.id, saved: true } : { id: a.id, password, remember });
      a.session = { ...(a.session || {}), active: true, loggedInAt: Date.now(), resumed: false };
      a.msg = r.persisted ? T('adm.savedOk') : null;
      if (r.persisted) toast(T('adm.savedOk'));
    } catch (err) { a.out.login = { err: true, text: admError(err) }; }
    a.busy = null;
    if (S.adm === a) renderAdminBody();
    return;
  }
  if (act === 'logout') {
    try { await api('/api/admin/logout', { method: 'POST', body: { id: a.id } }); } catch (err) { toast(admError(err)); }
    a.session = { ...(a.session || {}), active: false, loggedInAt: null };
    renderAdminBody();
    return;
  }
  if (act === 'status') {
    a.busy = 'status'; delete a.out.status; renderAdminBody();
    try { a.status = await admJob('/api/admin/status', { id: a.id }); } catch (err) { a.out.status = { err: true, text: admError(err) }; }
    a.busy = null;
    if (S.adm === a) renderAdminBody();
    return;
  }
  if (act === 'nbmap') {
    const n = node(a.id);
    showOnMap({ kind: 'star', title: T('node.nbOf', { name: admName(a.id) }), center: { id: a.id, label: n?.long || n?.short }, leaves: a.nb.neighbours.map((x) => ({ id: x.id, hash: x.hash, label: `${x.name || `#${x.hash}`}${x.snr != null ? ` · SNR ${x.snr}` : ''}`, snr: x.snr })) });
    return;
  }
  if (act === 'nbmore') { admNeighbours(true); return; }
  if (b.dataset.admCmd) { admCli(b.dataset.admCmd, { log: true }); return; }
  const f = ADM_FIELDS.find((x) => x.key === (b.dataset.admGet || b.dataset.admSet));
  if (f && b.dataset.admGet) {
    const r = await admCli(`get ${f.key}`, { key: `f:${f.key}` });
    if (r != null && !/unknown|\?\?/i.test(r)) { a.draft[f.key] = admValue(r); delete a.out[`f:${f.key}`]; renderAdminBody(); }
    return;
  }
  if (f && b.dataset.admSet) {
    const v = String(a.draft[f.key] ?? '').trim().replace(/[\r\n]/g, ' ');
    const bad = !v || (f.max && new TextEncoder().encode(v).length > f.max)
      || (f.num && (!/^-?\d+(\.\d+)?$/.test(v) || Number(v) < f.num[0] || Number(v) > f.num[1] || (f.int && !Number.isInteger(Number(v)))));
    if (bad) { a.out[`f:${f.key}`] = { err: true, text: T('adm.badValue') }; renderAdminBody(); return; }
    admCli(`set ${f.key} ${v}`, { key: `f:${f.key}` });
    return;
  }
  if (b.dataset.admRepeat) { admCli(`set repeat ${b.dataset.admRepeat}`, { key: 't:repeat' }); return; }
  const t = ADM_TOOLS.find((x) => x.key === b.dataset.admTool);
  if (!t) return;
  if (t.nb) { admNeighbours(false); return; }
  if (t.input) {
    const v = String(a.draft.guest || '');
    // Leeren geht über MeshMonitor nicht: es kürzt den Befehl, die Firmware braucht aber "set guest.password " mit Leerzeichen
    if (!v) { a.out['t:guest'] = { err: true, text: T('adm.guestNoClear') }; renderAdminBody(); return; }
    if (v.length > 15 || /\s/.test(v)) { a.out['t:guest'] = { err: true, text: T('adm.badValue') }; renderAdminBody(); return; }
    await admCli(`set guest.password ${v}`, { key: 't:guest' });
    a.draft.guest = ''; renderAdminBody();
    return;
  }
  admCli(t.cmd, { key: `t:${t.key}` });
}
