/* MeshLink Chat – Aufrufe an den eigenen Server. */

import { T } from './i18n.js';
import { showLogin } from '../main.js';

// ------------------------------------------------------------------ API

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = {};
  try { j = await res.json(); } catch { /* leer */ }
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw Object.assign(new Error(T('common.notLoggedIn')), { status: 401 }); }
  if (!res.ok) throw Object.assign(new Error(j.error || T('common.errorStatus', { status: res.status })), { status: res.status, code: j.code || null, retryAfter: j.retryAfter ?? null });
  return j;
}
