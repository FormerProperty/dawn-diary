// Nudges: web push notifications, sent by a timer every 5 minutes.
// Pushes carry no content. The phone wakes up, asks the server what to show, and shows it.
// That avoids message encryption, and keeps diary details out of the push services.

import { getConfig, setConfig } from './db.js';
import { nowUK, addDays, minutesOf, formatTime } from '../public/shared/format.js';
import { listEvents } from './events.js';

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** VAPID keys are made automatically the first time they are needed, then kept in the database. */
export async function vapidKeys(env) {
  const stored = await getConfig(env, 'vapid');
  if (stored) {
    const { publicKey, privateJwk } = JSON.parse(stored);
    const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return { publicKey, key };
  }
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  await setConfig(env, 'vapid', JSON.stringify({ publicKey, privateJwk }));
  return { publicKey, key: pair.privateKey };
}

async function vapidHeader(env, endpoint) {
  const { publicKey, key } = await vapidKeys(env);
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.PUSH_CONTACT || 'https://example.com',
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${publicKey}`;
}

async function sendEmptyPush(env, sub) {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: await vapidHeader(env, sub.endpoint), TTL: '43200', Urgency: 'high', 'Content-Length': '0' },
  });
  if (res.status === 404 || res.status === 410) {
    await env.DB.prepare(`DELETE FROM push_subs WHERE id = ?`).bind(sub.id).run();
  }
  return res.status;
}

/** Queues a notification for every phone the user has, and wakes those phones. */
export async function notifyUser(env, userId, { title, body, tag, url }) {
  const { results: subs } = await env.DB.prepare(`SELECT id, endpoint FROM push_subs WHERE user_id = ?`).bind(userId).all();
  const now = new Date().toISOString();
  const statuses = [];
  for (const sub of subs) {
    await env.DB.prepare(`INSERT INTO push_queue (sub_id, title, body, tag, url, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(sub.id, title, body, tag || null, url || '/', now).run();
    try { statuses.push(await sendEmptyPush(env, sub)); } catch (e) { statuses.push(String(e)); }
  }
  return { phones: subs.length, statuses };
}

export async function subscribe(env, userId, endpoint) {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) return false;
  await env.DB.prepare(
    `INSERT INTO push_subs (user_id, endpoint, created_at) VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id`,
  ).bind(userId, endpoint, new Date().toISOString()).run();
  return true;
}

export async function unsubscribe(env, endpoint) {
  await env.DB.prepare(`DELETE FROM push_subs WHERE endpoint = ?`).bind(endpoint).run();
}

/** Called by the phone when woken: returns waiting notifications for that phone. */
export async function takePending(env, userId, endpoint) {
  const sub = await env.DB.prepare(`SELECT id FROM push_subs WHERE endpoint = ? AND user_id = ?`).bind(endpoint, userId).first();
  if (!sub) return [];
  const cutoff = new Date(Date.now() - 24 * 3600000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT id, title, body, tag, url FROM push_queue WHERE sub_id = ? AND delivered_at IS NULL AND created_at > ? ORDER BY id`,
  ).bind(sub.id, cutoff).all();
  if (results.length) {
    await env.DB.prepare(`UPDATE push_queue SET delivered_at = ? WHERE sub_id = ? AND delivered_at IS NULL`)
      .bind(new Date().toISOString(), sub.id).run();
  }
  // Tidy old rows now and then.
  await env.DB.prepare(`DELETE FROM push_queue WHERE created_at < ?`).bind(new Date(Date.now() - 7 * 86400000).toISOString()).run();
  return results;
}

/** Marks a nudge as sent. Returns true only the first time for a given key. */
async function once(env, key) {
  const res = await env.DB.prepare(`INSERT OR IGNORE INTO sent_log (key, at) VALUES (?, ?)`).bind(key, new Date().toISOString()).run();
  return res.meta.changes === 1;
}

function listForNotification(events) {
  return events.map((e) => (e.start_time ? `${formatTime(e.start_time)} ${e.title}` : e.title)
    + (e.location ? `, ${e.location}` : '')).join('\n');
}

/** Works out which nudges are due now and sends them. `at` can be passed in for testing. */
export async function runNudges(env, at = new Date()) {
  const now = nowUK(at);
  const nowMin = minutesOf(now.time);
  const tomorrow = addDays(now.date, 1);
  const sent = [];
  const { results: people } = await env.DB.prepare(
    `SELECT s.*, u.name FROM settings s JOIN users u ON u.id = s.user_id
      WHERE EXISTS (SELECT 1 FROM push_subs p WHERE p.user_id = s.user_id)`,
  ).all();
  if (!people.length) return sent;

  const todays = await listEvents(env, now.date, now.date);
  const tomorrows = await listEvents(env, tomorrow, tomorrow);

  for (const p of people) {
    // Morning summary, sent within 3 hours of the chosen time (in case a run is missed).
    const mStart = minutesOf(p.morning_time);
    if (p.morning_on && nowMin >= mStart && nowMin < mStart + 180 && await once(env, `morning:${p.user_id}:${now.date}`)) {
      const body = todays.length ? listForNotification(todays) : 'Nothing in the diary today.';
      const title = todays.length ? `Today: ${todays.length === 1 ? '1 thing' : `${todays.length} things`}` : 'Today is clear';
      await notifyUser(env, p.user_id, { title, body, tag: `morning-${now.date}`, url: '/?do=today' });
      sent.push(`morning:${p.user_id}`);
    }
    // Evening before, only if there is something tomorrow.
    const eStart = minutesOf(p.evening_time);
    if (p.evening_on && tomorrows.length && nowMin >= eStart && nowMin < eStart + 180
      && await once(env, `evening:${p.user_id}:${now.date}`)) {
      await notifyUser(env, p.user_id, {
        title: `Tomorrow: ${tomorrows.length === 1 ? '1 thing' : `${tomorrows.length} things`}`,
        body: listForNotification(tomorrows), tag: `evening-${now.date}`, url: '/?do=tomorrow',
      });
      sent.push(`evening:${p.user_id}`);
    }
    // About an hour before anything with a time.
    if (p.soon_on) {
      for (const ev of todays) {
        if (!ev.start_time) continue;
        const until = minutesOf(ev.start_time) - nowMin;
        if (until > 0 && until <= 60 && await once(env, `soon:${p.user_id}:${ev.id}:${ev.date}:${ev.start_time}`)) {
          await notifyUser(env, p.user_id, {
            title: `${ev.title} at ${formatTime(ev.start_time)}`,
            body: (until >= 50 ? 'In about an hour.' : `In ${until} minutes.`) + (ev.location ? ` At ${ev.location}.` : ''),
            tag: `soon-${ev.id}`, url: '/?do=today',
          });
          sent.push(`soon:${p.user_id}:${ev.id}`);
        }
      }
    }
  }
  // Keep the log small.
  await env.DB.prepare(`DELETE FROM sent_log WHERE at < ?`).bind(new Date(Date.now() - 14 * 86400000).toISOString()).run();
  return sent;
}

