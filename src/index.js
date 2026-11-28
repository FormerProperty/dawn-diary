// Dawn's Diary: Cloudflare Worker serving the app and its API.

import { ensureSchema, userName } from './db.js';
import {
  currentUser, createSession, sessionCookie, clearCookie, logout,
  checkPassphrase, createLinkToken, redeemLinkToken,
} from './auth.js';
import { listEvents, addEvent, updateEvent, deleteEvent, restoreEvent, recentActivity } from './events.js';
import { interpret } from './ai.js';
import { vapidKeys, subscribe, unsubscribe, takePending, notifyUser, runNudges } from './push.js';
import { nowUK, addDays, isValidDate, isValidTime } from '../public/shared/format.js';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});
const fail = (message, status = 400) => json({ error: message }, status);

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

async function api(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // Basic protection against other websites posting to the API.
  if (method !== 'GET') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return fail('Not allowed.', 403);
  }

  if (path === '/api/login' && method === 'POST') {
    const { passphrase } = await body(request);
    if (!env.APP_PASSPHRASE) {
      return fail("The app can't see a passphrase yet. In Cloudflare, APP_PASSPHRASE must be added under Settings > Variables and Secrets (not under Build), as a Secret.", 500);
    }
    const r = await checkPassphrase(env, passphrase);
    if (r.locked) return fail('Too many tries. Please wait an hour and try again.', 429);
    if (!r.ok) return fail("That passphrase isn't right.", 401);
    const token = await createSession(env, 'owner');
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(token) });
  }

  const user = await currentUser(env, request);
  if (!user) return fail('Please sign in.', 401);

  if (path === '/api/me' && method === 'GET') {
    return json({ user, partnerName: await userName(env, 'partner'), today: nowUK() });
  }
  if (path === '/api/logout' && method === 'POST') {
    await logout(env, request);
    return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
  }

  if (path === '/api/link' && method === 'POST') {
    if (user.id !== 'owner') return fail('Only the main account can set up phones.', 403);
    const { who } = await body(request);
    const target = who === 'owner' ? 'owner' : 'partner';
    const { token, expires } = await createLinkToken(env, target);
    return json({ url: `${url.origin}/link/${token}`, expires, name: await userName(env, target) });
  }

  // Events
  if (path === '/api/events' && method === 'GET') {
    const today = nowUK().date;
    const from = isValidDate(url.searchParams.get('from')) ? url.searchParams.get('from') : today;
    const to = isValidDate(url.searchParams.get('to')) ? url.searchParams.get('to') : addDays(today, 90);
    return json({ today: nowUK(), events: await listEvents(env, from, to) });
  }
  if (path === '/api/events' && method === 'POST') {
    const r = await addEvent(env, user, await body(request));
    return r.errors ? fail(r.errors.join(' ')) : json(r);
  }
  const m = path.match(/^\/api\/events\/(\d+)(\/restore)?$/);
  if (m) {
    const id = Number(m[1]);
    let r;
    if (m[2] && method === 'POST') r = await restoreEvent(env, user, id);
    else if (!m[2] && method === 'PATCH') r = await updateEvent(env, user, id, await body(request));
    else if (!m[2] && method === 'DELETE') r = await deleteEvent(env, user, id);
    else return fail('Not found.', 404);
    if (r.notFound) return fail("That isn't in the diary any more.", 404);
    return r.errors ? fail(r.errors.join(' ')) : json(r);
  }

  if (path === '/api/interpret' && method === 'POST') {
    const { text, history } = await body(request);
    if (!text || !String(text).trim()) return fail('Nothing was said.');
    try {
      // Local testing only: with AI_MOCK=1 in .dev.vars, typed JSON stands in for the AI's reply.
      const mock = env.AI_MOCK === '1' ? async () => JSON.parse(text) : null;
      return json(await interpret(env, text, Array.isArray(history) ? history : [], mock));
    } catch (e) {
      console.error(e);
      return json({ kind: 'error', text: "Sorry, I couldn't work that out just now. You can type it in with the Add button instead." }, 502);
    }
  }

  if (path === '/api/activity' && method === 'GET') return json({ activity: await recentActivity(env) });

  // Settings and nudges
  if (path === '/api/settings' && method === 'GET') {
    const s = await env.DB.prepare(`SELECT * FROM settings WHERE user_id = ?`).bind(user.id).first();
    return json({ settings: s });
  }
  if (path === '/api/settings' && method === 'PUT') {
    const b = await body(request);
    const s = await env.DB.prepare(`SELECT * FROM settings WHERE user_id = ?`).bind(user.id).first();
    const next = {
      morning_on: 'morning_on' in b ? (b.morning_on ? 1 : 0) : s.morning_on,
      morning_time: isValidTime(b.morning_time) ? b.morning_time : s.morning_time,
      evening_on: 'evening_on' in b ? (b.evening_on ? 1 : 0) : s.evening_on,
      evening_time: isValidTime(b.evening_time) ? b.evening_time : s.evening_time,
      soon_on: 'soon_on' in b ? (b.soon_on ? 1 : 0) : s.soon_on,
    };
    await env.DB.prepare(`UPDATE settings SET morning_on = ?, morning_time = ?, evening_on = ?, evening_time = ?, soon_on = ? WHERE user_id = ?`)
      .bind(next.morning_on, next.morning_time, next.evening_on, next.evening_time, next.soon_on, user.id).run();
    return json({ settings: { user_id: user.id, ...next } });
  }
  if (path === '/api/push/key' && method === 'GET') return json({ publicKey: (await vapidKeys(env)).publicKey });
  if (path === '/api/push/subscribe' && method === 'POST') {
    const { endpoint } = await body(request);
    return (await subscribe(env, user.id, endpoint)) ? json({ ok: true }) : fail('That subscription is not valid.');
  }
  if (path === '/api/push/unsubscribe' && method === 'POST') {
    const { endpoint } = await body(request);
    if (endpoint) await unsubscribe(env, endpoint);
    return json({ ok: true });
  }
  if (path === '/api/push/pending' && method === 'GET') {
    return json({ notifications: await takePending(env, user.id, url.searchParams.get('endpoint') || '') });
  }
  if (path === '/api/push/test' && method === 'POST') {
    const r = await notifyUser(env, user.id, { title: 'Test nudge', body: 'Nudges are working on this phone.', tag: 'test', url: '/' });
    return json(r);
  }

  return fail('Not found.', 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    await ensureSchema(env);

    if (url.pathname.startsWith('/api/')) {
      try { return await api(request, env, url); } catch (e) {
        console.error(e);
        return fail('Something went wrong on the server.', 500);
      }
    }

    // One-time link that signs a phone in.
    const link = url.pathname.match(/^\/link\/([A-Za-z0-9_-]{20,})$/);
    if (link) {
      const userId = await redeemLinkToken(env, link[1]);
      if (!userId) {
        return new Response('<!doctype html><meta name=viewport content="width=device-width"><body style="font:20px system-ui;padding:2em">This link has already been used or has expired. Ask for a new one.</body>',
          { status: 410, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      const token = await createSession(env, userId);
      return new Response(null, { status: 302, headers: { location: '/?welcome=1', 'set-cookie': sessionCookie(token) } });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    await ensureSchema(env);
    ctx.waitUntil(runNudges(env, new Date(event.scheduledTime)).catch((e) => console.error('nudges failed', e)));
  },
};
