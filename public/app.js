import {
  nowUK, addDays, daysBetween, friendlyDate, longDate, relativeLabel, inDaysText,
  formatTime, timeRange, describeEvent, answerForRange, minutesOf,
} from './shared/format.js';

const $ = (id) => document.getElementById(id);
const state = { user: null, partnerName: 'Dawn', events: [], today: nowUK().date, history: [] };

/* ---------- Small helpers ---------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* no body */ }
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('signed out'); }
  if (!res.ok && data.kind !== 'error') throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status });
  return data;
}

const prefs = {
  get speak() { return localStorage.getItem('speak') !== 'off'; },
  set speak(v) { localStorage.setItem('speak', v ? 'on' : 'off'); },
  get size() { return localStorage.getItem('size') || 'normal'; },
  set size(v) { localStorage.setItem('size', v); applySize(); },
};
function applySize() {
  document.documentElement.classList.remove('size-large', 'size-xlarge');
  if (prefs.size !== 'normal') document.documentElement.classList.add(`size-${prefs.size}`);
}

let toastTimer;
function toast(message, action) {
  const t = $('toast');
  t.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.run(); };
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 10000 : 3500);
}

/* ---------- Speaking out loud ---------- */

let voice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices();
  voice = voices.find((v) => v.lang === 'en-GB' && /female|libby|sonia|amy|emma/i.test(v.name))
    || voices.find((v) => v.lang === 'en-GB') || voices.find((v) => v.lang?.startsWith('en')) || null;
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

function speak(text, { force = false } = {}) {
  if (!('speechSynthesis' in window) || (!prefs.speak && !force)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-GB'; u.rate = 0.95;
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

/* ---------- Listening ---------- */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;

function setListening(on, button) {
  document.querySelectorAll('.mic').forEach((b) => b.classList.toggle('listening', on && b === button));
  $('mic-status').textContent = on ? 'Listening… speak now' : '';
}

/** Listens once, writing words into `input` as they come, then calls onDone(text). */
function listen(input, button, onDone) {
  if (rec) { rec.stop(); return; }
  if (!SR) {
    input.focus();
    toast('Tap the microphone on your keyboard to speak.');
    return;
  }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  rec = new SR();
  rec.lang = 'en-GB';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let heard = '';
  rec.onresult = (e) => {
    heard = Array.from(e.results).map((r) => r[0].transcript).join('');
    input.value = heard;
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Please allow the microphone for the diary.');
    else if (e.error === 'no-speech') toast("I didn't hear anything. Try again?");
    else if (e.error === 'network') toast('Speech needs an internet connection.');
  };
  rec.onend = () => {
    rec = null;
    setListening(false);
    if (heard.trim()) onDone(heard.trim());
  };
  try { rec.start(); setListening(true, button); } catch { rec = null; }
}

/* ---------- The diary list ---------- */

function eventCard(ev, today, now) {
  const past = ev.date === today && ev.start_time && minutesOf(ev.end_time || ev.start_time) < minutesOf(now.time);
  const who = ev.updated_by !== ev.created_by ? `Changed by ${ev.updated_by_name}` : `Added by ${ev.created_by_name}`;
  const time = ev.start_time
    ? `${formatTime(ev.start_time)}${ev.end_time ? `<small>to ${formatTime(ev.end_time)}</small>` : ''}`
    : 'Any time';
  return `<button class="event${past ? ' past' : ''}" type="button" data-id="${ev.id}">
    <div class="time">${time}</div>
    <div>
      <div class="title">${esc(ev.title)}</div>
      ${ev.location ? `<div class="meta">At ${esc(ev.location)}</div>` : ''}
      ${ev.notes ? `<div class="meta">${esc(ev.notes)}</div>` : ''}
      <div class="by">${esc(who)}</div>
    </div>
  </button>`;
}

function renderList() {
  const now = nowUK();
  const today = now.date;
  state.today = today;
  $('today-date').textContent = longDate(today, today);
  const byDate = new Map();
  for (const ev of state.events) {
    if (!byDate.has(ev.date)) byDate.set(ev.date, []);
    byDate.get(ev.date).push(ev);
  }
  let html = '';
  const day = (date, extraClass = '') => {
    const list = byDate.get(date) || [];
    const rel = relativeLabel(date, today);
    const heading = rel || longDate(date, today);
    const sub = rel ? longDate(date, today) : inDaysText(date, today);
    return `<section class="day ${extraClass}">
      <div class="day-head"><h2>${esc(heading)}</h2><span class="when">${esc(sub)}</span></div>
      ${list.length ? list.map((ev) => eventCard(ev, today, now)).join('') : `<p class="empty">Nothing in the diary${rel ? ` ${rel.toLowerCase()}` : ''}.</p>`}
    </section>`;
  };
  html += day(today, 'is-today');
  html += day(addDays(today, 1));
  const weekEnd = addDays(today, 7);
  const later = [...byDate.keys()].filter((d) => d > addDays(today, 1)).sort();
  let laterStarted = false;
  for (const d of later) {
    if (d > weekEnd && !laterStarted) { html += '<h2 class="later-head">Further ahead</h2>'; laterStarted = true; }
    html += day(d);
  }
  if (!later.length) html += '<p class="muted" style="margin-top:1.4rem">Nothing else in the next three months.</p>';
  $('list').innerHTML = html;
}

async function loadEvents() {
  try {
    const data = await api(`/api/events?from=${nowUK().date}&to=${addDays(nowUK().date, 90)}`);
    state.events = data.events;
    localStorage.setItem('events-cache', JSON.stringify({ at: Date.now(), events: data.events }));
    $('offline').hidden = true;
  } catch (e) {
    if (e.message === 'signed out') return;
    const cached = JSON.parse(localStorage.getItem('events-cache') || 'null');
    if (cached) state.events = cached.events.filter((ev) => ev.date >= nowUK().date);
    $('offline').hidden = false;
  }
  renderList();
}

/* ---------- Sheets: answers, confirmations, questions ---------- */

const sheet = $('sheet');
function openSheet(html) {
  $('sheet-body').innerHTML = html;
  if (!sheet.open) sheet.showModal();
}
function closeSheet() {
  if (sheet.open) sheet.close();
  state.history = [];
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}
sheet.addEventListener('close', () => { state.history = []; });
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });

