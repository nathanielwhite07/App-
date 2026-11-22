'use strict';
// Internships: the rules the student page, the admin page and the tests all share.
// Data comes only from the seed file (server/content/internships.json) and officer edits.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tx } = require('../db');
const { parseCsv } = require('../csv');

const SEED_FILE = path.join(__dirname, 'internships.json');

// Same columns, same order, as the officers' spreadsheet.
const COLUMNS = ['id', 'company', 'industry', 'category', 'program', 'for_students', 'internship_summer', 'status', 'opens',
  'deadline', 'deadline_date', 'link', 'link_type', 'next_cycle', 'notes', 'source', 'as_of'];
const INDUSTRIES = ['Consulting', 'Finance', 'Tech'];
const STALE_DAYS = 30;

const OPEN_STATUSES = ['open', 'rolling', 'closing soon'];
const CLOSED_STATUSES = ['closed', 'mostly closed', 'likely closed'];
const UNSURE_STATUSES = ['not tracked', 'check site', 'unconfirmed'];

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 864e5);

/**
 * The status students see. A deadline date in the past always means "Closed", whatever
 * was stored. `group` drives the default sort and badge color:
 *   1 dated (future deadline) · 2 open/rolling · 3 expected · 4 other · 5 closed
 */
function computeStatus(row, today = ymd(new Date())) {
  const stored = String(row.status || '').trim();
  const s = stored.toLowerCase();
  if (row.deadline_date && row.deadline_date < today) return { status: 'Closed', group: 5, tone: 'closed', daysLeft: null, overridden: s !== 'closed' };
  const daysLeft = row.deadline_date ? dayDiff(row.deadline_date, today) : null;
  let group, tone;
  if (CLOSED_STATUSES.includes(s)) { group = 5; tone = 'closed'; }
  else if (row.deadline_date) { group = 1; tone = s === 'expected' ? 'expected' : 'open'; }
  else if (OPEN_STATUSES.includes(s)) { group = 2; tone = 'open'; }
  else if (s === 'expected') { group = 3; tone = 'expected'; }
  else { group = 4; tone = 'unknown'; }
  if (tone === 'open' && daysLeft != null && daysLeft <= 14) tone = 'soon';
  return { status: stored || 'Unknown', group, tone, daysLeft, overridden: false };
}

/** Default order: future deadlines (soonest first), open/rolling, expected, everything else, closed last. */
function sortInternships(rows, today = ymd(new Date())) {
  return rows
    .map((r) => ({ r, c: computeStatus(r, today) }))
    .sort((a, b) => a.c.group - b.c.group
      || (a.c.group === 1 ? a.r.deadline_date.localeCompare(b.r.deadline_date) : 0)
      || a.r.company.localeCompare(b.r.company) || a.r.id - b.r.id)
    .map((x) => x.r);
}

/** Button label for a link, or null when there's no link to show. */
function linkLabel(row) {
  if (!row.link) return null;
  const t = String(row.link_type || '').toLowerCase();
  if (t.startsWith('posting')) return t.includes('interest form') ? 'Apply (interest form)' : 'Apply';
  if (t.startsWith('careers')) return 'Careers page';
  if (t.startsWith('tracker guide')) return 'Tracker guide';
  return 'Open link';
}

/** Why a row needs an officer's attention: no_link, status (not tracked / check site / unconfirmed), stale. */
function attentionReasons(row, today = ymd(new Date())) {
  const reasons = [];
  if (!row.link) reasons.push('no_link');
  if (UNSURE_STATUSES.includes(String(row.status || '').toLowerCase())) reasons.push('status');
  if (!row.as_of || dayDiff(today, row.as_of) > STALE_DAYS) reasons.push('stale');
  return reasons;
}

// ---------- validation & CSV ----------
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const clean = (v, max = 2000) => {
  const s = v == null ? '' : String(v).trim();
  if (s.length > max) throw bad(`A field is too long (max ${max} characters).`);
  return s;
};

