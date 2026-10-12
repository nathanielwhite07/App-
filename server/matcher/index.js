'use strict';
const { TAGS, CAREER_TRACKS, SKILLS } = require('./taxonomy');

const SYNONYMS = Object.entries(TAGS).flatMap(([tag, [, words]]) => words.map((w) => [w, tag]));
const GROUP = Object.fromEntries(Object.entries(TAGS).map(([tag, [group]]) => [tag, group]));

const pad = (text) => ` ${String(text || '').toLowerCase().replace(/[^a-z0-9&+#.\- ]+/g, ' ').replace(/\s+/g, ' ')} `;
const has = (hay, word) => {
  const w = word.trim();
  // word boundary match that tolerates symbols like "c++" and "m&a"
  return new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(hay);
};

/** Canonical interest tags mentioned in free text. */
function extractTags(text) {
  const hay = pad(text);
  const found = new Set();
  for (const [word, tag] of SYNONYMS) if (has(hay, word)) found.add(tag);
  return [...found];
}

const SCHOOL_RE = /\b((?:University of [A-Z][A-Za-z.&' -]+?|[A-Z][A-Za-z.&'-]+(?: [A-Z][A-Za-z.&'-]+){0,3} (?:University|College|Institute of Technology))(?: at [A-Z][A-Za-z ]+?)?)(?=[,\n;|(]|\s{2}|\s[-–—]|\s(?:19|20)\d\d|\s(?:B\.?[AS]|M\.?[AS]|Bachelor|Master|Class)|$)/gm;

/** Turn raw resume text into a structured profile. */
function buildProfile(text, { knownSchools = [] } = {}) {
  const raw = String(text || '');
  const hay = pad(raw);
  const schools = new Set();
  for (const s of knownSchools) if (raw.toLowerCase().includes(s.toLowerCase())) schools.add(s);
  for (const m of raw.matchAll(SCHOOL_RE)) {
    const s = m[1].trim();
    if (s.length < 60 && ![...schools].some((k) => k.toLowerCase() === s.toLowerCase())) schools.add(s);
  }
  const careerTracks = Object.entries(CAREER_TRACKS)
    .map(([industry, words]) => [industry, words.filter((w) => has(hay, w)).length])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([industry]) => industry);
  return {
    interests: extractTags(raw),
    schools: [...schools],
    careerTracks,
    skills: SKILLS.filter((s) => has(hay, s)),
    emails: [...new Set(raw.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [])],
  };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const sameSchool = (a, b) => {
  const x = norm(a).replace(/^the/, ''), y = norm(b).replace(/^the/, '');
  return x && y && (x === y || x.includes(y) || y.includes(x));
};
const city = (loc) => String(loc || '').split(',')[0].trim().toLowerCase();

/**
 * Score how much a contact has in common with the student (0-100) and explain why.
 * @param profile  output of buildProfile (plus optional user.location/user.school)
 * @param contact  row from contacts joined with company (company, industry)
 */
function scoreContact(profile, contact) {
  const reasons = [];
  let score = 0;

  const contactTags = new Set(extractTags(`${contact.interests || ''} ${contact.bio || ''}`));
  const mine = new Set(profile.interests || []);
  const shared = [...mine].filter((t) => contactTags.has(t));
  if (shared.length) {
    score += Math.min(48, shared.length * 16);
    reasons.push({ type: 'interest', text: `Shared interests: ${shared.join(', ')}`, tags: shared });
  }
  const myGroups = new Set([...mine].map((t) => GROUP[t]));
  const related = [...contactTags].filter((t) => !shared.includes(t) && myGroups.has(GROUP[t]));
  if (related.length) {
    score += Math.min(9, related.length * 3);
    reasons.push({ type: 'related', text: `Related interests: they like ${related.join(', ')}`, tags: related });
  }

  const schools = [...(profile.schools || []), profile.school].filter(Boolean);
  const school = schools.find((s) => sameSchool(s, contact.school));
  if (school) {
    score += 25;
    reasons.push({ type: 'school', text: `Fellow ${contact.school} alum` });
  }

  const trackIdx = (profile.careerTracks || []).indexOf(contact.industry);
  if (trackIdx !== -1) {
    score += trackIdx === 0 ? 15 : 8;
    reasons.push({ type: 'career', text: `Works in ${contact.industry}, which matches your resume` });
  }

  if (profile.location && city(profile.location) && city(profile.location) === city(contact.location)) {
    score += 8;
    reasons.push({ type: 'location', text: `Also based in ${contact.location}` });
  }

  return { score: Math.min(100, score), reasons, sharedInterests: shared };
}

/** Rank contacts for a profile, best first. */
function rankContacts(profile, contacts, { limit = 25, minScore = 1 } = {}) {
  return contacts
    .map((c) => ({ contact: c, ...scoreContact(profile, c) }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** A short, personalised cold-email opener based on what the student shares with the contact. */
function draftIntro(user, contact, match) {
  const hooks = [];
  const school = match.reasons.find((r) => r.type === 'school');
  if (school) hooks.push(`as a fellow ${contact.school} student`);
  if (match.sharedInterests.length) hooks.push(`I noticed we're both into ${match.sharedInterests.slice(0, 2).join(' and ')}`);
  const hook = hooks.length ? ` ${hooks.join(', and ')}.` : '';
  return `Hi ${contact.first_name},\n\nMy name is ${user.name}${user.school ? `, and I'm a student at ${user.school}` : ''}. ` +
    `I came across your work as ${/^[aeiou]/i.test(contact.title || '') ? 'an' : 'a'} ${contact.title} at ${contact.company}${hook ? ' and' : ''}${hook || '.'}\n\n` +
    `I'm exploring a career in ${contact.industry} and would really value 15 minutes of your time to hear about your path and your work in ${contact.department || 'the group'}. ` +
    `Would you be open to a quick call in the next couple of weeks?\n\nThank you,\n${user.name}`;
}

module.exports = { extractTags, buildProfile, scoreContact, rankContacts, draftIntro };