function eventSummaryHTML(ev, today) {
  return `<div class="change">
    <div class="title" style="font-weight:750;font-size:1.2rem">${esc(ev.title)}</div>
    <div>${esc(friendlyDate(ev.date, today))}${ev.start_time ? `, ${esc(timeRange(ev))}` : ''}</div>
    ${ev.location ? `<div class="muted">At ${esc(ev.location)}</div>` : ''}
    ${ev.notes ? `<div class="muted">${esc(ev.notes)}</div>` : ''}
  </div>`;
}

function showThinking(said) {
  openSheet(`<p class="you-said">"${esc(said)}"</p><h2>Just a moment…</h2>`);
}

async function ask(text) {
  $('ask-input').value = '';
  showThinking(text);
  state.history.push({ role: 'user', text });
  let r;
  try {
    r = await api('/api/interpret', { method: 'POST', body: { text, history: state.history.slice(0, -1) } });
  } catch (e) {
    if (e.message === 'signed out') return;
    r = { kind: 'error', text: navigator.onLine ? "Sorry, something went wrong. You can use the Add button instead." : "There's no internet connection right now, so I can't understand speech. You can still look at the diary." };
  }
  state.history.push({ role: 'assistant', text: r.text });
  showResult(r, text);
}

function showResult(r, said) {
  const today = nowUK().date;
  const youSaid = said ? `<p class="you-said">"${esc(said)}"</p>` : '';
  if (r.kind === 'confirm') {
    let body;
    let yes = 'Yes, save it';
    let heading = 'Add this to the diary?';
    if (r.op === 'update') {
      heading = 'Change this?';
      yes = 'Yes, change it';
      body = `<div class="change"><div class="was">${esc(describeEvent(r.before, today))}</div></div>
        <p style="text-align:center;margin:0.3rem">becomes</p>${eventSummaryHTML(r.event, today)}`;
    } else if (r.op === 'delete') {
      heading = 'Remove this?';
      yes = 'Yes, remove it';
      body = eventSummaryHTML(r.event, today);
    } else {
      body = eventSummaryHTML(r.event, today);
    }
    openSheet(`${youSaid}<h2>${heading}</h2>${body}
      <div class="actions">
        <button class="btn ${r.op === 'delete' ? 'danger' : 'primary'} big" id="s-yes" type="button">${yes}</button>
        ${r.op !== 'delete' ? '<button class="btn secondary" id="s-edit" type="button">Change the details</button>' : ''}
        <button class="btn secondary" id="s-no" type="button">No</button>
      </div>`);
    speak(r.text);
    $('s-yes').onclick = () => applyProposal(r);
    $('s-no').onclick = () => { closeSheet(); speak('OK, nothing changed.'); };
    if ($('s-edit')) $('s-edit').onclick = () => { closeSheet(); openEditor(r.op === 'update' ? r.event : { ...r.event, id: undefined }); };
    return;
  }
  if (r.kind === 'answer') {
    const list = (r.events || []).map((ev) => `<div style="margin-bottom:0.5rem">${eventSummaryHTML(ev, today)}</div>`).join('');
    openSheet(`${youSaid}<p class="said">${esc(r.text)}</p>${list}
      <div class="actions">
        <button class="btn primary big" id="s-done" type="button">Done</button>
        <button class="btn secondary" id="s-again" type="button">Read it to me</button>
      </div>`);
    speak(r.text);
    $('s-done').onclick = closeSheet;
    $('s-again').onclick = () => speak(r.text, { force: true });
    return;
  }
  // clarify or error
  const isError = r.kind === 'error';
  openSheet(`${youSaid}<p class="said">${esc(r.text)}</p>
    ${isError ? '' : `<form class="reply" id="reply-form" autocomplete="off">
      <input id="reply-input" placeholder="Your answer" enterkeyhint="send">
      <button class="mic" id="reply-mic" type="button" aria-label="Answer by speaking">${$('mic').innerHTML}</button>
    </form>`}
    <div class="actions">
      ${isError ? '<button class="btn primary big" id="s-add" type="button">Add it myself</button>' : ''}
      <button class="btn secondary" id="s-cancel" type="button">${isError ? 'Close' : 'Never mind'}</button>
    </div>`);
  speak(r.text);
  $('s-cancel').onclick = closeSheet;
  if (isError) {
    $('s-add').onclick = () => { closeSheet(); openEditor(); };
  } else {
    const input = $('reply-input');
    $('reply-form').onsubmit = (e) => { e.preventDefault(); if (input.value.trim()) ask(input.value.trim()); };
    $('reply-mic').onclick = () => listen(input, $('reply-mic'), (t) => ask(t));
  }
}

