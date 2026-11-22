'use strict';
const express = require('express');
const { toIcs, calendarLinks } = require('../calendar');
const { buildAddress } = require('../email/patterns');
const I = require('../content/internships');

/** Firm email formats keyed by lower-case firm name, for the "email format" line on each card. */
function formatsByName(db) {
  const map = new Map();
  for (const f of db.prepare('SELECT name, pattern, domain, max_local, confidence FROM firms').all()) {
    map.set(f.name.toLowerCase(), {
      format: `${f.pattern}@${f.domain}`, confidence: f.confidence,
      example: buildAddress('Jane', 'Doe', { pattern: f.pattern, domain: f.domain, maxLocal: f.max_local }),
    });
  }
  return map;
}

function internshipView(r, { today, starred = new Set(), formats = new Map() }) {
  const c = I.computeStatus(r, today);
  return {
    id: r.id, company: r.company, industry: r.industry, category: r.category, program: r.program, forStudents: r.for_students,
    internshipSummer: r.internship_summer, storedStatus: r.status, status: c.status, statusTone: c.tone, statusGroup: c.group,
    daysLeft: c.daysLeft, opens: r.opens, deadline: r.deadline, deadlineDate: r.deadline_date, link: r.link,
    linkLabel: I.linkLabel(r), linkType: r.link_type, nextCycle: r.next_cycle, notes: r.notes, source: r.source, asOf: r.as_of,
    emailFormat: formats.get(r.company.toLowerCase()) || null, starred: starred.has(r.id),
  };
}

/** A starred internship's deadline as an all-day calendar event (built on the fly, never stored). */
function deadlineEvent(r, userId) {
  const e = {
    id: `internship-${r.id}`, internshipId: r.id, uid: `internship-${r.id}-u${userId}@bbsa-career-hub`, kind: 'deadline',
    title: `Deadline: ${r.company} – ${r.program}`, all_day: true, date: r.deadline_date, starts_at: `${r.deadline_date}T12:00:00.000Z`,
    duration_min: 0, url: r.link || null, created_at: r.updated_at,
    description: [r.deadline && `Deadline: ${r.deadline}`, r.notes, r.link, `Info as of ${r.as_of || 'unknown'} · Source: ${r.source || 'unknown'}`].filter(Boolean).join('\n\n'),
  };
  return e;
}

/** Starred internships that have a deadline date, as calendar events. */
function starredDeadlineEvents(db, userId) {
  return db.prepare(`SELECT i.* FROM internship_stars s JOIN internships i ON i.id = s.internship_id
    WHERE s.user_id = ? AND i.deadline_date IS NOT NULL AND i.deadline_date != '' ORDER BY i.deadline_date`).all(userId)
    .map((r) => deadlineEvent(r, userId));
}

const eventViewOf = (e) => ({
  id: e.id, internshipId: e.internshipId, kind: e.kind, title: e.title, description: e.description, allDay: true, date: e.date,
  startsAt: e.starts_at, durationMin: 0, links: { ics: `/api/internships/${e.internshipId}.ics`, ...calendarLinks(e) },
});

function internshipRoutes(db) {
  const r = express.Router();
  const starredIds = (userId) => new Set(db.prepare('SELECT internship_id FROM internship_stars WHERE user_id = ?').all(userId).map((x) => x.internship_id));

  r.get('/', (req, res) => {
    const today = /^\d{4}-\d{2}-\d{2}$/.test(req.query.asOf || '') ? req.query.asOf : I.ymd(new Date());
    const all = db.prepare('SELECT * FROM internships').all();
    const ctx = { today, starred: starredIds(req.user.id), formats: formatsByName(db) };
    const q = String(req.query.q || '').trim().toLowerCase();
    const list = I.sortInternships(all, today).map((x) => internshipView(x, ctx))
      .filter((x) => !req.query.industry || x.industry === req.query.industry)
      .filter((x) => !req.query.category || x.category === req.query.category)
      .filter((x) => !req.query.for || x.forStudents === req.query.for)
      .filter((x) => !req.query.status || x.status === req.query.status)
      .filter((x) => req.query.starred !== '1' || x.starred)
      .filter((x) => !q || x.company.toLowerCase().includes(q));
    // Filter choices come from the data, so new categories or statuses appear without code changes.
    const uniq = (f) => [...new Set(all.map(f).filter(Boolean))].sort();
    const facets = {
      industries: I.INDUSTRIES,
      categories: uniq((x) => (req.query.industry && x.industry !== req.query.industry ? null : x.category)),
      forStudents: uniq((x) => x.for_students),
      statuses: uniq((x) => I.computeStatus(x, today).status),
    };
    res.json({ total: all.length, results: list, facets });
  });

  r.put('/:id/star', (req, res) => {
    const row = db.prepare('SELECT id FROM internships WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Internship not found.' });
    if (req.body?.starred === false) db.prepare('DELETE FROM internship_stars WHERE user_id = ? AND internship_id = ?').run(req.user.id, row.id);
    else db.prepare('INSERT OR IGNORE INTO internship_stars (user_id, internship_id) VALUES (?, ?)').run(req.user.id, row.id);
    res.json({ ok: true, starred: req.body?.starred !== false });
  });

  r.get('/:id.ics', (req, res) => {
    const row = db.prepare('SELECT * FROM internships WHERE id = ?').get(req.params.id);
    if (!row || !row.deadline_date) return res.status(404).json({ error: 'This internship has no deadline date yet.' });
    res.type('text/calendar').attachment(`deadline-${row.id}.ics`).send(toIcs([deadlineEvent(row, req.user.id)]));
  });

  return r;
}

module.exports = internshipRoutes;
module.exports.internshipView = internshipView;
module.exports.formatsByName = formatsByName;
module.exports.starredDeadlineEvents = starredDeadlineEvents;
module.exports.eventViewOf = eventViewOf;
