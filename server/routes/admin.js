'use strict';
const express = require('express');
const multer = require('multer');
const { tx } = require('../db');
const store = require('../content/store');
const validate = require('../content/validate');
const { readFormatsFile } = require('../content/formats-import');
const { readProgramsFile } = require('../content/programs-import');

// Officers only (mounted behind requireUser + requireAdmin).
module.exports = function adminRoutes(db) {
  const r = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
  const by = (req) => req.user.email;
  const j = JSON.stringify;
  const industryId = (slug) => {
    const row = db.prepare('SELECT id FROM industries WHERE slug = ?').get(slug);
    if (!row) throw Object.assign(new Error(`Unknown industry "${slug}".`), { status: 400 });
    return row.id;
  };
  const notFound = (res, what) => res.status(404).json({ error: `${what} not found.` });

  // ----- whole-content backup / handover -----
  r.get('/content', (req, res) => {
    res.attachment(`bbsa-content-${new Date().toISOString().slice(0, 10)}.json`).json(store.exportContent(db));
  });
  r.post('/content', express.json({ limit: '5mb' }), (req, res) => res.json(store.importContent(db, req.body, by(req))));

  // ----- industries -----
  r.get('/industries', (req, res) => {
    res.json(db.prepare('SELECT * FROM industries ORDER BY sort_order, name').all().map((i) => ({
      id: i.id, slug: i.slug, name: i.name, summary: i.summary, guide: JSON.stringify(JSON.parse(i.guide_json), null, 2),
      sort_order: i.sort_order, active: !!i.active, updated_by: i.updated_by, updated_at: i.updated_at,
    })));
  });
  r.post('/industries', (req, res) => {
    const i = validate.industry(req.body);
    if (db.prepare('SELECT 1 FROM industries WHERE slug = ?').get(i.slug)) return res.status(409).json({ error: 'That slug is already used.' });
    store.insertIndustry(db, i, by(req));
    res.status(201).json({ ok: true });
  });
  r.put('/industries/:id', (req, res) => {
    const i = validate.industry(req.body);
    const clash = db.prepare('SELECT id FROM industries WHERE slug = ? AND id != ?').get(i.slug, req.params.id);
    if (clash) return res.status(409).json({ error: 'That slug is already used.' });
    const old = db.prepare('SELECT slug FROM industries WHERE id = ?').get(req.params.id);
    if (!old) return notFound(res, 'Industry');
    tx(db, () => {
      db.prepare(`UPDATE industries SET slug = ?, name = ?, summary = ?, guide_json = ?, sort_order = ?, active = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(i.slug, i.name, i.summary, j(i.guide), i.sort_order, i.active ? 1 : 0, by(req), req.params.id);
      if (old.slug !== i.slug) {
        // Programs and students' choices refer to industries by slug.
        for (const p of db.prepare('SELECT id, industries FROM programs').all()) {
          const list = JSON.parse(p.industries);
          if (list.includes(old.slug)) db.prepare('UPDATE programs SET industries = ? WHERE id = ?').run(j(list.map((s) => (s === old.slug ? i.slug : s))), p.id);
        }
        for (const u of db.prepare('SELECT id, industry_slugs FROM users').all()) {
          const list = JSON.parse(u.industry_slugs);
          if (list.includes(old.slug)) db.prepare('UPDATE users SET industry_slugs = ? WHERE id = ?').run(j(list.map((s) => (s === old.slug ? i.slug : s))), u.id);
        }
      }
    });
    return res.json({ ok: true });
  });
  r.delete('/industries/:id', (req, res) => {
    const ind = db.prepare('SELECT slug FROM industries WHERE id = ?').get(req.params.id);
    const n = ind ? db.prepare(`SELECT (SELECT COUNT(*) FROM milestones WHERE industry_id = ?)
      + (SELECT COUNT(*) FROM programs, json_each(programs.industries) WHERE json_each.value = ?) AS n`).get(req.params.id, ind.slug).n : 0;
    if (n) return res.status(409).json({ error: `This industry still has ${n} milestones/programs. Delete or move them first, or mark the industry inactive.` });
    const info = db.prepare('DELETE FROM industries WHERE id = ?').run(req.params.id);
    return info.changes ? res.json({ ok: true }) : notFound(res, 'Industry');
  });

  // ----- milestones -----
  r.get('/milestones', (req, res) => {
    const slug = Object.fromEntries(db.prepare('SELECT id, slug FROM industries').all().map((x) => [x.id, x.slug]));
    res.json(db.prepare('SELECT * FROM milestones ORDER BY industry_id, sort_order, id').all().map((m) => ({
      id: m.id, industry: slug[m.industry_id], track: m.track, class_years: JSON.parse(m.class_years), start_month: m.start_month, end_month: m.end_month,
      title: m.title, details: m.details, category: m.category, link: m.link, priority: m.priority, sort_order: m.sort_order, source: m.source,
      updated_by: m.updated_by, updated_at: m.updated_at,
    })));
  });
  r.post('/milestones', (req, res) => {
    const m = validate.milestone(req.body);
    store.insertMilestone(db, m, store.industryIds(db), by(req));
    res.status(201).json({ ok: true });
  });
  r.put('/milestones/:id', (req, res) => {
    const m = validate.milestone(req.body);
    const info = db.prepare(`UPDATE milestones SET industry_id = ?, track = ?, class_years = ?, start_month = ?, end_month = ?, title = ?, details = ?,
      category = ?, link = ?, priority = ?, sort_order = ?, source = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(industryId(m.industry), m.track, j(m.class_years), m.months[0], m.months[1], m.title, m.details, m.category, m.link, m.priority,
        m.sort_order, m.source, by(req), req.params.id);
    return info.changes ? res.json({ ok: true }) : notFound(res, 'Milestone');
  });
  r.delete('/milestones/:id', (req, res) => {
    const info = db.prepare('DELETE FROM milestones WHERE id = ?').run(req.params.id);
    return info.changes ? res.json({ ok: true }) : notFound(res, 'Milestone');
  });

  // ----- programs -----
  r.get('/programs', (req, res) => {
    res.json(db.prepare('SELECT * FROM programs ORDER BY firm, name').all().map((p) => ({
      id: p.id, name: p.name, firm: p.firm, kind: p.kind, industries: JSON.parse(p.industries), eligible_years: JSON.parse(p.eligible_years),
      eligibility: p.eligibility, affinity: p.affinity, format: p.format, timing: p.timing, status: p.status, cycle: p.cycle,
      opens_on: p.opens_on, deadline: p.deadline, expected_month: p.expected_month, rolling: !!p.rolling, link: p.link,
      description: p.description, needs_review: !!p.needs_review, active: !!p.active, updated_by: p.updated_by, updated_at: p.updated_at,
    })));
  });
  r.post('/programs', (req, res) => {
    const p = validate.program(req.body);
    if (db.prepare('SELECT 1 FROM programs WHERE lower(firm) = lower(?) AND lower(name) = lower(?)').get(p.firm, p.name)) {
      return res.status(409).json({ error: 'That firm already has a program with this name.' });
    }
    store.insertProgram(db, p, store.industryIds(db), by(req));
    res.status(201).json({ ok: true });
  });
  r.put('/programs/:id', (req, res) => {
    const p = validate.program(req.body);
    const clash = db.prepare('SELECT id FROM programs WHERE lower(firm) = lower(?) AND lower(name) = lower(?) AND id != ?').get(p.firm, p.name, req.params.id);
    if (clash) return res.status(409).json({ error: 'That firm already has a program with this name.' });
    const changes = store.updateProgram(db, req.params.id, p, store.industryIds(db), by(req));
    return changes ? res.json({ ok: true }) : notFound(res, 'Program');
  });
  r.delete('/programs/:id', (req, res) => {
    const info = tx(db, () => {
      db.prepare('UPDATE events SET program_id = NULL WHERE program_id = ?').run(req.params.id);
      return db.prepare('DELETE FROM programs WHERE id = ?').run(req.params.id);
    });
    return info.changes ? res.json({ ok: true }) : notFound(res, 'Program');
  });
  // Upload the programs spreadsheet (.xlsx or .csv). Programs are matched by firm + name, so
  // re-uploading an updated sheet refreshes them without losing students' pins or reminders.
  r.post('/programs/import', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Choose an .xlsx or .csv file.' });
      const { programs, errors } = await readProgramsFile(req.file.buffer, req.file.originalname, { cycle: req.body?.cycle || null });
      const counts = programs.length ? store.upsertPrograms(db, programs, by(req)) : { created: 0, updated: 0 };
      res.json({ ...counts, errors });
    } catch (err) {
      next(Object.assign(err, { status: err.status || 400, message: err.status ? err.message : `Couldn't read that file: ${err.message}` }));
    }
  });

  // ----- email formats -----
  r.get('/firms', (req, res) => {
    res.json(db.prepare('SELECT * FROM firms ORDER BY name').all().map((f) => ({
      id: f.id, name: f.name, sector: f.sector, category: f.category, format: `${f.pattern}@${f.domain}`, max_local: f.max_local, confidence: f.confidence,
      fallbacks: JSON.parse(f.fallbacks_json).map((x) => `${x.pattern}@${x.domain}`).join(', '), notes: f.notes,
      sources_agree: f.sources_agree, researched_on: f.researched_on, updated_by: f.updated_by, updated_at: f.updated_at,
    })));
  });
  r.post('/firms', (req, res) => {
    const f = validate.firm(req.body);
    if (db.prepare('SELECT 1 FROM firms WHERE lower(name) = lower(?)').get(f.name)) return res.status(409).json({ error: 'A firm with that name already exists.' });
    store.upsertFirms(db, [f], by(req));
    res.status(201).json({ ok: true });
  });
  r.put('/firms/:id', (req, res) => {
    const f = validate.firm(req.body);
    const clash = db.prepare('SELECT id FROM firms WHERE lower(name) = lower(?) AND id != ?').get(f.name, req.params.id);
    if (clash) return res.status(409).json({ error: 'A firm with that name already exists.' });
    const info = tx(db, () => db.prepare(`UPDATE firms SET name = ?, sector = ?, category = ?, domain = ?, pattern = ?, max_local = ?, confidence = ?, fallbacks_json = ?,
      notes = ?, sources_agree = ?, researched_on = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(f.name, f.sector, f.category, f.domain, f.pattern, f.max_local, f.confidence, j(f.fallbacks), f.notes, f.sources_agree, f.researched_on, by(req), req.params.id));
    return info.changes ? res.json({ ok: true }) : notFound(res, 'Firm');
  });
  r.delete('/firms/:id', (req, res) => {
    const info = db.prepare('DELETE FROM firms WHERE id = ?').run(req.params.id);
    return info.changes ? res.json({ ok: true }) : notFound(res, 'Firm');
  });
  // Upload an officer spreadsheet (.xlsx or .csv). Firms are matched by name: existing ones are updated.
  r.post('/firms/import', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Choose an .xlsx or .csv file.' });
      const { firms, errors } = await readFormatsFile(req.file.buffer, req.file.originalname, { sector: req.body?.sector || undefined });
      const counts = firms.length ? store.upsertFirms(db, firms, by(req)) : { created: 0, updated: 0 };
      res.json({ ...counts, errors });
    } catch (err) {
      next(Object.assign(err, { status: err.status || 400, message: err.status ? err.message : `Couldn't read that file: ${err.message}` }));
    }
  });

  return r;
};
