// Diary events: reading, adding, changing, removing (soft delete, so it can be undone).

import { isValidDate, isValidTime, longDate, formatTime, sortEvents } from '../public/shared/format.js';

/** Fixed wording for the change log (no 'today' or 'tomorrow', which go out of date). */
const logText = (ev) => `${ev.title}, ${longDate(ev.date)}${ev.start_time ? ` at ${formatTime(ev.start_time)}` : ''}`;

const FIELDS = ['title', 'date', 'start_time', 'end_time', 'location', 'notes'];
const COLS = `e.id, e.title, e.date, e.start_time, e.end_time, e.location, e.notes,
  e.created_by, e.updated_by, e.created_at, e.updated_at,
  cu.name AS created_by_name, uu.name AS updated_by_name`;
const FROM = `FROM events e LEFT JOIN users cu ON cu.id = e.created_by LEFT JOIN users uu ON uu.id = e.updated_by`;

function clean(v, max) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim().slice(0, max);
  return s === '' ? null : s;
}

/** Validates and normalises event fields. `partial` allows missing fields (for updates). */
export function validateEvent(input, { partial = false } = {}) {
  const out = {};
  const errors = [];
  for (const f of FIELDS) {
    if (!(f in (input || {}))) continue;
    out[f] = clean(input[f], f === 'notes' ? 1000 : 200);
  }
  if (!partial || 'title' in out) if (!out.title) errors.push('It needs a name, like "Physio" or "Lunch with Amanda".');
  if (!partial || 'date' in out) if (!isValidDate(out.date)) errors.push('It needs a proper date.');
  if (out.start_time && !isValidTime(out.start_time)) errors.push('The start time is not valid.');
  if (out.end_time && !isValidTime(out.end_time)) errors.push('The end time is not valid.');
  if (out.end_time && !out.start_time && !partial) out.end_time = null;
  return { value: out, errors };
}

export async function listEvents(env, from, to) {
  const { results } = await env.DB.prepare(
    `SELECT ${COLS} ${FROM} WHERE e.deleted_at IS NULL AND e.date >= ? AND e.date <= ?
      ORDER BY e.date, COALESCE(e.start_time, ''), e.id`,
  ).bind(from, to).all();
  return sortEvents(results);
}

export async function getEvent(env, id, { includeDeleted = false } = {}) {
  return env.DB.prepare(
    `SELECT ${COLS}, e.deleted_at ${FROM} WHERE e.id = ? ${includeDeleted ? '' : 'AND e.deleted_at IS NULL'}`,
  ).bind(id).first();
}

async function log(env, userId, action, eventId, summary) {
  await env.DB.prepare(`INSERT INTO activity (user_id, action, event_id, summary, at) VALUES (?, ?, ?, ?, ?)`)
    .bind(userId, action, eventId, summary, new Date().toISOString()).run();
}

export async function addEvent(env, user, input) {
  const { value, errors } = validateEvent(input);
  if (errors.length) return { errors };
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO events (title, date, start_time, end_time, location, notes, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(value.title, value.date, value.start_time ?? null, value.end_time ?? null,
    value.location ?? null, value.notes ?? null, user.id, user.id, now, now).run();
  const id = res.meta.last_row_id;
  const ev = await getEvent(env, id);
  await log(env, user.id, 'added', id, logText(ev));
  return { event: ev };
}

export async function updateEvent(env, user, id, input) {
  const existing = await getEvent(env, id);
  if (!existing) return { notFound: true };
  const { value, errors } = validateEvent(input, { partial: true });
  if (errors.length) return { errors };
  const merged = { ...existing, ...value };
  if (!merged.start_time) merged.end_time = null;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE events SET title = ?, date = ?, start_time = ?, end_time = ?, location = ?, notes = ?,
       updated_by = ?, updated_at = ? WHERE id = ?`,
  ).bind(merged.title, merged.date, merged.start_time ?? null, merged.end_time ?? null,
    merged.location ?? null, merged.notes ?? null, user.id, now, id).run();
  const ev = await getEvent(env, id);
  await log(env, user.id, 'changed', id, logText(ev));
  return { event: ev };
}

export async function deleteEvent(env, user, id) {
  const existing = await getEvent(env, id);
  if (!existing) return { notFound: true };
  await env.DB.prepare(`UPDATE events SET deleted_at = ?, updated_by = ? WHERE id = ?`)
    .bind(new Date().toISOString(), user.id, id).run();
  await log(env, user.id, 'removed', id, logText(existing));
  return { event: existing };
}

export async function restoreEvent(env, user, id) {
  const existing = await getEvent(env, id, { includeDeleted: true });
  if (!existing) return { notFound: true };
  await env.DB.prepare(`UPDATE events SET deleted_at = NULL, updated_by = ?, updated_at = ? WHERE id = ?`)
    .bind(user.id, new Date().toISOString(), id).run();
  const ev = await getEvent(env, id);
  await log(env, user.id, 'put back', id, logText(ev));
  return { event: ev };
}

export async function recentActivity(env, limit = 20) {
  const { results } = await env.DB.prepare(
    `SELECT a.action, a.summary, a.at, u.name AS who FROM activity a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT ?`,
  ).bind(limit).all();
  return results;
}
