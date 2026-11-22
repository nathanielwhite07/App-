'use strict';
const crypto = require('node:crypto');
const express = require('express');
const { toIcs, calendarLinks } = require('../calendar');

const KINDS = ['meeting', 'deadline', 'reminder'];

const eventView = (e) => ({
  id: e.id, kind: e.kind, title: e.title, description: e.description, location: e.location,
  startsAt: e.starts_at, durationMin: e.duration_min, programId: e.program_id, milestoneId: e.milestone_id,
  links: { ics: `/api/events/${e.id}.ics`, ...calendarLinks(e) },
});

/** Insert an event, or return the existing one if the same reminder was already added. */
function createEvent(db, userId, { programId = null, milestoneId = null, kind, title, description = null, location = null, startsAt, durationMin = 30 }) {
  const iso = new Date(startsAt).toISOString();
  const dup = db.prepare(`SELECT * FROM events WHERE user_id = ? AND starts_at = ? AND title = ?`).get(userId, iso, title);
  if (dup) return { ...eventView(dup), existing: true };
  const info = db.prepare(`INSERT INTO events (user_id, program_id, milestone_id, kind, title, description, location, starts_at, duration_min, uid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, programId, milestoneId, kind, String(title).trim().slice(0, 300),
    description || null, location || null, iso, durationMin, `${crypto.randomUUID()}@bbsa-career-hub`);
  return eventView(db.prepare('SELECT * FROM events WHERE id = ?').get(info.lastInsertRowid));
}

function eventRoutes(db) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const from = req.query.from ? new Date(req.query.from).toISOString() : '0000';
    const to = req.query.to ? new Date(req.query.to).toISOString() : '9999';
    res.json(db.prepare('SELECT * FROM events WHERE user_id = ? AND starts_at >= ? AND starts_at < ? ORDER BY starts_at')
      .all(req.user.id, from, to).map(eventView));
  });

  // Create a personal event, or a reminder for a milestone. (Program reminders: POST /api/programs/:id/reminders.)
  r.post('/', (req, res) => {
    const b = req.body || {};
    if (!b.startsAt || Number.isNaN(Date.parse(b.startsAt))) return res.status(400).json({ error: 'A valid start time is required.' });
    let { title, description, kind = 'meeting' } = b;
    let milestoneId = null;
    if (b.milestoneId) {
      const m = db.prepare('SELECT * FROM milestones WHERE id = ?').get(b.milestoneId);
      if (!m) return res.status(404).json({ error: 'Milestone not found.' });
      milestoneId = m.id; kind = 'reminder';
      title = title || m.title;
      description = description || [m.details, m.link].filter(Boolean).join('\n\n');
    }
    if (!KINDS.includes(kind)) return res.status(400).json({ error: `Kind must be one of ${KINDS.join(', ')}.` });
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'A title is required.' });
    const durationMin = Math.max(5, Math.min(Number(b.durationMin) || 30, 480));
    res.status(201).json(createEvent(db, req.user.id, { milestoneId, kind, title, description, location: b.location, startsAt: b.startsAt, durationMin }));
  });

  r.delete('/:id', (req, res) => {
    const info = db.prepare('DELETE FROM events WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    if (!info.changes) return res.status(404).json({ error: 'Event not found.' });
    res.json({ ok: true });
  });

  // Several events in one file (e.g. all the reminders just added for a program): /api/events/export.ics?ids=1,2,3
  r.get('/export.ics', (req, res) => {
    const ids = String(req.query.ids || '').split(',').map(Number).filter(Number.isInteger).slice(0, 50);
    if (!ids.length) return res.status(400).json({ error: 'Pass ?ids=1,2,3' });
    const rows = db.prepare(`SELECT * FROM events WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY starts_at`).all(req.user.id, ...ids);
    if (!rows.length) return res.status(404).json({ error: 'Event not found.' });
    res.type('text/calendar').attachment('bbsa-reminders.ics').send(toIcs(rows));
  });

  r.get('/:id.ics', (req, res) => {
    const e = db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!e) return res.status(404).json({ error: 'Event not found.' });
    res.type('text/calendar').attachment(`event-${e.id}.ics`).send(toIcs([e]));
  });

  return r;
}

/** Public, secret-token feed so Google/Outlook/Apple Calendar can subscribe. */
function feed(db) {
  return (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE calendar_token = ?').get(req.params.token);
    if (!u) return res.status(404).send('Not found');
    const rows = db.prepare('SELECT * FROM events WHERE user_id = ? ORDER BY starts_at').all(u.id);
    res.type('text/calendar').send(toIcs(rows, { name: 'BBSA Recruiting' }));
  };
}

module.exports = eventRoutes;
module.exports.feed = feed;
module.exports.createEvent = createEvent;
module.exports.eventView = eventView;
