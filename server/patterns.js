'use strict';
// Learns how each firm formats addresses (first.last@, flast@, ...) from the
// contacts already in the database, and generates candidate addresses for
// people whose email we don't have yet.

const PATTERNS = {
  'first.last': (f, l) => `${f}.${l}`,
  flast: (f, l) => `${f[0]}${l}`,
  first_last: (f, l) => `${f}_${l}`,
  firstlast: (f, l) => `${f}${l}`,
  first: (f) => f,
  firstl: (f, l) => `${f}${l[0]}`,
  'f.last': (f, l) => `${f[0]}.${l}`,
  'last.first': (f, l) => `${l}.${f}`,
  lastf: (f, l) => `${l}${f[0]}`,
  last: (f, l) => l,
};

const normName = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

/** Which known pattern produced this local part, or null. */
function detectPattern(email, firstName, lastName) {
  const local = String(email || '').split('@')[0].toLowerCase();
  const f = normName(firstName), l = normName(lastName);
  if (!local || !f || !l) return null;
  for (const [name, fn] of Object.entries(PATTERNS)) if (fn(f, l) === local) return name;
  return null;
}

/**
 * Pattern stats for a company from its known contacts.
 * Returns { dominant, confidence, counts, sample } where confidence is the share of
 * recognisable addresses that use the dominant pattern.
 */
function learnCompanyPattern(contacts) {
  const counts = {};
  let recognised = 0;
  for (const c of contacts) {
    const p = detectPattern(c.email, c.first_name, c.last_name);
    if (!p) continue;
    counts[p] = (counts[p] || 0) + 1;
    recognised++;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { dominant: null, confidence: 0, counts, sample: 0 };
  return { dominant: ranked[0][0], confidence: ranked[0][1] / recognised, counts, sample: recognised };
}

/** Candidate addresses ordered by likelihood (learned pattern first, then common defaults). */
function generateCandidates(firstName, lastName, domain, learned = null) {
  const f = normName(firstName), l = normName(lastName);
  if (!f || !l || !domain) return [];
  const order = ['first.last', 'flast', 'first', 'firstlast', 'f.last', 'first_last', 'firstl', 'last.first', 'lastf', 'last'];
  const ranked = learned?.dominant ? [learned.dominant, ...order.filter((p) => p !== learned.dominant)] : order;
  return ranked.map((p, i) => ({
    email: `${PATTERNS[p](f, l)}@${domain.toLowerCase()}`,
    pattern: p,
    // Prior likelihood used to rank guesses before verification.
    prior: p === learned?.dominant ? Math.round(learned.confidence * 100) : Math.max(5, 40 - i * 5),
  }));
}

module.exports = { PATTERNS, normName, detectPattern, learnCompanyPattern, generateCandidates };
