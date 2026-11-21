'use strict';
const crypto = require('node:crypto');
const express = require('express');
const { hashPassword, checkPassword, createSession, requireUser, emailAllowed, allowedDomains, SESSION_DAYS } = require('../auth');
const { sendMail } = require('../mailer');

module.exports = function authRoutes(db, { publicUser }) {
  const r = express.Router();
  const auth = requireUser(db);
  const baseUrl = (req) => process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const sendCookie = (res, token) => res.cookie('session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: SESSION_DAYS * 864e5 });

  async function sendVerification(req, user) {
    const link = `${baseUrl(req)}/api/auth/verify?token=${encodeURIComponent(user.verify_token)}`;
    await sendMail({
      to: user.email,
      subject: 'Confirm your BBSA Career Hub account',
      text: `Hi ${user.name},\n\nConfirm your Vanderbilt email to finish setting up your account:\n${link}\n\nIf you didn't sign up, you can ignore this email.`,
    });
  }

  r.post('/signup', async (req, res, next) => {
    try {
      const { email, password, name, gradYear } = req.body || {};
      const addr = String(email || '').trim().toLowerCase();
      if (!emailAllowed(addr)) return res.status(400).json({ error: `Use your ${allowedDomains().map((d) => '@' + d).join(' or ')} email address.` });
      if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required.' });
      const gy = gradYear ? Number(gradYear) : null;
      if (gy && (!Number.isInteger(gy) || gy < 2000 || gy > 2100)) return res.status(400).json({ error: 'Enter a valid graduation year.' });
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(addr)) return res.status(409).json({ error: 'An account with that email already exists. Try logging in.' });
      const verifyToken = crypto.randomBytes(24).toString('base64url');
      const info = db.prepare(`INSERT INTO users (email, name, password_hash, grad_year, verify_token, calendar_token) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(addr, String(name).trim(), hashPassword(password), gy, verifyToken, crypto.randomBytes(18).toString('base64url'));
      await sendVerification(req, db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid));
      res.status(201).json({ needsVerification: true, email: addr });
    } catch (err) { next(err); }
  });

  r.get('/verify', (req, res) => {
    const u = req.query.token && db.prepare('SELECT * FROM users WHERE verify_token = ?').get(String(req.query.token));
    if (!u) return res.redirect('/#login?verify=invalid');
    db.prepare(`UPDATE users SET email_verified_at = datetime('now'), verify_token = NULL WHERE id = ?`).run(u.id);
    const { token } = createSession(db, u.id);
    sendCookie(res, token);
    res.redirect('/#profile?welcome=1');
  });

  r.post('/resend', async (req, res, next) => {
    try {
      const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(req.body?.email || '').trim().toLowerCase());
      if (u && !u.email_verified_at) await sendVerification(req, u);
      res.json({ ok: true }); // same answer either way so this can't be used to probe for accounts
    } catch (err) { next(err); }
  });

  r.post('/login', (req, res) => {
    const { email, password } = req.body || {};
    const u = email && db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase());
    if (!u || !checkPassword(String(password || ''), u.password_hash)) return res.status(401).json({ error: 'Incorrect email or password.' });
    if (!u.email_verified_at) return res.status(403).json({ error: 'Confirm your email first. Check your Vanderbilt inbox for the link.', needsVerification: true });
    const { token } = createSession(db, u.id);
    sendCookie(res, token);
    res.json({ token, user: publicUser(u) });
  });

  r.post('/logout', auth, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
    res.clearCookie('session').json({ ok: true });
  });

  return r;
};
