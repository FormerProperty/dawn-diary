// Database schema. Created automatically on first use, so there are no migration steps.

const SCHEMA_VERSION = 1;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
     created_at TEXT NOT NULL, last_seen TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS link_tokens (
     token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
     expires_at TEXT NOT NULL, used_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     title TEXT NOT NULL, date TEXT NOT NULL,
     start_time TEXT, end_time TEXT, location TEXT, notes TEXT,
     created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS events_date ON events(date)`,
  `CREATE TABLE IF NOT EXISTS activity (
     id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
     action TEXT NOT NULL, event_id INTEGER, summary TEXT NOT NULL, at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (
     user_id TEXT PRIMARY KEY,
     morning_on INTEGER NOT NULL DEFAULT 1, morning_time TEXT NOT NULL DEFAULT '08:00',
     evening_on INTEGER NOT NULL DEFAULT 1, evening_time TEXT NOT NULL DEFAULT '18:00',
     soon_on INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS push_subs (
     id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
     endpoint TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS push_queue (
     id INTEGER PRIMARY KEY AUTOINCREMENT, sub_id INTEGER NOT NULL,
     title TEXT NOT NULL, body TEXT NOT NULL, tag TEXT, url TEXT,
     created_at TEXT NOT NULL, delivered_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sent_log (key TEXT PRIMARY KEY, at TEXT NOT NULL)`,
];

let ready = false;

export async function ensureSchema(env) {
  if (ready) return;
  try {
    const row = await env.DB.prepare(`SELECT value FROM config WHERE key = 'schema_version'`).first();
    if (row && Number(row.value) >= SCHEMA_VERSION) { ready = true; return; }
  } catch { /* table does not exist yet */ }
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO users (id, name) VALUES ('owner', ?), ('partner', ?)`)
      .bind(env.OWNER_NAME || 'Tanya', env.PARTNER_NAME || 'Dawn'),
    env.DB.prepare(`INSERT OR IGNORE INTO settings (user_id) VALUES ('owner'), ('partner')`),
    env.DB.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('schema_version', ?)`).bind(String(SCHEMA_VERSION)),
    env.DB.prepare(`INSERT OR IGNORE INTO config (key, value) VALUES ('created_at', ?)`).bind(now),
  ]);
  ready = true;
}

export async function getConfig(env, key) {
  const row = await env.DB.prepare(`SELECT value FROM config WHERE key = ?`).bind(key).first();
  return row ? row.value : null;
}

export async function setConfig(env, key, value) {
  await env.DB.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`).bind(key, value).run();
}

export async function userName(env, id) {
  const row = await env.DB.prepare(`SELECT name FROM users WHERE id = ?`).bind(id).first();
  return row ? row.name : id;
}
