'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const { requireUser, requireAdmin, isAdmin } = require('./auth');
const { YEAR_NAMES, classYear } = require('./academic');
const { subscribeLinks } = require('./calendar');
const authRoutes = require('./routes/auth');
const contentRoutes = require('./routes/content');
const eventRoutes = require('./routes/events');
const adminRoutes = require('./routes/admin');
const internshipRoutes = require('./routes/internships');

function createApp(db) {
  const app = express();
  const auth = requireUser(db);

  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const CALENDAR_PROVIDERS = ['google', 'outlook', 'outlookcom', 'ics'];
  const baseUrl = (req) => process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const publicUser = (u, req) => {
    const cy = classYear(u.grad_year);
    const feed = u.calendar_token ? `/calendar/${u.calendar_token}.ics` : null;
    return {
      id: u.id, email: u.email, name: u.name, gradYear: u.grad_year, classYear: cy, classYearName: YEAR_NAMES[cy] || null,
      industries: JSON.parse(u.industry_slugs || '[]'), isAdmin: isAdmin(u), calendarProvider: u.calendar_provider || null,
      calendarFeed: feed, calendarSubscribe: feed && req ? subscribeLinks(baseUrl(req) + feed) : null,
    };
  };

  app.use('/api/auth', authRoutes(db, { publicUser }));

  // ----- profile -----
  app.get('/api/me', auth, (req, res) => res.json(publicUser(req.user, req)));
  app.patch('/api/me', auth, (req, res) => {
    const b = req.body || {};
    const sets = [], args = [];
    if (b.name !== undefined) {
      if (!String(b.name).trim()) return res.status(400).json({ error: 'Name is required.' });
      sets.push('name = ?'); args.push(String(b.name).trim());
    }
    if (b.gradYear !== undefined) {
      const gy = b.gradYear === null || b.gradYear === '' ? null : Number(b.gradYear);
      if (gy !== null && (!Number.isInteger(gy) || gy < 2000 || gy > 2100)) return res.status(400).json({ error: 'Enter a valid graduation year.' });
      sets.push('grad_year = ?'); args.push(gy);
    }
    if (b.industries !== undefined) {
      if (!Array.isArray(b.industries)) return res.status(400).json({ error: 'Industries must be a list.' });
      const known = new Set(db.prepare('SELECT slug FROM industries').all().map((r) => r.slug));
      const unknown = b.industries.filter((s) => !known.has(s));
      if (unknown.length) return res.status(400).json({ error: `Unknown industry: ${unknown.join(', ')}` });
      sets.push('industry_slugs = ?'); args.push(JSON.stringify([...new Set(b.industries)]));
    }
    if (b.calendarProvider !== undefined) {
      if (b.calendarProvider !== null && !CALENDAR_PROVIDERS.includes(b.calendarProvider)) return res.status(400).json({ error: 'Unknown calendar.' });
      sets.push('calendar_provider = ?'); args.push(b.calendarProvider);
    }
    if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, req.user.id);
    res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id), req));
  });
  app.post('/api/me/calendar-token', auth, (req, res) => {
    const token = crypto.randomBytes(18).toString('base64url');
    db.prepare('UPDATE users SET calendar_token = ? WHERE id = ?').run(token, req.user.id);
    res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id), req));
  });

  app.use('/api', auth, contentRoutes(db));
  app.use('/api/events', auth, eventRoutes(db));
  app.use('/api/internships', auth, internshipRoutes(db));
  app.use('/api/admin', auth, requireAdmin, adminRoutes(db));
  app.get('/calendar/:token.ics', eventRoutes.feed(db));

  // ----- errors -----
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong.' : err.message });
  });

  return app;
}

module.exports = { createApp };
