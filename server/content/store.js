'use strict';
// The database is the source of truth for content. The JSON files in this folder
// fill an empty database on first run, and the admin page exports/imports the same
// shape so content can be backed up or handed to next year's officers.

const { tx } = require('../db');

const j = (v) => JSON.stringify(v ?? []);
const bool = (v) => (v ? 1 : 0);

function industryIds(db) {
  return Object.fromEntries(db.prepare('SELECT slug, id FROM industries').all().map((r) => [r.slug, r.id]));
}

function insertIndustry(db, i, by) {
  db.prepare(`INSERT INTO industries (slug, name, summary, guide_json, sort_order, active, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(i.slug, i.name, i.summary || null, j(i.guide), i.sort_order ?? 0, bool(i.active ?? true), by);
}

function insertMilestone(db, m, ids, by) {
  const industryId = ids[m.industry];
  if (!industryId) throw Object.assign(new Error(`Unknown industry "${m.industry}" in milestone "${m.title}".`), { status: 400 });
  db.prepare(`INSERT INTO milestones (industry_id, track, class_years, start_month, end_month, title, details, category, link, priority, sort_order, source, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(industryId, m.track || null, j(m.class_years), m.months[0], m.months[1], m.title, m.details || null,
      m.category || 'prepare', m.link || null, m.priority ?? 2, m.sort_order ?? 0, m.source || null, by);
}

function insertProgram(db, p, ids, by) {
  const industryId = ids[p.industry];
  if (!industryId) throw Object.assign(new Error(`Unknown industry "${p.industry}" in program "${p.name}".`), { status: 400 });
  db.prepare(`INSERT INTO programs (name, firm, industry_id, eligible_years, cycle, opens_on, deadline, rolling, link, description, needs_review, active, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(p.name, p.firm, industryId, j(p.eligible_years), p.cycle || null, p.opens_on || null, p.deadline || null,
      bool(p.rolling), p.link || null, p.description || null, bool(p.needs_review), bool(p.active ?? true), by);
}

/** Insert or update firms by name. Returns { created, updated }. */
function upsertFirms(db, firms, by = null) {
  let created = 0, updated = 0;
  tx(db, () => {
    for (const f of firms) {
      const existing = db.prepare('SELECT id FROM firms WHERE lower(name) = lower(?)').get(f.name);
      const vals = [f.sector || null, f.category || null, f.domain, f.pattern, f.confidence || null, j(f.fallbacks),
        f.notes || null, f.sources_agree || null, f.researched_on || null, by];
      if (existing) {
        db.prepare(`UPDATE firms SET sector = ?, category = ?, domain = ?, pattern = ?, confidence = ?, fallbacks_json = ?, notes = ?,
          sources_agree = ?, researched_on = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`).run(...vals, existing.id);
        updated++;
      } else {
        db.prepare(`INSERT INTO firms (sector, category, domain, pattern, confidence, fallbacks_json, notes, sources_agree, researched_on, updated_by, name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...vals, f.name);
        created++;
      }
    }
  });
  return { created, updated };
}

/** Fill any empty content table from the JSON seed files. Returns counts seeded. */
function seedIfEmpty(db, content = loadSeedFiles()) {
  const empty = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n === 0;
  const seeded = {};
  tx(db, () => {
    if (empty('industries')) { content.industries.forEach((i) => insertIndustry(db, i, 'seed')); seeded.industries = content.industries.length; }
    const ids = industryIds(db);
    if (empty('milestones')) { content.milestones.forEach((m) => insertMilestone(db, m, ids, 'seed')); seeded.milestones = content.milestones.length; }
    if (empty('programs')) { content.programs.forEach((p) => insertProgram(db, p, ids, 'seed')); seeded.programs = content.programs.length; }
  });
  if (empty('firms')) { upsertFirms(db, content.firms, 'seed'); seeded.firms = content.firms.length; }
  return seeded;
}

function loadSeedFiles() {
  return {
    industries: require('./industries.json'),
    milestones: require('./milestones.json'),
    programs: require('./programs.json'),
    firms: require('./firms.json'),
  };
}

/** Everything officers edit, in the same shape as the seed files. */
function exportContent(db) {
  const slugById = Object.fromEntries(db.prepare('SELECT id, slug FROM industries').all().map((r) => [r.id, r.slug]));
  return {
    exportedAt: new Date().toISOString(),
    industries: db.prepare('SELECT * FROM industries ORDER BY sort_order, name').all().map((i) => ({
      slug: i.slug, name: i.name, summary: i.summary, sort_order: i.sort_order, active: !!i.active, guide: JSON.parse(i.guide_json),
    })),
    milestones: db.prepare('SELECT * FROM milestones ORDER BY industry_id, sort_order, id').all().map((m) => ({
      industry: slugById[m.industry_id], track: m.track, class_years: JSON.parse(m.class_years), months: [m.start_month, m.end_month],
      title: m.title, details: m.details, category: m.category, link: m.link, priority: m.priority, sort_order: m.sort_order, source: m.source,
    })),
    programs: db.prepare('SELECT * FROM programs ORDER BY deadline IS NULL, deadline, name').all().map((p) => ({
      name: p.name, firm: p.firm, industry: slugById[p.industry_id], eligible_years: JSON.parse(p.eligible_years), cycle: p.cycle,
      opens_on: p.opens_on, deadline: p.deadline, rolling: !!p.rolling, link: p.link, description: p.description,
      needs_review: !!p.needs_review, active: !!p.active,
    })),
    firms: db.prepare('SELECT * FROM firms ORDER BY sector, name').all().map((f) => ({
      name: f.name, sector: f.sector, category: f.category, domain: f.domain, pattern: f.pattern, confidence: f.confidence,
      fallbacks: JSON.parse(f.fallbacks_json), notes: f.notes, sources_agree: f.sources_agree, researched_on: f.researched_on,
    })),
  };
}

/**
 * Replace industries, milestones and programs with an exported bundle (firms are upserted).
 * Students' progress on milestones is tied to milestone ids, so it is cleared by a replace.
 */
function importContent(db, bundle, by) {
  for (const k of ['industries', 'milestones', 'programs']) {
    if (!Array.isArray(bundle?.[k])) throw Object.assign(new Error(`Import file is missing "${k}".`), { status: 400 });
  }
  tx(db, () => {
    db.exec('DELETE FROM milestones; DELETE FROM programs; DELETE FROM industries;');
    bundle.industries.forEach((i) => insertIndustry(db, i, by));
    const ids = industryIds(db);
    bundle.milestones.forEach((m) => insertMilestone(db, m, ids, by));
    bundle.programs.forEach((p) => insertProgram(db, p, ids, by));
  });
  const firms = Array.isArray(bundle.firms) ? upsertFirms(db, bundle.firms, by) : { created: 0, updated: 0 };
  return { industries: bundle.industries.length, milestones: bundle.milestones.length, programs: bundle.programs.length, firms };
}

module.exports = { seedIfEmpty, exportContent, importContent, upsertFirms, insertMilestone, insertProgram, insertIndustry, industryIds };
