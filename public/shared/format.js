// Shared date and wording helpers, used by both the app and the server.
// Dates are plain 'YYYY-MM-DD' strings and times 'HH:MM' strings, always UK local time.

export const TZ = 'Europe/London';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** Current UK date and time as { date, time, weekday }. */
export function nowUK(at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t) => parts.find((p) => p.type === t).value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  return { date, time: `${get('hour')}:${get('minute')}`, weekday: weekdayName(date) };
}

function toUTC(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

export function addDays(date, n) {
  const dt = toUTC(date);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((toUTC(b) - toUTC(a)) / 86400000);
}

export function weekdayName(date) {
  return DAYS[toUTC(date).getUTCDay()];
}

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return toUTC(s).toISOString().slice(0, 10) === s;
}

export function isValidTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function minutesOf(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** '14:30' -> '2:30pm', '11:00' -> '11am', '12:00' -> '12 noon'. */
export function formatTime(time) {
  if (!time) return '';
  const [h, m] = time.split(':').map(Number);
  if (h === 12 && m === 0) return '12 noon';
  if (h === 0 && m === 0) return 'midnight';
  const suffix = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
}

/** 'Tuesday 1 December' (adds the year if it is not this year). */
export function longDate(date, today) {
  const dt = toUTC(date);
  let s = `${DAYS[dt.getUTCDay()]} ${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}`;
  if (today && date.slice(0, 4) !== today.slice(0, 4)) s += ` ${date.slice(0, 4)}`;
  return s;
}

export function relativeLabel(date, today) {
  const diff = daysBetween(today, date);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return '';
}

/** 'Tomorrow, Tuesday 24 November' or just 'Thursday 3 December'. */
export function friendlyDate(date, today) {
  const rel = relativeLabel(date, today);
  return rel ? `${rel}, ${longDate(date, today)}` : longDate(date, today);
}

export function inDaysText(date, today) {
  const diff = daysBetween(today, date);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff > 1) return `in ${diff} days`;
  if (diff === -1) return 'yesterday';
  return `${-diff} days ago`;
}

export function timeRange(ev) {
  if (!ev.start_time) return '';
  return ev.end_time
    ? `${formatTime(ev.start_time)} to ${formatTime(ev.end_time)}`
    : formatTime(ev.start_time);
}

/** One event as a spoken sentence fragment. */
export function describeEvent(ev, today, { withDate = true } = {}) {
  let s = ev.title;
  if (withDate) {
    const d = friendlyDate(ev.date, today);
    s += `, ${relativeLabel(ev.date, today) ? d.charAt(0).toLowerCase() + d.slice(1) : d}`;
  }
  if (ev.start_time) s += ` at ${formatTime(ev.start_time)}`;
  if (ev.location) s += `, at ${ev.location}`;
  return s;
}

function plural(n, word) {
  return `${n === 1 ? 'one' : n} ${word}${n === 1 ? '' : 's'}`;
}

/** Spoken answer for a list of events between two dates. */
export function answerForRange(events, from, to, today, label) {
  const sameDay = from === to;
  const when = label || (sameDay ? friendlyDate(from, today)
    : from === today ? `From today to ${longDate(to, today)}`
      : `Between ${longDate(from, today)} and ${longDate(to, today)}`);
  const whenCap = when.charAt(0).toUpperCase() + when.slice(1);
  if (!events.length) return `${whenCap}, there is nothing in the diary.`;
  const parts = events.map((ev) => describeEvent(ev, today, { withDate: !sameDay }));
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join('. ')}. And ${parts[parts.length - 1]}`;
  return `${whenCap}, you have ${plural(events.length, 'thing')}. ${list}.`;
}

/** Stable sort: by date, then untimed (all day) first, then by time. */
export function sortEvents(list) {
  return [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
    : (a.start_time || '') < (b.start_time || '') ? -1
      : (a.start_time || '') > (b.start_time || '') ? 1 : a.id - b.id));
}
