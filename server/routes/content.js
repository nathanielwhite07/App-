'use strict';
const express = require('express');
const { YEAR_NAMES, academicYearStart, classYear, inWindow, academicIndex, windowLabel } = require('../academic');
const { buildAddress, PATTERNS } = require('../email/patterns');

const DAY = 864e5;
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

/** "asOf" lets the UI preview another date and lets tests pin the clock. */
function asOfDate(q) {
  if (q && /^\d{4}-\d{2}-\d{2}$/.test(q)) return parseYmd(q);
  return new Date();
}

function views(db) {
  const industries = () => db.prepare('SELECT * FROM industries WHERE active = 1 ORDER BY sort_order, name').all();
  const industryView = (i) => ({ id: i.id, slug: i.slug, name: i.name, summary: i.summary, guide: JSON.parse(i.guide_json) });

  const milestoneView = (m, slugById) => ({
    id: m.id, industry: slugById[m.industry_id], track: m.track, classYears: JSON.parse(m.class_years),
    startMonth: m.start_month, endMonth: m.end_month, when: windowLabel(m.start_month, m.end_month),
    title: m.title, details: m.details, category: m.category, link: m.link, priority: m.priority, source: m.source,
  });

  function programView(p, slugById, today) {
    const t = isoDate(today);
    let status;
    if (p.opens_on && p.opens_on > t) status = 'upcoming';
    else if (p.deadline && p.deadline < t) status = 'closed';
    else if (p.deadline) status = 'open';
    else status = p.rolling ? 'rolling' : 'tba';
    const daysLeft = p.deadline && p.deadline >= t ? Math.round((parseYmd(p.deadline) - parseYmd(t)) / DAY) : null;
    return {
      id: p.id, name: p.name, firm: p.firm, industry: slugById[p.industry_id], eligibleYears: JSON.parse(p.eligible_years),
      cycle: p.cycle, opensOn: p.opens_on, deadline: p.deadline, rolling: !!p.rolling, link: p.link, description: p.description,
      needsReview: !!p.needs_review, status, daysLeft, updatedAt: p.updated_at,
    };
  }

  const slugMap = () => Object.fromEntries(db.prepare('SELECT id, slug FROM industries').all().map((r) => [r.id, r.slug]));
  return { industries, industryView, milestoneView, programView, slugMap };
}

const eligible = (years, cy) => !years.length || years.includes(cy);

