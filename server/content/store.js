'use strict';
// The database is the source of truth for content. The JSON files in this folder
// fill an empty database on first run, and the admin page exports/imports the same
// shape so content can be backed up or handed to next year's officers.

const fs = require('node:fs');
const path = require('node:path');
const { tx } = require('../db');

// Bump when the starter content changes in a way existing databases should pick up.
// v2: five tracks (IB, consulting, SWE, PM, S&T), the 2026-27 programs sheet, tech email formats.
const CONTENT_VERSION = 2;

const j = (v) => JSON.stringify(v ?? []);
const bool = (v) => (v ? 1 : 0);
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

function industryIds(db) {
  return Object.fromEntries(db.prepare('SELECT slug, id FROM industries').all().map((r) => [r.slug, r.id]));
}

function insertIndustry(db, i, by) {
  db.prepare(`INSERT INTO industries (slug, name, summary, guide_json, sort_order, active, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(i.slug, i.name, i.summary || null, j(i.guide), i.sort_order ?? 0, bool(i.active ?? true), by);
}

function insertMilestone(db, m, ids, by) {
  const industryId = ids[m.industry];
  if (!industryId) throw bad(`Unknown industry "${m.industry}" in milestone "${m.title}".`);
  db.prepare(`INSERT INTO milestones (industry_id, track, class_years, start_month, end_month, title, details, category, link, priority, sort_order, source, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(industryId, m.track || null, j(m.class_years), m.months[0], m.months[1], m.title, m.details || null,
      m.category || 'prepare', m.link || null, m.priority ?? 2, m.sort_order ?? 0, m.source || null, by);
}

const PROGRAM_COLS = ['name', 'firm', 'kind', 'industries', 'eligible_years', 'eligibility', 'affinity', 'format', 'timing', 'status', 'cycle',
  'opens_on', 'deadline', 'expected_month', 'rolling', 'link', 'description', 'needs_review', 'active'];

function programValues(p, ids) {
  const unknown = (p.industries || []).filter((s) => !ids[s]);
  if (!p.industries?.length) throw bad(`Program "${p.name}" needs at least one industry.`);
  if (unknown.length) throw bad(`Unknown industry "${unknown.join(', ')}" in program "${p.name}".`);
  return [p.name, p.firm, p.kind || 'firm', j(p.industries), j(p.eligible_years), p.eligibility || null, p.affinity || null, p.format || null,
    p.timing || null, p.status || 'upcoming', p.cycle || null, p.opens_on || null, p.deadline || null, p.expected_month || null,
    bool(p.rolling), p.link || null, p.description || null, bool(p.needs_review), bool(p.active ?? true)];
}

function insertProgram(db, p, ids, by) {
  return Number(db.prepare(`INSERT INTO programs (${PROGRAM_COLS.join(', ')}, updated_by) VALUES (${PROGRAM_COLS.map(() => '?').join(', ')}, ?)`)
    .run(...programValues(p, ids), by).lastInsertRowid);
}

function updateProgram(db, id, p, ids, by) {
  return db.prepare(`UPDATE programs SET ${PROGRAM_COLS.map((c) => `${c} = ?`).join(', ')}, updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(...programValues(p, ids), by, id).changes;
}

/** Insert or update programs matched by firm + name (spreadsheet re-uploads). Pins and calendar links survive. */
function upsertPrograms(db, programs, by = null) {
  const ids = industryIds(db);
  let created = 0, updated = 0;
  tx(db, () => {
    for (const p of programs) {
      const existing = db.prepare('SELECT id FROM programs WHERE lower(firm) = lower(?) AND lower(name) = lower(?)').get(p.firm, p.name);
      if (existing) { updateProgram(db, existing.id, p, ids, by); updated++; } else { insertProgram(db, p, ids, by); created++; }
    }
  });
  return { created, updated };
}

/** Insert or update firms by name. With { onlyNew: true } existing firms are left alone. */
function upsertFirms(db, firms, by = null, { onlyNew = false } = {}) {
  let created = 0, updated = 0;
  tx(db, () => {
    for (const f of firms) {
      const existing = db.prepare('SELECT id FROM firms WHERE lower(name) = lower(?)').get(f.name);
      if (existing && onlyNew) continue;
      const vals = [f.sector || null, f.category || null, f.domain, f.pattern, f.max_local || null, j(f.fallbacks),
        f.confidence || null, f.notes || null, f.sources_agree || null, f.researched_on || null, by];
      if (existing) {
        db.prepare(`UPDATE firms SET sector = ?, category = ?, domain = ?, pattern = ?, max_local = ?, fallbacks_json = ?, confidence = ?, notes = ?,
          sources_agree = ?, researched_on = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`).run(...vals, existing.id);
        updated++;
      } else {
        db.prepare(`INSERT INTO firms (sector, category, domain, pattern, max_local, fallbacks_json, confidence, notes, sources_agree, researched_on, updated_by, name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...vals, f.name);
        created++;
      }
    }
  });
  return { created, updated };
}

function loadSeedFiles() {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
  return { industries: read('industries.json'), milestones: read('milestones.json'), programs: read('programs.json'), firms: read('firms.json') };
}

const getMeta = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
const setMeta = (db, key, value) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));