/** Normalise one row from a form, the seed file or a CSV line. */
function normalize(input, { rowLabel = 'Row' } = {}) {
  const r = Object.fromEntries(COLUMNS.map((c) => [c, clean(input[c])]));
  const id = r.id === '' ? null : Number(r.id);
  if (id !== null && (!Number.isInteger(id) || id < 1)) throw bad(`${rowLabel}: id must be a positive whole number.`);
  if (!r.company) throw bad(`${rowLabel}: company is required.`);
  if (!r.program) throw bad(`${rowLabel}: program is required.`);
  const industry = INDUSTRIES.find((i) => i.toLowerCase() === r.industry.toLowerCase());
  if (!industry) throw bad(`${rowLabel}: industry must be ${INDUSTRIES.join(', ')}.`);
  for (const k of ['deadline_date', 'as_of']) {
    if (r[k] && !/^\d{4}-\d{2}-\d{2}$/.test(r[k])) throw bad(`${rowLabel}: ${k} must be a date like 2027-01-15.`);
  }
  if (r.link && !/^https?:\/\//i.test(r.link)) throw bad(`${rowLabel}: link must start with http:// or https://`);
  return { ...r, id, industry };
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (rows) => [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';

/** Parse an officer CSV. Returns { rows, errors }; bad rows are reported, not imported. */
function fromCsv(text) {
  const [header, ...lines] = parseCsv(text);
  if (!header) return { rows: [], errors: ['The file is empty.'] };
  const cols = header.map((h) => h.trim().toLowerCase());
  const missing = ['company', 'industry', 'program'].filter((c) => !cols.includes(c));
  if (missing.length) return { rows: [], errors: [`Missing column(s): ${missing.join(', ')}. Export the current list to get the right headers.`] };
  const rows = [], errors = [];
  lines.forEach((line, i) => {
    const obj = Object.fromEntries(cols.map((c, j) => [c, line[j] ?? '']));
    try { rows.push(normalize(obj, { rowLabel: `Row ${i + 2}` })); } catch (err) { errors.push(err.message); }
  });
  return { rows, errors };
}

// ---------- database ----------
const SET_COLS = COLUMNS.filter((c) => c !== 'id');

/** Insert or update by id; rows without an id get the next free one. Returns the id. */
function upsert(db, row, by) {
  const vals = SET_COLS.map((c) => row[c] || null);
  if (row.id && db.prepare('SELECT 1 FROM internships WHERE id = ?').get(row.id)) {
    db.prepare(`UPDATE internships SET ${SET_COLS.map((c) => `${c} = ?`).join(', ')}, updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(...vals, by, row.id);
    return { id: row.id, created: false };
  }
  const id = row.id || (db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM internships').get().n);
  db.prepare(`INSERT INTO internships (id, ${SET_COLS.join(', ')}, updated_by) VALUES (?, ${SET_COLS.map(() => '?').join(', ')}, ?)`)
    .run(id, ...vals, by);
  return { id, created: true };
}

const getMeta = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
const setMeta = (db, key, value) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));

/** Officer deletions are remembered so a later seed doesn't bring the row back. */
function rememberDeleted(db, id) {
  const ids = new Set(JSON.parse(getMeta(db, 'internships_deleted') || '[]'));
  ids.add(Number(id));
  setMeta(db, 'internships_deleted', JSON.stringify([...ids]));
}

/**
 * Load the seed file. Runs on first start and again only when the file's contents change.
 * Rows an officer has edited (or deleted) since are left alone unless `force` is set.
 * Idempotent: rows are matched by id, so running it twice never duplicates anything.
 */
function seedInternships(db, { file = SEED_FILE, force = false } = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  if (!force && getMeta(db, 'internships_seed_hash') === hash) return { unchanged: true };
  const seed = JSON.parse(text).map((r, i) => normalize(r, { rowLabel: `Seed row ${i + 1}` }));
  const deleted = new Set(force ? [] : JSON.parse(getMeta(db, 'internships_deleted') || '[]'));
  const out = { created: 0, updated: 0, skipped: [] };
  tx(db, () => {
    for (const row of seed) {
      const existing = db.prepare('SELECT updated_by FROM internships WHERE id = ?').get(row.id);
      if (!force && (deleted.has(row.id) || (existing && existing.updated_by !== 'seed'))) {
        out.skipped.push({ id: row.id, company: row.company, reason: deleted.has(row.id) ? 'deleted by an officer' : `edited by ${existing.updated_by}` });
        continue;
      }
      out[upsert(db, row, 'seed').created ? 'created' : 'updated']++;
    }
    if (force) setMeta(db, 'internships_deleted', '[]');
    setMeta(db, 'internships_seed_hash', hash);
  });
  return out;
}

module.exports = {
  COLUMNS, INDUSTRIES, STALE_DAYS, SEED_FILE, computeStatus, sortInternships, linkLabel, attentionReasons,
  normalize, toCsv, fromCsv, upsert, rememberDeleted, seedInternships, ymd,
};
