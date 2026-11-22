'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

function openDb(file = process.env.DB_FILE || path.join(__dirname, '..', '..', 'data', 'bbsa.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db, file);
  return db;
}

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

/** Bring databases created by earlier versions up to the current schema. */
function migrate(db, file) {
  if (!columns(db, 'users').includes('calendar_provider')) db.exec('ALTER TABLE users ADD COLUMN calendar_provider TEXT');
  if (!columns(db, 'firms').includes('max_local')) db.exec('ALTER TABLE firms ADD COLUMN max_local INTEGER');

  // v1 programs had a single industry_id; v2 allows several industries plus status/timing fields.
  // The old rows are saved next to the database before the table is rebuilt.
  if (columns(db, 'programs').includes('industry_id')) {
    const old = db.prepare('SELECT p.*, i.slug AS industry FROM programs p LEFT JOIN industries i ON i.id = p.industry_id').all();
    if (old.length && file !== ':memory:') {
      const out = path.join(path.dirname(file), `backup-programs-v1-${Date.now()}.json`);
      fs.writeFileSync(out, JSON.stringify(old, null, 2));
      console.log(`Saved ${old.length} programs from the previous version to ${out}`);
    }
    tx(db, () => {
      db.exec('UPDATE events SET program_id = NULL WHERE program_id IS NOT NULL; DROP TABLE programs;');
      db.exec(SCHEMA);
    });
  }
}

/** Run fn inside BEGIN/COMMIT, rolling back on error. */
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

module.exports = { openDb, tx };