async function applyProposal(r) {
  try {
    if (r.op === 'add') {
      await api('/api/events', { method: 'POST', body: r.event });
      closeSheet(); speak('Saved.'); toast('Saved in the diary');
    } else if (r.op === 'update') {
      await api(`/api/events/${r.id}`, { method: 'PATCH', body: r.changes });
      closeSheet(); speak('Changed.'); toast('Changed');
    } else if (r.op === 'delete') {
      await removeWithUndo(r.id);
      closeSheet();
    }
    await loadEvents();
  } catch (e) {
    if (e.message !== 'signed out') toast(e.message);
  }
}

async function removeWithUndo(id) {
  await api(`/api/events/${id}`, { method: 'DELETE' });
  speak('Removed.');
  toast('Removed from the diary', {
    label: 'Undo',
    run: async () => { await api(`/api/events/${id}/restore`, { method: 'POST' }); toast('Put back'); loadEvents(); },
  });
}

/** Answers "what's on" for a period without needing the AI (used by shortcuts and buttons). */
function showPeriod(from, to, label) {
  const today = nowUK().date;
  const list = state.events.filter((ev) => ev.date >= from && ev.date <= to);
  showResult({ kind: 'answer', events: list, text: answerForRange(list, from, to, today, label) });
}

/* ---------- Editor ---------- */

const editor = $('editor');
let editing = null;

function openEditor(ev = null) {
  editing = ev && ev.id ? ev : null;
  const f = $('edit-form');
  f.reset();
  $('edit-error').textContent = '';
  $('edit-title').textContent = editing ? 'Change this' : 'Add to the diary';
  $('edit-delete').hidden = !editing;
  const v = ev || {};
  f.title.value = v.title || '';
  f.date.value = v.date || nowUK().date;
  f.start_time.value = v.start_time || '';
  f.end_time.value = v.end_time || '';
  f.location.value = v.location || '';
  f.notes.value = v.notes || '';
  editor.showModal();
  if (!editing) f.title.focus();
}

