'use strict';
const express = require('express');
const { YEAR_NAMES, academicYearStart, classYear, inWindow, academicIndex, windowLabel } = require('../academic');
const { buildAddress, PATTERNS } = require('../email/patterns');
const { createEvent } = require('./events');

const DAY = 864e5;
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtShort = (ymd) => parseYmd(ymd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

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

  /**
   * Status shown to students. Officers set a base status; dates override it as time passes:
   * a past deadline closes a program, a future opening date makes it upcoming, and an
   * upcoming/watch program whose expected month has arrived becomes "check now".
   */
  function programView(p, today, pinned = new Set()) {
    const t = isoDate(today), thisMonth = t.slice(0, 7);
    let status = p.status;
    if (status !== 'not_running') {
      if (p.deadline && p.deadline < t) status = 'closed';
      else if (p.opens_on && p.opens_on > t) status = 'upcoming';
      else if (p.opens_on && p.opens_on <= t && ['upcoming', 'watch'].includes(status)) status = 'open';
      else if (p.expected_month && p.expected_month <= thisMonth && ['upcoming', 'watch'].includes(status)) status = 'check_now';
    }
    const daysLeft = p.deadline && p.deadline >= t ? Math.round((parseYmd(p.deadline) - parseYmd(t)) / DAY) : null;
    return {
      id: p.id, name: p.name, firm: p.firm, kind: p.kind, industries: JSON.parse(p.industries), eligibleYears: JSON.parse(p.eligible_years),
      eligibility: p.eligibility, affinity: p.affinity, format: p.format, timing: p.timing, cycle: p.cycle,
      opensOn: p.opens_on, deadline: p.deadline, expectedMonth: p.expected_month, rolling: !!p.rolling, link: p.link,
      description: p.description, needsReview: !!p.needs_review, status, daysLeft,
      closingSoon: daysLeft != null && daysLeft <= 14 && ['open', 'check_now'].includes(status),
      pinned: pinned.has(p.id), updatedAt: p.updated_at,
    };
  }
  const pinnedIds = (userId) => new Set(db.prepare('SELECT program_id FROM program_pins WHERE user_id = ?').all(userId).map((r) => r.program_id));
  const activePrograms = () => {
    const activeSlugs = new Set(db.prepare('SELECT slug FROM industries WHERE active = 1').all().map((r) => r.slug));
    return db.prepare('SELECT * FROM programs WHERE active = 1 ORDER BY deadline IS NULL, deadline, firm, name').all()
      .filter((p) => JSON.parse(p.industries).some((s) => activeSlugs.has(s)));
  };

  const slugMap = () => Object.fromEntries(db.prepare('SELECT id, slug FROM industries').all().map((r) => [r.id, r.slug]));
  return { industries, industryView, milestoneView, programView, slugMap, pinnedIds, activePrograms };
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

  // Status order for the default sort: things students can act on first.
  const STATUS_ORDER = { open: 0, check_now: 1, upcoming: 2, watch: 3, unconfirmed: 4, closed: 5, not_running: 6 };

  r.get('/programs', (req, res) => {
    const today = asOfDate(req.query.asOf);
    const year = req.query.year ? Number(req.query.year) : null;
    const q = String(req.query.q || '').trim().toLowerCase();
    const statuses = req.query.status ? String(req.query.status).split(',') : null;
    const industries = req.query.industry ? String(req.query.industry).split(',') : null;
    const pins = v.pinnedIds(req.user.id);
    const out = v.activePrograms().map((p) => v.programView(p, today, pins))
      .filter((p) => !industries || p.industries.some((s) => industries.includes(s)))
      .filter((p) => !year || eligible(p.eligibleYears, year))
      .filter((p) => !statuses || statuses.includes(p.status))
      .filter((p) => !req.query.kind || p.kind === req.query.kind)
      .filter((p) => req.query.pinned !== '1' || p.pinned)
      .filter((p) => !q || `${p.name} ${p.firm} ${p.affinity || ''} ${p.description || ''}`.toLowerCase().includes(q))
      .sort((a, b) => b.pinned - a.pinned || STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
        || (a.deadline || a.expectedMonth || '9999').localeCompare(b.deadline || b.expectedMonth || '9999') || a.firm.localeCompare(b.firm));
    res.json(out);
  });

  r.put('/programs/:id/pin', (req, res) => {
    const p = db.prepare('SELECT id FROM programs WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Program not found.' });
    if (req.body?.pinned === false) db.prepare('DELETE FROM program_pins WHERE user_id = ? AND program_id = ?').run(req.user.id, p.id);
    else db.prepare('INSERT OR IGNORE INTO program_pins (user_id, program_id) VALUES (?, ?)').run(req.user.id, p.id);
    res.json({ ok: true, pinned: req.body?.pinned !== false });
  });

  // Add a program's dates to the student's calendar: when applications open, a nudge to start
  // applying, and the deadline itself. The client sends local times so reminders land at 9am local.
  const REMINDER_TITLES = {
    opens: (p) => `Applications open: ${p.name} (${p.firm})`,
    check: (p) => `Check if applications are open: ${p.name} (${p.firm})`,
    apply: (p) => `Start your application: ${p.name} (${p.firm})${p.deadline ? `, due ${fmtShort(p.deadline)}` : ''}`,
    deadline: (p) => `Deadline: ${p.name} (${p.firm})`,
  };
  r.post('/programs/:id/reminders', (req, res) => {
    const p = db.prepare('SELECT * FROM programs WHERE id = ?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Program not found.' });
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length || items.length > 6) return res.status(400).json({ error: 'Choose at least one reminder.' });
    for (const it of items) {
      if (!REMINDER_TITLES[it.type]) return res.status(400).json({ error: `Unknown reminder type "${it.type}".` });
      if (!it.startsAt || Number.isNaN(Date.parse(it.startsAt))) return res.status(400).json({ error: 'Each reminder needs a valid date.' });
    }
    const description = [p.timing && `Timing: ${p.timing}`, p.eligibility && `Eligibility: ${p.eligibility}`, p.description, p.link].filter(Boolean).join('\n\n');
    const events = items.map((it) => createEvent(db, req.user.id, {
      programId: p.id, kind: it.type === 'deadline' ? 'deadline' : 'reminder', title: REMINDER_TITLES[it.type](p),
      description, startsAt: it.startsAt, durationMin: 30,
    }));
    // Pinning goes with setting reminders: it keeps the program at the top of the list.
    db.prepare('INSERT OR IGNORE INTO program_pins (user_id, program_id) VALUES (?, ?)').run(req.user.id, p.id);
    res.status(201).json({ events });
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
      return res.json({ ...base, needsProfile: cy == null, outOfRange: cy != null, now: [], next: [], deadlines: [], toWatch: [], pinned: [], events: [] });
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

    const pins = v.pinnedIds(req.user.id);
    const programs = v.activePrograms().map((p) => v.programView(p, today, pins));
    const relevant = programs.filter((p) => p.industries.some((s) => slugs.includes(s)) && eligible(p.eligibleYears, cy));
    const horizon = isoDate(new Date(today.getTime() + 45 * DAY));
    const thisMonth = isoDate(today).slice(0, 7);
    const actionable = (p) => ['open', 'check_now', 'upcoming'].includes(p.status);
    const deadlines = relevant.filter((p) => actionable(p) && ((p.deadline && p.deadline <= horizon) || (p.opensOn && p.opensOn > isoDate(today) && p.opensOn <= horizon)))
      .sort((a, b) => (a.deadline || a.opensOn).localeCompare(b.deadline || b.opensOn));
    const shown = new Set(deadlines.map((p) => p.id));
    const toWatch = relevant.filter((p) => !shown.has(p.id) && (p.status === 'check_now' || (p.status === 'open' && !p.deadline)
      || (p.expectedMonth && p.expectedMonth <= isoDate(new Date(today.getFullYear(), today.getMonth() + 1, 1)).slice(0, 7) && ['upcoming', 'watch'].includes(p.status))))
      .sort((a, b) => (a.expectedMonth || thisMonth).localeCompare(b.expectedMonth || thisMonth));
    // Pinned programs show regardless of industry filters; closed ones drop off.
    const pinned = programs.filter((p) => p.pinned && !['closed', 'not_running'].includes(p.status));

    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString();
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 1).toISOString();
    const events = db.prepare('SELECT id, kind, title, starts_at, duration_min, location FROM events WHERE user_id = ? AND starts_at >= ? AND starts_at < ? ORDER BY starts_at')
      .all(req.user.id, monthStart, monthEnd).map((e) => ({ id: e.id, kind: e.kind, title: e.title, startsAt: e.starts_at, durationMin: e.duration_min, location: e.location }));

    res.json({ ...base, academicYear: `${ay}-${String(ay + 1).slice(2)}`, now, next, pinned, deadlines, toWatch, events });
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
  const fmtOf = (f) => ({ pattern: f.pattern, domain: f.domain, maxLocal: f.max_local });
  const firmView = (f) => ({
    id: f.id, name: f.name, sector: f.sector, category: f.category, domain: f.domain, pattern: f.pattern,
    format: `${f.pattern}@${f.domain}`, maxLocal: f.max_local, example: buildAddress('Jane', 'Doe', fmtOf(f)), confidence: f.confidence,
    fallbacks: JSON.parse(f.fallbacks_json).map((fb) => ({ ...fb, format: `${fb.pattern}@${fb.domain}`, example: buildAddress('Jane', 'Doe', { ...fb, maxLocal: f.max_local }) })),
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
    const fallbacks = JSON.parse(f.fallbacks_json).filter((fb) => PATTERNS[fb.pattern]).map((fb) => ({ ...fb, maxLocal: f.max_local }));
    res.json({ firm: f.name, primary: variants(fmtOf(f)), fallbacks: [...new Set(fallbacks.flatMap(variants))], confidence: f.confidence, notes: f.notes });
  });

  return r;
};

module.exports.views = views;
module.exports.isoDate = isoDate;
