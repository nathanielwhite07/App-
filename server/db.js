'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  school TEXT,
  location TEXT,
  resume_filename TEXT,
  resume_text TEXT,
  profile_json TEXT,            -- extracted interests/skills/schools from resume
  calendar_token TEXT,          -- secret token for the subscribable .ics feed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  industry TEXT,
  hq TEXT
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  title TEXT,
  department TEXT,
  company_id INTEGER REFERENCES companies(id),
  location TEXT,
  school TEXT,
  interests TEXT,               -- comma separated
  bio TEXT,
  linkedin TEXT,
  source TEXT DEFAULT 'import',
  last_verified_at TEXT,
  verification_json TEXT,       -- cached result of the last verification
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(first_name, last_name, company_id)
);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);

CREATE TABLE IF NOT EXISTS saved_contacts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'saved',   -- saved | emailed | replied | meeting | closed
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, contact_id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'meeting',   -- meeting | follow_up | deadline
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  starts_at TEXT NOT NULL,                -- ISO-8601 UTC
  duration_min INTEGER NOT NULL DEFAULT 30,
  uid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function openDb(file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'app.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/** Wrap a function in BEGIN/COMMIT, rolling back on error. */
function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function upsertCompany(db, { name, domain, industry = null, hq = null }) {
  const existing = db.prepare('SELECT id FROM companies WHERE name = ?').get(name);
  if (existing) {
    db.prepare('UPDATE companies SET domain = COALESCE(?, domain), industry = COALESCE(?, industry), hq = COALESCE(?, hq) WHERE id = ?')
      .run(domain || null, industry, hq, existing.id);
    return existing.id;
  }
  return Number(db.prepare('INSERT INTO companies (name, domain, industry, hq) VALUES (?, ?, ?, ?)')
    .run(name, domain, industry, hq).lastInsertRowid);
}

/** Insert or update a contact. Returns { id, created }. */
function upsertContact(db, c) {
  const companyId = c.company_id ?? upsertCompany(db, { name: c.company, domain: c.domain, industry: c.industry });
  const existing = db.prepare('SELECT id FROM contacts WHERE first_name = ? AND last_name = ? AND company_id = ?')
    .get(c.first_name, c.last_name, companyId);
  const fields = [c.email || null, c.title || null, c.department || null, c.location || null, c.school || null,
    c.interests || null, c.bio || null, c.linkedin || null, c.source || 'import'];
  if (existing) {
    db.prepare(`UPDATE contacts SET email = COALESCE(?, email), title = COALESCE(?, title), department = COALESCE(?, department),
      location = COALESCE(?, location), school = COALESCE(?, school), interests = COALESCE(?, interests),
      bio = COALESCE(?, bio), linkedin = COALESCE(?, linkedin), source = ? WHERE id = ?`).run(...fields, existing.id);
    return { id: existing.id, created: false };
  }
  const r = db.prepare(`INSERT INTO contacts (email, title, department, location, school, interests, bio, linkedin, source,
      first_name, last_name, company_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(...fields, c.first_name, c.last_name, companyId);
  return { id: Number(r.lastInsertRowid), created: true };
}

function seedIfEmpty(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM contacts').get();
  if (n > 0) return 0;
  const seed = require('./seed/contacts.json');
  tx(db, () => {
    for (const co of seed.companies) upsertCompany(db, co);
    for (const c of seed.contacts) {
      const co = seed.companies.find((x) => x.name === c.company);
      upsertContact(db, { ...c, domain: co.domain, source: 'seed' });
    }
  });
  return seed.contacts.length;
}

module.exports = { openDb, tx, upsertCompany, upsertContact, seedIfEmpty };