$('edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    title: f.title.value, date: f.date.value, start_time: f.start_time.value || null,
    end_time: f.end_time.value || null, location: f.location.value || null, notes: f.notes.value || null,
  };
  if (body.end_time && !body.start_time) { $('edit-error').textContent = 'Add a start time too, or clear the "Until" time.'; return; }
  try {
    if (editing) await api(`/api/events/${editing.id}`, { method: 'PATCH', body });
    else await api('/api/events', { method: 'POST', body });
    editor.close();
    toast(editing ? 'Changed' : 'Saved in the diary');
    await loadEvents();
  } catch (err) {
    $('edit-error').textContent = err.message;
  }
});
$('edit-cancel').onclick = () => editor.close();
$('edit-delete').onclick = () => {
  const ev = editing;
  editor.close();
  showResult({ kind: 'confirm', op: 'delete', id: ev.id, event: ev, text: `Remove ${describeEvent(ev, nowUK().date)}?` });
};

/* ---------- Settings, reminders, phone set-up ---------- */

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $('install-btn').hidden = false; });
$('install-btn').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null; $('install-btn').hidden = true;
};

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function pushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function refreshPushStatus() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const sub = supported ? await pushSubscription() : null;
  const on = !!sub && Notification.permission === 'granted';
  $('push-status').textContent = !supported ? "This phone's browser can't show reminders."
    : Notification.permission === 'denied' ? 'Reminders are blocked. Allow notifications for this app in the phone settings, then come back here.'
      : on ? 'Reminders are on for this phone.' : 'Reminders are off for this phone.';
  $('push-on').hidden = on || !supported || Notification.permission === 'denied';
  $('push-options').hidden = !on;
  return on;
}

async function turnOnPush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { await refreshPushStatus(); return false; }
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api('/api/push/key');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    await api('/api/push/subscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
    toast('Reminders are on');
    await refreshPushStatus();
    return true;
  } catch (e) {
    toast("Couldn't turn on reminders. Try again.");
    return false;
  }
}

async function openSettings() {
  $('s-speak').checked = prefs.speak;
  $('s-size').value = prefs.size;
  $('owner-only').hidden = state.user.id !== 'owner';
  $('link-box').hidden = true;
  $('signed-in-as').textContent = `Signed in as ${state.user.name}.`;
  $('settings').showModal();
  refreshPushStatus();
  try {
    const { settings: s } = await api('/api/settings');
    $('s-morning').checked = !!s.morning_on; $('s-morning-time').value = s.morning_time;
    $('s-evening').checked = !!s.evening_on; $('s-evening-time').value = s.evening_time;
    $('s-soon').checked = !!s.soon_on;
    const { activity } = await api('/api/activity');
    $('activity').innerHTML = activity.length ? activity.map((a) => {
      const d = new Date(a.at);
      const when = d.toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
      return `<li><b>${esc(a.who)}</b> ${esc(a.action)} ${esc(a.summary)} <span class="muted">(${esc(when)})</span></li>`;
    }).join('') : '<li class="muted">No changes yet.</li>';
  } catch { /* offline */ }
}

function saveSettings() {
  api('/api/settings', {
    method: 'PUT',
    body: {
      morning_on: $('s-morning').checked, morning_time: $('s-morning-time').value,
      evening_on: $('s-evening').checked, evening_time: $('s-evening-time').value,
      soon_on: $('s-soon').checked,
    },
  }).then(() => toast('Saved')).catch(() => toast("Couldn't save that setting."));
}

