// Understanding what was said or typed.
// The AI only turns words into an instruction. It never saves anything, and it never
// answers questions from its own knowledge: answers are always built from the database.

import {
  nowUK, addDays, weekdayName, isValidDate, isValidTime, formatTime,
  friendlyDate, describeEvent, answerForRange, relativeLabel, inDaysText,
} from '../public/shared/format.js';
import { listEvents, getEvent, validateEvent } from './events.js';

const TOOL = {
  name: 'diary_action',
  description: 'Record what the person wants to do with the diary.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'update', 'delete', 'query', 'unclear'],
        description: 'add a new entry, update or delete an existing one, query (a question about what is coming up), or unclear if you need to ask something first.',
      },
      event: {
        type: 'object',
        description: 'For add: the full new entry. For update: ONLY the fields that change.',
        properties: {
          title: { type: 'string', description: 'Short name, capitalised, e.g. "Physio", "Lunch with Amanda", "Dentist".' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          start_time: { type: ['string', 'null'], description: 'HH:MM 24-hour, or null if no time was given.' },
          end_time: { type: ['string', 'null'], description: 'HH:MM 24-hour, or null.' },
          location: { type: ['string', 'null'] },
          notes: { type: ['string', 'null'], description: 'Anything else worth keeping, e.g. "bring letter", "Tanya driving", "in the morning".' },
        },
      },
      target_event_id: { type: 'integer', description: 'For update or delete: the id of the existing entry, from the list provided.' },
      query: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'YYYY-MM-DD' },
          to: { type: 'string', description: 'YYYY-MM-DD (same as from for a single day)' },
          keyword: { type: ['string', 'null'], description: 'Only for questions about a particular thing, e.g. "dentist" for "when is my dentist?". Otherwise null.' },
          label: { type: ['string', 'null'], description: 'How to say the period aloud, e.g. "Next week", "On Thursday", "Over the next seven days".' },
        },
      },
      clarification: { type: 'string', description: 'For unclear: one short, friendly question to ask.' },
    },
    required: ['action'],
  },
};

function systemPrompt(now, events) {
  const lines = [];
  for (let i = 0; i < 14; i++) {
    const d = addDays(now.date, i);
    lines.push(`${d} = ${weekdayName(d)}${i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : ''}`);
  }
  const diary = events.length
    ? events.map((e) => `id ${e.id} | ${e.date} ${weekdayName(e.date)} | ${e.start_time || 'no time'}${e.end_time ? `-${e.end_time}` : ''} | ${e.title}${e.location ? ` | at ${e.location}` : ''}`).join('\n')
    : '(the diary is empty)';
  return `You help someone keep track of their personal diary. They live in the UK and speak British English. Their wife also adds things for them. Requests are usually spoken, so expect speech-recognition mistakes and casual phrasing.

Right now it is ${now.weekday} ${now.date}, ${now.time} UK time.
Upcoming dates:
${lines.join('\n')}

Rules:
- Always call the diary_action tool exactly once.
- Dates: "Thursday" means the next Thursday from today (today if today is Thursday and it is still sensible). "Next Thursday" when said early in the week usually means the Thursday of next week; if genuinely ambiguous, pick the soonest Thursday that is not today. "Next week" means Monday to Sunday of the following week. "This weekend" means the coming Saturday and Sunday. Dates like "the 3rd" mean the next 3rd of a month. Write dates as YYYY-MM-DD.
- Times: "half three" is 15:30, "quarter to ten" is 09:45. For bare hours 1 to 7 with no am or pm, assume pm; 8 to 11 assume am unless the context says otherwise. If only a part of day is given ("in the morning"), leave start_time null and put that in notes.
- add needs at least a title and a date. If the date is missing, use action unclear and ask when it is.
- update and delete must name an entry from the diary list below by its id. If more than one entry could match, use unclear and ask which one, naming them with their days. If none match, use unclear and say you cannot find it.
- Questions such as "what have I got on Thursday", "anything next week", "when is my dentist", "what's coming up" are query. With no period given, use today to 7 days ahead. For "when is my X", search from today to a year ahead with a keyword.
- Never invent diary entries. Never answer a question yourself, just describe the query.
- If it is not about the diary at all, use unclear and gently say you can only help with the diary.

The diary (from a week ago onwards):
${diary}`;
}

