// Sign-in: the owner signs in with a passphrase; the partner's phone is signed in with a one-time link.

const COOKIE = 'dd_session';
const MAX_AGE = 400 * 24 * 3600; // Chrome's maximum cookie lifetime
const enc = new TextEncoder();

export function randomToken(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(s) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  const ab = enc.encode(a); const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export async function createSession(env, userId) {
  const token = randomToken();
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)`)
    .bind(await sha256(token), userId, now, now).run();
  return token;
}

/** Returns { id, name } for the signed-in user, or null. */
export async function currentUser(env, request) {
  const token = readCookie(request, COOKIE);
  if (!token) return null;
  const hash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT s.user_id AS id, u.name AS name, s.last_seen AS last_seen
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  ).bind(hash).first();
  if (!row) return null;
  // Refresh last_seen at most once a day.
  if (Date.now() - Date.parse(row.last_seen) > 86400000) {
    await env.DB.prepare(`UPDATE sessions SET last_seen = ? WHERE token_hash = ?`)
      .bind(new Date().toISOString(), hash).run();
  }
  return { id: row.id, name: row.name };
}

export async function logout(env, request) {
  const token = readCookie(request, COOKIE);
  if (token) await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await sha256(token)).run();
}

/** Passphrase check with a simple lock-out after repeated failures. */
export async function checkPassphrase(env, attempt) {
  const key = 'login_failures';
  const row = await env.DB.prepare(`SELECT value FROM config WHERE key = ?`).bind(key).first();
  const state = row ? JSON.parse(row.value) : { count: 0, since: Date.now() };
  if (Date.now() - state.since > 3600000) { state.count = 0; state.since = Date.now(); }
  if (state.count >= 10) return { ok: false, locked: true };
  const ok = !!env.APP_PASSPHRASE && typeof attempt === 'string'
    && timingSafeEqual(attempt.trim(), env.APP_PASSPHRASE.trim());
  if (!ok) state.count += 1; else state.count = 0;
  await env.DB.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`).bind(key, JSON.stringify(state)).run();
  return { ok, locked: false };
}

export async function createLinkToken(env, userId) {
  const token = randomToken(24);
  const expires = new Date(Date.now() + 48 * 3600000).toISOString();
  await env.DB.prepare(`INSERT INTO link_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)`)
    .bind(await sha256(token), userId, expires).run();
  return { token, expires };
}

/** Uses up a one-time link. Returns the user id, or null if invalid, used or expired. */
export async function redeemLinkToken(env, token) {
  const hash = await sha256(token);
  const row = await env.DB.prepare(`SELECT user_id, expires_at, used_at FROM link_tokens WHERE token_hash = ?`).bind(hash).first();
  if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) return null;
  await env.DB.prepare(`UPDATE link_tokens SET used_at = ? WHERE token_hash = ?`).bind(new Date().toISOString(), hash).run();
  return row.user_id;
}
