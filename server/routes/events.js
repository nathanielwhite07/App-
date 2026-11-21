'use strict';
const crypto = require('node:crypto');
const express = require('express');
const { toIcs, googleCalendarLink, outlookCalendarLink } = require('../calendar');

const KINDS = ['meeting', 'deadline', 'reminder'];

module.exports = function eventRoutes(db) {
  const r = express.Router();

  const eventView = (e) => ({
    id: e.id, kind: e.kind, title: e.title, description: e.description, location: e.location,
    startsAt: e.starts_at, durationMin: e.duration_min, programId: e.program_id, milestoneId: e.milestone_id,
    links: { ics: `/api/events/${e.id}.ics`, google: googleCalendarLink(e), outlook: outlookCalendarLink(e) },
  });

  r.get('/', (req, res) => {
    const from = req.query.from ? new Date(req.query.from).toISOString() : '0000';
    const to = req.query.to ? new Date(req.query.to).toISOString() : '9999';
    res.json(db.prepare('SELECT * FROM events WHERE user_id = ? AND starts_at >= ? AND starts_at < ? ORDER BY starts_at')
      .all(req.user.id, from, to).map(eventView));
  });

  // Create a personal event, or add a program deadline / milestone reminder to the calendar.
  r.post('/', (req, res) => {
    const b = req.body || {};
    if (!b.startsAt || Number.isNaN(Date.parse(b.startsAt))) return res.status(400).json({ error: 'A valid start time is required.' });
    let { title, description, kind = 'meeting' } = b;
    let programId = null, milestoneId = null;
    if (b.programId) {
      const p = db.prepare('SELECT * FROM programs WHERE id = ?').get(b.programId);
      if (!p) return res.status(404).json({ error: 'Program not found.' });
      programId = p.id; kind = 'deadline';
      title = title || `Deadline: ${p.name} (${p.firm})`;
      description = description || [p.description, p.link].filter(Boolean).join('\n\n');
    }
    if (b.milestoneId) {
      const m = db.prepare('SELECT * FROM milestones WHERE id = ?').get(b.milestoneId);
      if (!m) return res.status(404).json({ error: 'Milestone not found.' });
      milestoneId = m.id; kind = 'reminder';
      title = title || m.title;
      description = description || [m.details, m.link].filter(Boolean).join('\n\n');
    }
    if (!KINDS.includes(kind)) return res.status(400).json({ error: `Kind must be one of ${KINDS.join(', ')}.` });
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'A title is required.' });
    const duration = Math.max(5, Math.min(Number(b.durationMin) || 30, 480));
    const info = db.prepare(`INSERT INTO events (user_id, program_id, milestone_id, kind, title, description, location, starts_at, duration_min, uid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.user.id, programId, milestoneId, kind, String(title).trim().slice(0, 300),
      description || null, b.location || null, new Date(b.startsAt).toISOString(), duration, `${crypto.randomUUID()}@bbsa-career-hub`);
    res.status(201).json(eventView(db.prepare('SELECT * FROM events WHERE id = ?').get(info.lastInsertRowid)));
  });

  r.delete('/:id', (req, res) => {
    const info = db.prepare('DELETE FROM events WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    if (!info.changes) return res.status(404).json({ error: 'Event not found.' });
    res.json({ ok: true });
  });

  r.get('/:id.ics', (req, res) => {
    const e = db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!e) return res.status(404).json({ error: 'Event not found.' });
    res.type('text/calendar').attachment(`event-${e.id}.ics`).send(toIcs([e]));
  });

  return r;
};

/** Public, secret-token feed so Google/Outlook/Apple Calendar can subscribe. */
module.exports.feed = (db) => (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE calendar_token = ?').get(req.params.token);
  if (!u) return res.status(404).send('Not found');
  const rows = db.prepare('SELECT * FROM events WHERE user_id = ? ORDER BY starts_at').all(u.id);
  res.type('text/calendar').send(toIcs(rows, { name: 'BBSA Recruiting' }));
};