async function callClaude(env, system, messages) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('The ANTHROPIC_API_KEY secret is not set.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.AI_MODEL || 'claude-haiku-5-5',
      max_tokens: 600,
      system,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL.name },
      messages,
    }),
  });
  if (!res.ok) throw new Error(`AI request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === 'tool_use');
  if (!block) throw new Error('AI did not return an instruction.');
  return block.input;
}

function changeSummary(before, after, today) {
  const bits = [];
  if (after.title !== before.title) bits.push(`call it "${after.title}"`);
  if (after.date !== before.date) bits.push(`move it to ${friendlyDate(after.date, today)}`);
  if ((after.start_time || null) !== (before.start_time || null)) {
    bits.push(after.start_time ? `make it ${formatTime(after.start_time)}` : 'take the time off');
  }
  if ((after.location || null) !== (before.location || null)) {
    bits.push(after.location ? `set the place to ${after.location}` : 'remove the place');
  }
  if ((after.notes || null) !== (before.notes || null)) bits.push('update the notes');
  return bits;
}

/**
 * Turns words into a proposal for the app to confirm, or an answer.
 * history: up to a few earlier [{ role: 'user'|'assistant', text }] turns, for follow-up answers.
 */
export async function interpret(env, text, history = [], interpretFn = null) {
  const now = nowUK();
  const today = now.date;
  const events = await listEvents(env, addDays(today, -7), addDays(today, 400));
  const messages = [];
  for (const h of history.slice(-4)) {
    if (h && typeof h.text === 'string' && (h.role === 'user' || h.role === 'assistant')) {
      messages.push({ role: h.role, content: h.text.slice(0, 500) });
    }
  }
  // Messages must alternate and start with the user.
  while (messages.length && messages[0].role !== 'user') messages.shift();
  messages.push({ role: 'user', content: String(text).slice(0, 1000) });
  const merged = [];
  for (const m of messages) {
    if (merged.length && merged[merged.length - 1].role === m.role) merged[merged.length - 1].content += `\n${m.content}`;
    else merged.push({ ...m });
  }

  const call = interpretFn || callClaude;
  const r = await call(env, systemPrompt(now, events), merged);
  return resolve(env, r, today);
}

/** Checks the AI's instruction against the real diary and turns it into something to show. */
export async function resolve(env, r, today) {
  const clarify = (t) => ({ kind: 'clarify', text: t });
  switch (r.action) {
    case 'add': {
      const ev = { start_time: null, end_time: null, location: null, notes: null, ...(r.event || {}) };
      const { value, errors } = validateEvent(ev);
      if (!value.title) return clarify('What should I call it?');
      if (errors.length) return clarify(value.date === undefined || value.date === null ? 'What day is it?' : "I didn't catch the day. What day is it?");
      const when = describeEvent(value, today);
      return {
        kind: 'confirm', op: 'add', event: value,
        text: `Add ${when}${value.notes ? `. Note: ${value.notes}` : ''}. Shall I save it?`,
      };
    }
    case 'update': {
      const before = r.target_event_id ? await getEvent(env, r.target_event_id) : null;
      if (!before) return clarify("I couldn't find that in the diary. Can you say which one you mean?");
      const changes = {};
      for (const [k, v] of Object.entries(r.event || {})) {
        if (['title', 'date', 'start_time', 'end_time', 'location', 'notes'].includes(k)) changes[k] = v;
      }
      if (changes.date && !isValidDate(changes.date)) return clarify("I didn't catch the new date. When should it be?");
      if (changes.start_time && !isValidTime(changes.start_time)) return clarify("I didn't catch the new time. What time should it be?");
      const after = { ...before, ...changes };
      const bits = changeSummary(before, after, today);
      if (!bits.length) return clarify(`What would you like to change about ${before.title}?`);
      return {
        kind: 'confirm', op: 'update', id: before.id, before, changes, event: after,
        text: `${describeEvent(before, today)}. I'll ${bits.join(', and ')}. Is that right?`,
      };
    }
    case 'delete': {
      const ev = r.target_event_id ? await getEvent(env, r.target_event_id) : null;
      if (!ev) return clarify("I couldn't find that in the diary. Can you say which one you mean?");
      return {
        kind: 'confirm', op: 'delete', id: ev.id, event: ev,
        text: `Remove ${describeEvent(ev, today)} from the diary?`,
      };
    }
    case 'query': {
      const q = r.query || {};
      let from = isValidDate(q.from) ? q.from : today;
      let to = isValidDate(q.to) ? q.to : addDays(from, 7);
      if (to < from) [from, to] = [to, from];
      let list = await listEvents(env, from, to);
      if (q.keyword) {
        const words = q.keyword.toLowerCase().split(/\s+/).filter(Boolean);
        list = list.filter((e) => {
          const hay = `${e.title} ${e.location || ''} ${e.notes || ''}`.toLowerCase();
          return words.some((w) => hay.includes(w));
        });
        if (!list.length) {
          return { kind: 'answer', from, to, events: [], text: `I can't find anything about ${q.keyword} in the diary.` };
        }
        const first = list[0];
        const when = `${friendlyDate(first.date, today)}${first.start_time ? ` at ${formatTime(first.start_time)}` : ''}`;
        const soon = relativeLabel(first.date, today) ? '' : `, ${inDaysText(first.date, today)}`;
        const where = first.location ? ` At ${first.location}.` : '';
        const text = list.length === 1
          ? `${first.title}: ${when}${soon}.${where}`
          : `The next ${first.title} is ${when}${soon}.${where} There are ${list.length} in the diary.`;
        return { kind: 'answer', from, to, events: list, text };
      }
      return { kind: 'answer', from, to, events: list, text: answerForRange(list, from, to, today, q.label) };
    }
    case 'unclear':
    default:
      return clarify(r.clarification || "Sorry, I didn't quite get that. Could you say it another way?");
  }
}

