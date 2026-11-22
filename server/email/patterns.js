'use strict';
// Email formats: how a firm builds addresses (first.last@, flast@, ...).
// Formats are maintained by officers (spreadsheet import / admin page); this module
// parses them and turns a person's name into an address.

const PATTERNS = {
  'first.last': (f, l) => `${f}.${l}`,
  first_last: (f, l) => `${f}_${l}`,
  'first-last': (f, l) => `${f}-${l}`,
  firstlast: (f, l) => `${f}${l}`,
  flast: (f, l) => `${f[0]}${l}`,
  'f.last': (f, l) => `${f[0]}.${l}`,
  firstl: (f, l) => `${f}${l[0]}`,
  'first.l': (f, l) => `${f}.${l[0]}`,
  first: (f) => f,
  'last.first': (f, l) => `${l}.${f}`,
  last_first: (f, l) => `${l}_${f}`,
  lastf: (f, l) => `${l}${f[0]}`,
  lfirst: (f, l) => `${l[0]}${f}`,
  last: (f, l) => l,
};

// German-style transliteration first (Roland Berger: ö→oe), then strip remaining accents.
const TRANSLIT = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', Ä: 'ae', Ö: 'oe', Ü: 'ue' };
const normName = (s, { transliterate = false } = {}) => {
  let v = String(s || '');
  if (transliterate) v = v.replace(/[äöüßÄÖÜ]/g, (c) => TRANSLIT[c]);
  return v.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
};

/** Which known pattern produced this local part, or null. */
function detectPattern(email, firstName, lastName) {
  const local = String(email || '').split('@')[0].toLowerCase();
  const f = normName(firstName), l = normName(lastName);
  if (!local || !f || !l) return null;
  for (const [name, fn] of Object.entries(PATTERNS)) if (fn(f, l) === local) return name;
  return null;
}

/**
 * "first_last@mckinsey.com" -> { pattern: 'first_last', domain: 'mckinsey.com' }, or null.
 * A trailing note like "(8-character limit)" sets maxLocal (Cisco truncates usernames).
 */
function parseFormat(format) {
  const m = /^\s*([a-z._-]+)@([a-z0-9.-]+\.[a-z]{2,})\s*(?:\((\d+)[- ]character limit\))?\s*$/i.exec(String(format || ''));
  if (!m || !PATTERNS[m[1].toLowerCase()]) return null;
  const out = { pattern: m[1].toLowerCase(), domain: m[2].toLowerCase() };
  if (m[3]) out.maxLocal = Number(m[3]);
  return out;
}

/**
 * Pull fallback formats out of free-text notes that use Jane Doe examples, e.g.
 * "Fallback: jane.doe@mckinsey.com (RocketReach 23%)" -> [{ pattern: 'first.last', domain: 'mckinsey.com' }].
 * A local part with no domain ("try janed@, then jdoe@") uses defaultDomain.
 */
function fallbacksFromNotes(notes, defaultDomain = null) {
  const out = [];
  for (const [, local, dom] of String(notes || '').matchAll(/(?<![\w.])([a-z._-]+)@([a-z0-9.-]+\.[a-z]{2,})?/gi)) {
    const domain = (dom || defaultDomain || '').toLowerCase();
    const pattern = detectPattern(`${local}@x`, 'Jane', 'Doe');
    if (pattern && domain && !out.some((o) => o.pattern === pattern && o.domain === domain)) out.push({ pattern, domain });
  }
  return out;
}

/** Build an address from a name, or null if the name or format is unusable. */
function buildAddress(firstName, lastName, { pattern, domain, maxLocal }, opts) {
  const f = normName(firstName, opts), l = normName(lastName, opts);
  if (!f || !l || !PATTERNS[pattern] || !domain) return null;
  const local = PATTERNS[pattern](f, l);
  return `${maxLocal ? local.slice(0, maxLocal) : local}@${domain}`;
}

module.exports = { PATTERNS, normName, detectPattern, parseFormat, fallbacksFromNotes, buildAddress };