function replaceCoreContent(db, content, by) {
  tx(db, () => {
    db.exec('UPDATE events SET program_id = NULL, milestone_id = NULL; DELETE FROM milestones; DELETE FROM programs; DELETE FROM industries;');
    content.industries.forEach((i) => insertIndustry(db, i, by));
    const ids = industryIds(db);
    content.milestones.forEach((m) => insertMilestone(db, m, ids, by));
    content.programs.forEach((p) => insertProgram(db, p, ids, by));
  });
}

/**
 * Fill an empty database from the seed files, or bring an older database's starter content
 * up to CONTENT_VERSION. Before an upgrade replaces timelines and programs, everything is
 * exported to a backup file next to the database. Returns a summary of what happened.
 */
function syncContent(db, { content = loadSeedFiles(), backupDir = null } = {}) {
  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  const version = Number(getMeta(db, 'content_version') || 0);
  if (count('industries') === 0) {
    replaceCoreContent(db, content, 'seed');
    if (count('firms') === 0) upsertFirms(db, content.firms, 'seed');
    setMeta(db, 'content_version', CONTENT_VERSION);
    return { seeded: { industries: content.industries.length, milestones: content.milestones.length, programs: content.programs.length, firms: content.firms.length } };
  }
  if (version >= CONTENT_VERSION) return {};

  let backup = null;
  if (backupDir) {
    backup = path.join(backupDir, `backup-content-v${version || 1}-${Date.now()}.json`);
    fs.writeFileSync(backup, JSON.stringify(exportContent(db), null, 2));
  }
  replaceCoreContent(db, content, 'seed');
  const firms = upsertFirms(db, content.firms, 'seed', { onlyNew: true });
  // Students who followed the old combined "tech" track now follow its replacements.
  for (const u of db.prepare(`SELECT id, industry_slugs FROM users WHERE industry_slugs LIKE '%"tech"%'`).all()) {
    const slugs = JSON.parse(u.industry_slugs).flatMap((s) => (s === 'tech' ? ['swe', 'pm', 'sales-trading'] : [s]));
    db.prepare('UPDATE users SET industry_slugs = ? WHERE id = ?').run(JSON.stringify([...new Set(slugs)]), u.id);
  }
  setMeta(db, 'content_version', CONTENT_VERSION);
  return { upgraded: { from: version || 1, to: CONTENT_VERSION, backup, newFirms: firms.created } };
}

/** Everything officers edit, in the same shape as the seed files. */
function exportContent(db) {
  const slugById = Object.fromEntries(db.prepare('SELECT id, slug FROM industries').all().map((r) => [r.id, r.slug]));
  const progCols = new Set(db.prepare('PRAGMA table_info(programs)').all().map((c) => c.name));
  return {
    exportedAt: new Date().toISOString(),
    industries: db.prepare('SELECT * FROM industries ORDER BY sort_order, name').all().map((i) => ({
      slug: i.slug, name: i.name, summary: i.summary, sort_order: i.sort_order, active: !!i.active, guide: JSON.parse(i.guide_json),
    })),
    milestones: db.prepare('SELECT * FROM milestones ORDER BY industry_id, sort_order, id').all().map((m) => ({
      industry: slugById[m.industry_id], track: m.track, class_years: JSON.parse(m.class_years), months: [m.start_month, m.end_month],
      title: m.title, details: m.details, category: m.category, link: m.link, priority: m.priority, sort_order: m.sort_order, source: m.source,
    })),
    programs: db.prepare('SELECT * FROM programs ORDER BY firm, name').all().map((p) => (progCols.has('industries') ? {
      name: p.name, firm: p.firm, kind: p.kind, industries: JSON.parse(p.industries), eligible_years: JSON.parse(p.eligible_years),
      eligibility: p.eligibility, affinity: p.affinity, format: p.format, timing: p.timing, status: p.status, cycle: p.cycle,
      opens_on: p.opens_on, deadline: p.deadline, expected_month: p.expected_month, rolling: !!p.rolling, link: p.link,
      description: p.description, needs_review: !!p.needs_review, active: !!p.active,
    } : { ...p, industries: [slugById[p.industry_id]].filter(Boolean) })),
    firms: db.prepare('SELECT * FROM firms ORDER BY sector, name').all().map((f) => ({
      name: f.name, sector: f.sector, category: f.category, domain: f.domain, pattern: f.pattern, max_local: f.max_local, confidence: f.confidence,
      fallbacks: JSON.parse(f.fallbacks_json), notes: f.notes, sources_agree: f.sources_agree, researched_on: f.researched_on,
    })),
  };
}

/**
 * Replace industries, milestones and programs with an exported bundle (firms are upserted).
 * Students' progress and pins are tied to ids, so they are cleared by a replace.
 */
function importContent(db, bundle, by) {
  for (const k of ['industries', 'milestones', 'programs']) {
    if (!Array.isArray(bundle?.[k])) throw bad(`Import file is missing "${k}".`);
  }
  // Older exports had a single "industry" per program.
  const programs = bundle.programs.map((p) => (p.industries ? p : { ...p, industries: [p.industry].filter(Boolean) }));
  replaceCoreContent(db, { ...bundle, programs }, by);
  const firms = Array.isArray(bundle.firms) ? upsertFirms(db, bundle.firms, by) : { created: 0, updated: 0 };
  return { industries: bundle.industries.length, milestones: bundle.milestones.length, programs: programs.length, firms };
}

module.exports = {
  CONTENT_VERSION, syncContent, exportContent, importContent, upsertFirms, upsertPrograms,
  insertMilestone, insertProgram, updateProgram, insertIndustry, industryIds, loadSeedFiles,
};
