'use strict';
const crypto = require('node:crypto');

const SESSION_DAYS = 14;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function checkPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return { token, expires };
}

function readToken(req) {
  const h = req.get('authorization') || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  const m = /(?:^|;\s*)session=([^;]+)/.exec(req.get('cookie') || '');
  return m ? decodeURIComponent(m[1]) : null;
}

/** Express middleware: attaches req.user or responds 401. */
function requireUser(db) {
  return (req, res, next) => {
    const token = readToken(req);
    const row = token && db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ?`).get(token, new Date().toISOString());
    if (!row) return res.status(401).json({ error: 'Please log in.' });
    req.user = row;
    req.sessionToken = token;
    next();
  };
}

module.exports = { hashPassword, checkPassword, createSession, requireUser, readToken, SESSION_DAYS };
