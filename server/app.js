'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');

const { tx, upsertContact } = require('./db');
const { hashPassword, checkPassword, createSession, requireUser, SESSION_DAYS } = require('./auth');
const { verifyEmail } = require('./verifier');
const { defaultResolver } = require('./verifier/resolvers');
const { learnCompanyPattern, generateCandidates } = require('./patterns');
const { buildProfile, scoreContact, rankContacts, draftIntro } = require('./matcher');
const { extractResumeText } = require('./resume');
const { csvToContacts } = require('./csv');
const { toIcs, googleCalendarLink, outlookCalendarLink, addBusinessDays } = require('./calendar');

const CONTACT_SELECT = `SELECT c.*, co.name AS company, co.domain, co.industry, co.hq
  FROM contacts c JOIN companies co ON co.id = c.company_id`;

/** Simple fixed-window rate limiter keyed by user id. */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.user?.id ?? req.ip;
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.start > windowMs) hits.set(key, { start: now, n: 1 });
    else if (++h.n > max) return res.status(429).json({ error: 'Too many verification requests. Try again in a minute.' });
    next();
  };
}

function createApp(db, { resolver = defaultResolver(), smtp } = {}) {
  const app = express();
  const auth = requireUser(db);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
  const verifyLimit = rateLimit({ windowMs: 60_000, max: 60 });
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---------- helpers ----------
  const getContact = (id) => db.prepare(`${CONTACT_SELECT} WHERE c.id = ?`).get(id);
  const companyPatternCache = new Map();
  const companyPattern = (companyId) => {
    if (!companyPatternCache.has(companyId)) {
      const rows = db.prepare('SELECT first_name, last_name, email FROM contacts WHERE company_id = ? AND email IS NOT NULL').all(companyId);
      companyPatternCache.set(companyId, learnCompanyPattern(rows));
    }
    return companyPatternCache.get(companyId);
  };
  const userProfile = (user) => {
    const p = user.profile_json ? JSON.parse(user.profile_json) : { interests: [], schools: [], careerTracks: [], skills: [] };
    return { ...p, school: user.school, location: user.location };
  };
  const publicUser = (u) => ({
    id: u.id, email: u.email, name: u.name, school: u.school, location: u.location,
    resumeFilename: u.resume_filename, profile: u.profile_json ? JSON.parse(u.profile_json) : null,
    calendarFeed: u.calendar_token ? `/calendar/${u.calendar_token}.ics` : null,
  });
  const contactView = (c, user) => {
    const out = {
      id: c.id, firstName: c.first_name, lastName: c.last_name, name: `${c.first_name} ${c.last_name}`,
      email: c.email, title: c.title, department: c.department, company: c.company, companyId: c.company_id,
      domain: c.domain, industry: c.industry, location: c.location, school: c.school,
      interests: c.interests ? c.interests.split(',').map((s) => s.trim()).filter(Boolean) : [],
      bio: c.bio, linkedin: c.linkedin, lastVerifiedAt: c.last_verified_at,
      verification: c.verification_json ? JSON.parse(c.verification_json) : null,
    };
    if (user) out.match = scoreContact(userProfile(user), c);
    return out;
  };
  const verifyForContact = async (c, email = c.email) => verifyEmail(email, {
    resolver, smtp,
    context: { firstName: c.first_name, lastName: c.last_name, companyDomain: c.domain, companyPattern: companyPattern(c.company_id), lastVerifiedAt: c.last_verified_at },
  });
  const sendCookie = (res, token) => res.cookie('session', token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_DAYS * 864e5 });

  // ---------- auth ----------
  app.post('/api/auth/signup', (req, res) => {
    const { email, password, name, school, location } = req.body || {};
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'A valid email is required.' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.toLowerCase())) return res.status(409).json({ error: 'An account with that email already exists.' });
    const r = db.prepare('INSERT INTO users (email, name, password_hash, school, location, calendar_token) VALUES (?, ?, ?, ?, ?, ?)')
      .run(email.toLowerCase(), name, hashPassword(password), school || null, location || null, crypto.randomBytes(18).toString('base64url'));
    const { token } = createSession(db, Number(r.lastInsertRowid));
    sendCookie(res, token);
    res.status(201).json({ token, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)) });
  });

  app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body || {};
    const u = email && db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
    if (!u || !checkPassword(String(password || ''), u.password_hash)) return res.status(401).json({ error: 'Incorrect email or password.' });
    const { token } = createSession(db, u.id);
    sendCookie(res, token);
    res.json({ token, user: publicUser(u) });
  });

  app.post('/api/auth/logout', auth, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
    res.clearCookie('session').json({ ok: true });
  });

  // ---------- profile & resume ----------
  app.get('/api/me', auth, (req, res) => res.json(publicUser(req.user)));

  app.patch('/api/me', auth, (req, res) => {
    const { name, school, location } = req.body || {};
    db.prepare('UPDATE users SET name = COALESCE(?, name), school = COALESCE(?, school), location = COALESCE(?, location) WHERE id = ?')
      .run(name ?? null, school ?? null, location ?? null, req.user.id);
    res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
  });

  app.post('/api/me/resume', auth, upload.single('resume'), wrap(async (req, res) => {
    let text, filename;
    if (req.file) {
      text = await extractResumeText(req.file.buffer, req.file.originalname, req.file.mimetype);
      filename = req.file.originalname;
    } else if (req.body?.text) {
      text = String(req.body.text);
      filename = 'pasted-resume.txt';
    } else return res.status(400).json({ error: 'Upload a resume file (field "resume") or send { text }.' });
    if (!text.trim()) return res.status(422).json({ error: 'Could not read any text from that file. If it is a scanned PDF, try a DOCX or paste the text.' });
    const knownSchools = db.prepare('SELECT DISTINCT school FROM contacts WHERE school IS NOT NULL').all().map((r) => r.school);
    const profile = buildProfile(text, { knownSchools });
    const school = req.user.school || profile.schools[0] || null;
    db.prepare('UPDATE users SET resume_filename = ?, resume_text = ?, profile_json = ?, school = ? WHERE id = ?')
      .run(filename, text, JSON.stringify(profile), school, req.user.id);
    res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
  }));

  // Let students fix what the parser got wrong.
  app.put('/api/me/profile', auth, (req, res) => {
    const cur = userProfile(req.user);
    const clean = (a) => (Array.isArray(a) ? a.map((s) => String(s).trim().toLowerCase()).filter(Boolean) : undefined);
    const next = {
      interests: clean(req.body?.interests) ?? cur.interests,
      schools: Array.isArray(req.body?.schools) ? req.body.schools : cur.schools,
      careerTracks: Array.isArray(req.body?.careerTracks) ? req.body.careerTracks : cur.careerTracks,
      skills: clean(req.body?.skills) ?? cur.skills,
    };
    db.prepare('UPDATE users SET profile_json = ? WHERE id = ?').run(JSON.stringify(next), req.user.id);
    res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
  });

  // ---------- directory ----------
  app.get('/api/companies', auth, (req, res) => {
    const rows = db.prepare(`SELECT co.*, COUNT(c.id) AS contacts FROM companies co LEFT JOIN contacts c ON c.company_id = co.id
      GROUP BY co.id ORDER BY co.name`).all();
    res.json(rows.map((co) => ({ ...co, emailPattern: companyPattern(co.id) })));
  });

  app.get('/api/contacts', auth, (req, res) => {
    const { q, company, industry, school, interest, sort = 'match' } = req.query;
    const where = [], args = [];
    if (q) {
      where.push(`(c.first_name || ' ' || c.last_name LIKE ? OR c.title LIKE ? OR c.department LIKE ? OR co.name LIKE ? OR c.email LIKE ?)`);
      args.push(...Array(5).fill(`%${q}%`));
    }
    if (company) { where.push('co.id = ?'); args.push(Number(company)); }
    if (industry) { where.push('co.industry = ?'); args.push(industry); }
    if (school) { where.push('c.school LIKE ?'); args.push(`%${school}%`); }
    if (interest) { where.push('(c.interests LIKE ? OR c.bio LIKE ?)'); args.push(`%${interest}%`, `%${interest}%`); }
    const rows = db.prepare(`${CONTACT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY co.name, c.last_name LIMIT 500`).all(...args);
    let out = rows.map((c) => contactView(c, req.user));
    if (sort === 'match') out.sort((a, b) => b.match.score - a.match.score);
    const limit = Math.min(Number(req.query.limit) || 50, 200), offset = Number(req.query.offset) || 0;
    res.json({ total: out.length, results: out.slice(offset, offset + limit) });
  });

  app.get('/api/contacts/:id', auth, (req, res) => {
    const c = getContact(req.params.id);
    if (!c) return res.status(404).json({ error: 'Contact not found.' });
    const saved = db.prepare('SELECT status, notes FROM saved_contacts WHERE user_id = ? AND contact_id = ?').get(req.user.id, c.id);
    res.json({ ...contactView(c, req.user), saved: saved || null, emailPattern: companyPattern(c.company_id) });
  });

  app.post('/api/contacts/:id/verify', auth, verifyLimit, wrap(async (req, res) => {
    const c = getContact(req.params.id);
    if (!c) return res.status(404).json({ error: 'Contact not found.' });
    if (!c.email) return res.status(400).json({ error: 'No email on file. Use the email finder to guess one.' });
    const result = await verifyForContact(c);
    db.prepare('UPDATE contacts SET verification_json = ?, last_verified_at = ? WHERE id = ?').run(JSON.stringify(result), result.checkedAt, c.id);
    res.json(result);
  }));

  app.get('/api/contacts/:id/intro', auth, (req, res) => {
    const c = getContact(req.params.id);
    if (!c) return res.status(404).json({ error: 'Contact not found.' });
    const match = scoreContact(userProfile(req.user), c);
    res.json({ subject: `${req.user.school ? req.user.school + ' student' : 'Student'} interested in ${c.industry}`, body: draftIntro(req.user, c, match) });
  });

  // ---------- matches ----------
  app.get('/api/matches', auth, (req, res) => {
    const profile = userProfile(req.user);
    if (!profile.interests.length && !profile.schools.length && !profile.careerTracks.length) {
      return res.json({ needsResume: true, results: [] });
    }
    const rows = db.prepare(CONTACT_SELECT).all();
    const ranked = rankContacts(profile, rows, { limit: Math.min(Number(req.query.limit) || 20, 100) });
    res.json({ needsResume: false, profile, results: ranked.map((r) => ({ ...contactView(r.contact), match: { score: r.score, reasons: r.reasons, sharedInterests: r.sharedInterests } })) });
  });

  // ---------- email finder & verifier ----------
  app.post('/api/finder', auth, verifyLimit, wrap(async (req, res) => {
    const { firstName, lastName, companyId, domain: rawDomain, maxChecks = 4 } = req.body || {};
    if (!firstName || !lastName) return res.status(400).json({ error: 'First and last name are required.' });
    let domain = rawDomain && String(rawDomain).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    let learned = null, company = null;
    if (companyId) {
      company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
      if (!company) return res.status(404).json({ error: 'Company not found.' });
      domain = company.domain;
      learned = companyPattern(company.id);
    } else if (domain) {
      company = db.prepare('SELECT * FROM companies WHERE domain = ?').get(domain);
      if (company) learned = companyPattern(company.id);
    }
    if (!domain) return res.status(400).json({ error: 'Pick a company or enter its domain.' });

    const known = company && db.prepare(`${CONTACT_SELECT} WHERE c.company_id = ? AND lower(c.first_name) = lower(?) AND lower(c.last_name) = lower(?)`)
      .get(company.id, firstName, lastName);
    const candidates = generateCandidates(firstName, lastName, domain, learned);
    const context = { firstName, lastName, companyDomain: domain, companyPattern: learned };
    const checked = [];
    // Verify in likelihood order and stop at the first confirmed mailbox; a catch-all
    // domain accepts everything, so after one accept-all there's nothing more to learn.
    for (const cand of candidates.slice(0, Math.min(Number(maxChecks) || 4, 8))) {
      const v = await verifyEmail(cand.email, { resolver, smtp, context });
      checked.push({ ...cand, verification: v });
      if (v.status === 'valid' || v.status === 'accept_all' || v.checks.some((c) => c.id === 'mx' && c.status === 'fail')) break;
    }
    const best = checked.find((c) => c.verification.status === 'valid')
      || [...checked].sort((a, b) => b.verification.score - a.verification.score)[0] || null;
    res.json({ domain, company: company?.name || null, knownContact: known ? contactView(known) : null, emailPattern: learned, best, candidates: checked, untested: candidates.slice(checked.length) });
  }));

  app.post('/api/verify', auth, verifyLimit, wrap(async (req, res) => {
    const email = String(req.body?.email || '').trim();
    if (!email) return res.status(400).json({ error: 'Enter an email address.' });
    const domain = email.split('@')[1]?.toLowerCase();
    const contact = db.prepare(`${CONTACT_SELECT} WHERE lower(c.email) = lower(?)`).get(email);
    const company = contact ? null : domain && db.prepare('SELECT * FROM companies WHERE domain = ?').get(domain);
    const result = contact ? await verifyForContact(contact, email)
      : await verifyEmail(email, { resolver, smtp, context: company ? { companyDomain: company.domain } : {} });
    if (contact) db.prepare('UPDATE contacts SET verification_json = ?, last_verified_at = ? WHERE id = ?').run(JSON.stringify(result), result.checkedAt, contact.id);
    res.json({ ...result, contact: contact ? { id: contact.id, name: `${contact.first_name} ${contact.last_name}`, company: contact.company } : null });
  }));

  app.post('/api/verify/bulk', auth, wrap(async (req, res) => {
    const emails = [...new Set((req.body?.emails || []).map((e) => String(e).trim()).filter(Boolean))];
    if (!emails.length) return res.status(400).json({ error: 'Send { emails: [...] }.' });
    if (emails.length > 50) return res.status(400).json({ error: 'Bulk verification is limited to 50 addresses per request.' });
    const results = [];
    // Small concurrency to stay polite to remote mail servers.
    for (let i = 0; i < emails.length; i += 5) {
      results.push(...await Promise.all(emails.slice(i, i + 5).map((e) => verifyEmail(e, { resolver, smtp }))));
    }
    const summary = results.reduce((s, r) => ({ ...s, [r.status]: (s[r.status] || 0) + 1 }), {});
    res.json({ summary, results });
  }));

  // ---------- import ----------
  app.post('/api/import', auth, upload.single('file'), (req, res) => {
    let parsed;
    if (req.file) parsed = csvToContacts(req.file.buffer.toString('utf8'));
    else if (typeof req.body?.csv === 'string') parsed = csvToContacts(req.body.csv);
    else if (Array.isArray(req.body?.contacts)) parsed = { contacts: req.body.contacts, errors: [] };
    else return res.status(400).json({ error: 'Upload a CSV (field "file"), or send { csv } or { contacts: [...] }.' });
    let created = 0, updated = 0;
    tx(db, () => {
      for (const c of parsed.contacts) {
        if (!c.domain && c.email) c.domain = c.email.split('@')[1];
        if (!c.domain) { parsed.errors.push(`${c.first_name} ${c.last_name}: no company domain.`); continue; }
        (upsertContact(db, { ...c, source: 'import' }).created ? created++ : updated++);
      }
    });
    companyPatternCache.clear();
    res.json({ created, updated, errors: parsed.errors.slice(0, 50) });
  });

  // ---------- saved contacts / outreach pipeline ----------
  app.get('/api/saved', auth, (req, res) => {
    const rows = db.prepare(`${CONTACT_SELECT.replace('FROM contacts c', ', s.status, s.notes, s.updated_at FROM saved_contacts s JOIN contacts c ON c.id = s.contact_id')}
      WHERE s.user_id = ? ORDER BY s.updated_at DESC`).all(req.user.id);
    res.json(rows.map((r) => ({ ...contactView(r, req.user), status: r.status, notes: r.notes, updatedAt: r.updated_at })));
  });

  const STATUSES = ['saved', 'emailed', 'replied', 'meeting', 'closed'];
  app.put('/api/saved/:contactId', auth, (req, res) => {
    const c = getContact(req.params.contactId);
    if (!c) return res.status(404).json({ error: 'Contact not found.' });
    const status = req.body?.status || 'saved';
    if (!STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of ${STATUSES.join(', ')}.` });
    const prev = db.prepare('SELECT status FROM saved_contacts WHERE user_id = ? AND contact_id = ?').get(req.user.id, c.id);
    db.prepare(`INSERT INTO saved_contacts (user_id, contact_id, status, notes) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, contact_id) DO UPDATE SET status = excluded.status, notes = COALESCE(excluded.notes, notes), updated_at = datetime('now')`)
      .run(req.user.id, c.id, status, req.body?.notes ?? null);
    // Marking someone as emailed schedules a follow-up reminder 5 business days out.
    let followUp = null;
    if (status === 'emailed' && prev?.status !== 'emailed') {
      const at = addBusinessDays(new Date(), 5);
      at.setUTCHours(14, 0, 0, 0);
      followUp = createEvent(req.user.id, {
        contactId: c.id, kind: 'follow_up', title: `Follow up with ${c.first_name} ${c.last_name} (${c.company})`,
        description: `No reply yet? Send a short, polite follow-up to ${c.email || 'them'}.`, startsAt: at.toISOString(), durationMin: 15,
      });
    }
    res.json({ ok: true, status, followUp });
  });

  app.delete('/api/saved/:contactId', auth, (req, res) => {
    db.prepare('DELETE FROM saved_contacts WHERE user_id = ? AND contact_id = ?').run(req.user.id, req.params.contactId);
    res.json({ ok: true });
  });

  // ---------- calendar ----------
  const eventView = (e) => {
    const c = e.contact_id ? getContact(e.contact_id) : null;
    const withAttendee = { ...e, attendee: c?.email ? { name: `${c.first_name} ${c.last_name}`, email: c.email } : null };
    return {
      id: e.id, kind: e.kind, title: e.title, description: e.description, location: e.location,
      startsAt: e.starts_at, durationMin: e.duration_min, contact: c ? { id: c.id, name: `${c.first_name} ${c.last_name}`, company: c.company, email: c.email } : null,
      links: { ics: `/api/events/${e.id}.ics`, google: googleCalendarLink(withAttendee), outlook: outlookCalendarLink(withAttendee) },
    };
  };
  function createEvent(userId, { contactId = null, kind = 'meeting', title, description, location, startsAt, durationMin = 30 }) {
    const r = db.prepare(`INSERT INTO events (user_id, contact_id, kind, title, description, location, starts_at, duration_min, uid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, contactId, kind, title, description || null, location || null,
      new Date(startsAt).toISOString(), durationMin, `${crypto.randomUUID()}@firmconnect`);
    return eventView(db.prepare('SELECT * FROM events WHERE id = ?').get(r.lastInsertRowid));
  }

  app.get('/api/events', auth, (req, res) => {
    const from = req.query.from ? new Date(req.query.from).toISOString() : '0000';
    const to = req.query.to ? new Date(req.query.to).toISOString() : '9999';
    const rows = db.prepare('SELECT * FROM events WHERE user_id = ? AND starts_at >= ? AND starts_at < ? ORDER BY starts_at').all(req.user.id, from, to);
    res.json(rows.map(eventView));
  });

  app.post('/api/events', auth, (req, res) => {
    const b = req.body || {};
    if (!b.startsAt || Number.isNaN(Date.parse(b.startsAt))) return res.status(400).json({ error: 'A valid start time is required.' });
    let title = b.title;
    if (b.contactId) {
      const c = getContact(b.contactId);
      if (!c) return res.status(404).json({ error: 'Contact not found.' });
      title = title || `Coffee chat: ${c.first_name} ${c.last_name} (${c.company})`;
      db.prepare(`INSERT INTO saved_contacts (user_id, contact_id, status) VALUES (?, ?, 'meeting')
        ON CONFLICT(user_id, contact_id) DO UPDATE SET status = 'meeting', updated_at = datetime('now')`).run(req.user.id, c.id);
    }
    if (!title) return res.status(400).json({ error: 'A title is required.' });
    const duration = Math.max(5, Math.min(Number(b.durationMin) || 30, 480));
    const event = createEvent(req.user.id, { contactId: b.contactId, kind: b.kind || 'meeting', title, description: b.description, location: b.location, startsAt: b.startsAt, durationMin: duration });
    let followUp = null;
    if (b.thankYouReminder !== false && event.kind === 'meeting' && b.contactId) {
      const at = new Date(Date.parse(event.startsAt) + (duration + 60) * 60000);
      followUp = createEvent(req.user.id, { contactId: b.contactId, kind: 'follow_up', title: `Send thank-you note to ${event.contact.name}`,
        description: 'Reference something specific from the conversation and ask about next steps.', startsAt: at.toISOString(), durationMin: 15 });
    }
    res.status(201).json({ event, followUp });
  });

  app.delete('/api/events/:id', auth, (req, res) => {
    const r = db.prepare('DELETE FROM events WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    if (!r.changes) return res.status(404).json({ error: 'Event not found.' });
    res.json({ ok: true });
  });

  app.get('/api/events/:id.ics', auth, (req, res) => {
    const e = db.prepare('SELECT * FROM events WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!e) return res.status(404).json({ error: 'Event not found.' });
    const v = eventView(e);
    res.type('text/calendar').attachment(`event-${e.id}.ics`)
      .send(toIcs([{ ...e, attendee: v.contact?.email ? { name: v.contact.name, email: v.contact.email } : null }]));
  });

  // Secret-token feed so Google/Outlook/Apple Calendar can subscribe and stay in sync.
  app.get('/calendar/:token.ics', (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE calendar_token = ?').get(req.params.token);
    if (!u) return res.status(404).send('Not found');
    const rows = db.prepare('SELECT * FROM events WHERE user_id = ? ORDER BY starts_at').all(u.id);
    res.type('text/calendar').send(toIcs(rows, { name: `${u.name} – Networking` }));
  });

  app.post('/api/me/calendar-token', auth, (req, res) => {
    const token = crypto.randomBytes(18).toString('base64url');
    db.prepare('UPDATE users SET calendar_token = ? WHERE id = ?').run(token, req.user.id);
    res.json({ calendarFeed: `/calendar/${token}.ics` });
  });

  // ---------- errors ----------
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong.' : err.message });
  });

  return app;
}

module.exports = { createApp };
