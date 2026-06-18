const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const dataDir = process.env.DATA_DIR || path.join(os.tmpdir(), "swi-field-reports-data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "swi-reports.sqlite"));
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'field' CHECK(role IN ('admin', 'field')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS villages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    share_token TEXT UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id TEXT NOT NULL UNIQUE,
    share_token TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    village_id INTEGER NOT NULL REFERENCES villages(id),
    report_date TEXT NOT NULL,
    report_text TEXT NOT NULL,
    latitude REAL,
    longitude REAL,
    drive_folder_id TEXT,
    drive_document_id TEXT,
    status TEXT NOT NULL DEFAULT 'submitted',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    drive_file_id TEXT,
    public_url TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const villageColumns = db.pragma("table_info(villages)");
if (!villageColumns.some((column) => column.name === "share_token")) {
  db.exec("ALTER TABLE villages ADD COLUMN share_token TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS villages_share_token_idx ON villages(share_token)");
}
for (const village of db.prepare("SELECT id FROM villages WHERE share_token IS NULL").all()) {
  db.prepare("UPDATE villages SET share_token = ? WHERE id = ?")
    .run(crypto.randomBytes(24).toString("hex"), village.id);
}

function getSetting(key) {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(value));
}

module.exports = { db, getSetting, setSetting };