module.exports = function contentRoutes(db) {
  const r = express.Router();
  const v = views(db);

  r.get('/industries', (req, res) => res.json(v.industries().map(v.industryView)));

  // Timelines: every milestone for an industry, optionally for one class year, in academic-year order.
  r.get('/timelines', (req, res) => {
    const slugById = v.slugMap();
    const ind = req.query.industry && db.prepare('SELECT id FROM industries WHERE slug = ?').get(String(req.query.industry));
    if (req.query.industry && !ind) return res.status(404).json({ error: 'Unknown industry.' });
    const year = req.query.year ? Number(req.query.year) : null;
    const rows = db.prepare(`SELECT m.* FROM milestones m JOIN industries i ON i.id = m.industry_id
      WHERE i.active = 1 ${ind ? 'AND m.industry_id = ?' : ''} ORDER BY m.sort_order, m.id`).all(...(ind ? [ind.id] : []));
    const out = rows.map((m) => v.milestoneView(m, slugById))
      .filter((m) => !year || eligible(m.classYears, year))
      .sort((a, b) => (a.classYears[0] || 0) - (b.classYears[0] || 0) || academicIndex(a.startMonth) - academicIndex(b.startMonth) || a.priority - b.priority);
    res.json(out);
  });

  r.get('/programs', (req, res) => {
    const today = asOfDate(req.query.asOf);
    const slugById = v.slugMap();
    const year = req.query.year ? Number(req.query.year) : null;
    const q = String(req.query.q || '').trim().toLowerCase();
    const statuses = req.query.status ? String(req.query.status).split(',') : null;
    const rows = db.prepare(`SELECT p.* FROM programs p JOIN industries i ON i.id = p.industry_id
      WHERE p.active = 1 AND i.active = 1 ORDER BY p.deadline IS NULL, p.deadline, p.name`).all();
    const out = rows.map((p) => v.programView(p, slugById, today))
      .filter((p) => !req.query.industry || String(req.query.industry).split(',').includes(p.industry))
      .filter((p) => !year || eligible(p.eligibleYears, year))
      .filter((p) => !statuses || statuses.includes(p.status))
      .filter((p) => !q || `${p.name} ${p.firm} ${p.description || ''}`.toLowerCase().includes(q));
    res.json(out);
  });

  // "What should I do this month": the student's class year x chosen industries x today's date.
  r.get('/this-month', (req, res) => {
    const today = asOfDate(req.query.asOf);
    const cy = req.query.year ? Number(req.query.year) : classYear(req.user.grad_year, today);
    const chosen = JSON.parse(req.user.industry_slugs || '[]');
    const active = v.industries();
    const slugs = (chosen.length ? chosen : active.map((i) => i.slug)).filter((s) => active.some((i) => i.slug === s));
    const base = {
      date: isoDate(today), month: today.getMonth() + 1, classYear: cy, classYearName: YEAR_NAMES[cy] || null,
      industries: active.filter((i) => slugs.includes(i.slug)).map((i) => ({ slug: i.slug, name: i.name })),
      usingAllIndustries: !chosen.length,
    };
    if (cy == null || cy < 1 || cy > 4) {
      return res.json({ ...base, needsProfile: cy == null, outOfRange: cy != null, now: [], next: [], deadlines: [], toWatch: [], events: [] });
    }
    const slugById = v.slugMap();
    const month = today.getMonth() + 1, nextMonth = (month % 12) + 1;
    const ay = academicYearStart(today);
    const done = new Set(db.prepare('SELECT milestone_id FROM milestone_progress WHERE user_id = ? AND academic_year = ?')
      .all(req.user.id, ay).map((r) => r.milestone_id));
    const milestones = db.prepare('SELECT * FROM milestones').all().map((m) => v.milestoneView(m, slugById))
      .filter((m) => slugs.includes(m.industry) && eligible(m.classYears, cy));
    const now = milestones.filter((m) => inWindow(month, m.startMonth, m.endMonth))
      .map((m) => ({ ...m, done: done.has(m.id), startsThisMonth: m.startMonth === month }))
      .sort((a, b) => a.done - b.done || a.priority - b.priority || b.startsThisMonth - a.startsThisMonth);
    const next = milestones.filter((m) => m.startMonth === nextMonth && !inWindow(month, m.startMonth, m.endMonth));

    const programs = db.prepare('SELECT * FROM programs WHERE active = 1').all().map((p) => v.programView(p, slugById, today))
      .filter((p) => slugs.includes(p.industry) && eligible(p.eligibleYears, cy));
    const horizon = isoDate(new Date(today.getTime() + 45 * DAY));
    const deadlines = programs.filter((p) => (p.status === 'open' && p.deadline <= horizon) || (p.status === 'upcoming' && p.opensOn <= horizon))
      .sort((a, b) => (a.deadline || a.opensOn).localeCompare(b.deadline || b.opensOn));
    const toWatch = programs.filter((p) => p.status === 'tba' || p.status === 'rolling' || (p.status === 'open' && p.deadline > horizon));

    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString();
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 1).toISOString();
    const events = db.prepare('SELECT id, kind, title, starts_at, duration_min, location FROM events WHERE user_id = ? AND starts_at >= ? AND starts_at < ? ORDER BY starts_at')
      .all(req.user.id, monthStart, monthEnd).map((e) => ({ id: e.id, kind: e.kind, title: e.title, startsAt: e.starts_at, durationMin: e.duration_min, location: e.location }));

    res.json({ ...base, academicYear: `${ay}-${String(ay + 1).slice(2)}`, now, next, deadlines, toWatch, events });
  });

  r.put('/milestones/:id/progress', (req, res) => {
    const m = db.prepare('SELECT id FROM milestones WHERE id = ?').get(req.params.id);
    if (!m) return res.status(404).json({ error: 'Milestone not found.' });
    const ay = academicYearStart(asOfDate(req.query.asOf));
    if (req.body?.done === false) {
      db.prepare('DELETE FROM milestone_progress WHERE user_id = ? AND milestone_id = ? AND academic_year = ?').run(req.user.id, m.id, ay);
    } else {
      db.prepare('INSERT OR IGNORE INTO milestone_progress (user_id, milestone_id, academic_year) VALUES (?, ?, ?)').run(req.user.id, m.id, ay);
    }
    res.json({ ok: true, done: req.body?.done !== false });
  });

  // Email formats for large firms.
  const firmView = (f) => ({
    id: f.id, name: f.name, sector: f.sector, category: f.category, domain: f.domain, pattern: f.pattern,
    format: `${f.pattern}@${f.domain}`, example: buildAddress('Jane', 'Doe', f), confidence: f.confidence,
    fallbacks: JSON.parse(f.fallbacks_json).map((fb) => ({ ...fb, format: `${fb.pattern}@${fb.domain}`, example: buildAddress('Jane', 'Doe', fb) })),
    notes: f.notes, sourcesAgree: f.sources_agree, researchedOn: f.researched_on, updatedAt: f.updated_at,
  });

  r.get('/formats', (req, res) => {
    const where = [], args = [];
    if (req.query.q) { where.push('(name LIKE ? OR domain LIKE ? OR category LIKE ?)'); args.push(...Array(3).fill(`%${req.query.q}%`)); }
    if (req.query.sector) { where.push('sector = ?'); args.push(String(req.query.sector)); }
    const rows = db.prepare(`SELECT * FROM firms ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name`).all(...args);
    res.json({ sectors: db.prepare('SELECT DISTINCT sector FROM firms WHERE sector IS NOT NULL ORDER BY sector').all().map((r) => r.sector), results: rows.map(firmView) });
  });

  r.get('/formats/:id/address', (req, res) => {
    const f = db.prepare('SELECT * FROM firms WHERE id = ?').get(req.params.id);
    if (!f) return res.status(404).json({ error: 'Firm not found.' });
    const { first, last } = req.query;
    if (!first || !last) return res.status(400).json({ error: 'Enter a first and last name.' });
    // Roland Berger spells umlauts out (ö -> oe); offer both spellings when a name has them.
    const variants = (fmt) => [...new Set([buildAddress(first, last, fmt), buildAddress(first, last, fmt, { transliterate: true })])].filter(Boolean);
    const fallbacks = JSON.parse(f.fallbacks_json).filter((fb) => PATTERNS[fb.pattern]);
    res.json({ firm: f.name, primary: variants(f), fallbacks: fallbacks.flatMap(variants), confidence: f.confidence, notes: f.notes });
  });

  return r;
};

module.exports.views = views;
module.exports.isoDate = isoDate;