function wireSettings() {
  $('open-settings').onclick = openSettings;
  $('settings-close').onclick = () => $('settings').close();
  $('push-on').onclick = turnOnPush;
  $('push-test').onclick = async () => {
    const r = await api('/api/push/test', { method: 'POST' });
    toast(r.phones ? 'Test reminder sent' : 'Turn on reminders first');
  };
  ['s-morning', 's-morning-time', 's-evening', 's-evening-time', 's-soon'].forEach((id) => $(id).addEventListener('change', saveSettings));
  $('s-speak').onchange = (e) => { prefs.speak = e.target.checked; };
  $('s-size').onchange = (e) => { prefs.size = e.target.value; };
  $('make-link').onclick = async () => {
    const r = await api('/api/link', { method: 'POST', body: { who: 'partner' } });
    $('link-url').value = r.url;
    $('link-box').hidden = false;
    $('link-share').hidden = !navigator.share;
  };
  $('link-share').onclick = () => navigator.share({ title: 'Your diary', text: `${state.partnerName}, tap this link to set up your diary:`, url: $('link-url').value }).catch(() => {});
  $('link-copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('link-url').value); toast('Link copied'); } catch { $('link-url').select(); }
  };
  $('sign-out').onclick = async () => {
    const sub = await pushSubscription().catch(() => null);
    if (sub) { await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); }
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    $('settings').close();
    showLogin();
  };
}

/* ---------- Welcome (first time on a phone) ---------- */

function showWelcome() {
  const name = state.user.name;
  openSheet(`<h2>Hello ${esc(name)}</h2>
    <p class="said">This is your diary. Tap the big microphone and say things like:</p>
    <ul class="said">
      <li>"What have I got tomorrow?"</li>
      <li>"Anything next week?"</li>
      <li>"Hospital on Tuesday at half two"</li>
    </ul>
    <p>It will always check with you before it saves anything.</p>
    <div class="actions">
      <button class="btn primary big" id="w-push" type="button">Turn on reminders</button>
      ${installPrompt ? '<button class="btn secondary" id="w-install" type="button">Put it on my home screen</button>' : ''}
      <button class="btn secondary" id="w-done" type="button">Start</button>
    </div>`);
  $('w-push').onclick = async () => { if (await turnOnPush()) $('w-push').hidden = true; };
  $('w-done').onclick = closeSheet;
  if ($('w-install')) $('w-install').onclick = () => $('install-btn').click();
}

/* ---------- Start-up ---------- */

function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { passphrase: $('passphrase').value } });
    $('passphrase').value = '';
    start();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
});

function wireMain() {
  $('ask').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = $('ask-input').value.trim();
    if (t) ask(t);
  });
  $('mic').onclick = () => listen($('ask-input'), $('mic'), (t) => ask(t));
  $('add-btn').onclick = () => openEditor();
  $('week-btn').onclick = () => { const t = nowUK().date; showPeriod(t, addDays(t, 6), 'Over the next seven days'); };
  $('list').addEventListener('click', (e) => {
    const card = e.target.closest('.event');
    if (!card) return;
    const ev = state.events.find((x) => String(x.id) === card.dataset.id);
    if (ev) openEditor(ev);
  });
  // Keep things fresh when the app is reopened or the day changes.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.user) loadEvents(); });
  setInterval(() => { if (!document.hidden && state.user) renderList(); }, 60000);
  window.addEventListener('online', () => { if (state.user) loadEvents(); });
}

async function start() {
  try {
    const me = await api('/api/me');
    state.user = me.user;
    state.partnerName = me.partnerName;
    document.querySelectorAll('.partner-name').forEach((el) => { el.textContent = me.partnerName; });
  } catch (e) {
    if (e.message === 'signed out') return;
    // Offline on start-up: show the cached diary if we have one.
    if (!localStorage.getItem('events-cache')) { showLogin(); return; }
    state.user = JSON.parse(localStorage.getItem('user') || 'null') || { id: 'partner', name: '' };
  }
  localStorage.setItem('user', JSON.stringify(state.user));
  document.title = `${state.user.name ? `${state.user.name}'s ` : ''}Diary`;
  $('login').hidden = true;
  $('app').hidden = false;
  await loadEvents();

  const params = new URLSearchParams(location.search);
  const action = params.get('do');
  const today = nowUK().date;
  if (params.get('welcome')) showWelcome();
  else if (action === 'today') showPeriod(today, today, 'Today');
  else if (action === 'tomorrow') showPeriod(addDays(today, 1), addDays(today, 1), 'Tomorrow');
  else if (action === 'speak') $('mic-status').textContent = 'Tap the microphone and speak';
  if (params.toString()) history.replaceState(null, '', '/');
}

applySize();
wireMain();
wireSettings();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
start();

// Exposed for testing only.
window.__diary = { state, showResult, daysBetween };
