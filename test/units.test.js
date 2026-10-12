'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyEmail } = require('../server/verifier');
const { demoResolver } = require('../server/verifier/resolvers');
const { detectPattern, learnCompanyPattern, generateCandidates } = require('../server/patterns');
const { buildProfile, scoreContact } = require('../server/matcher');
const { parseCsv } = require('../server/csv');
const { toIcs, addBusinessDays } = require('../server/calendar');

const resolver = demoResolver();
const v = (email, opts = {}) => verifyEmail(email, { resolver, smtp: true, ...opts });

test('verifier: confirmed mailbox grades A', async () => {
  const r = await v('ava.chen@northbridgecapital.example');
  assert.equal(r.status, 'valid');
  assert.ok(r.score >= 80);
  assert.equal(r.reputation.label, 'High');
});

test('verifier: rejected mailbox, bad syntax, missing domain are invalid', async () => {
  for (const e of ['ghost.person@northbridgecapital.example', 'not-an-email', 'a..b@x.com', 'x@vantagetech.examp1e']) {
    const r = await v(e);
    assert.equal(r.status, 'invalid', e);
    assert.ok(r.score <= 10, e);
  }
});

test('verifier: catch-all domain is capped and flagged', async () => {
  const r = await v('anyone@meridianam.example');
  assert.equal(r.status, 'accept_all');
  assert.ok(r.score < 80);
});

test('verifier: role inbox and off-pattern addresses lose points', async () => {
  const ctx = { firstName: 'Liam', lastName: 'Patel', companyDomain: 'northbridgecapital.example', companyPattern: { dominant: 'first.last', confidence: 1, sample: 5 } };
  const good = await v('ava.chen@northbridgecapital.example', { smtp: false, context: { ...ctx, firstName: 'Ava', lastName: 'Chen' } });
  const role = await v('recruiting@northbridgecapital.example', { smtp: false });
  const off = await v('lpatel@northbridgecapital.example', { smtp: false, context: ctx });
  assert.equal(good.status, 'likely_valid');
  assert.ok(role.score < good.score);
  assert.ok(off.score < good.score);
  assert.equal(off.checks.find((c) => c.id === 'pattern').status, 'warn');
});

test('verifier: disposable and typo domains', async () => {
  const d = await v('kid@mailinator.com', { smtp: false });
  assert.equal(d.status, 'invalid');
  assert.equal(d.reputation.label, 'Low');
  const t = await v('bob@gmial.com', { smtp: false });
  assert.equal(t.suggestion, 'bob@gmail.com');
});

test('patterns: detect, learn, generate', () => {
  assert.equal(detectPattern('j.smith@x.com', 'John', 'Smith'), 'f.last');
  assert.equal(detectPattern('jsmith@x.com', 'John', 'Smith'), 'flast');
  assert.equal(detectPattern('josé.núñez@x.com', 'José', 'Núñez'), null); // local parts are ASCII-normalised
  const learned = learnCompanyPattern([
    { first_name: 'A', last_name: 'B', email: 'ab@x.com' },
    { first_name: 'Cara', last_name: 'Dee', email: 'cdee@x.com' },
    { first_name: 'Eve', last_name: 'Fox', email: 'efox@x.com' },
    { first_name: 'Gus', last_name: 'Ho', email: 'gus.ho@x.com' },
  ]);
  assert.equal(learned.dominant, 'flast');
  const c = generateCandidates('José', "O'Brien", 'Firm.com', learned);
  assert.equal(c[0].email, 'jobrien@firm.com');
  assert.ok(c.some((x) => x.email === 'jose.obrien@firm.com'));
});

test('matcher: synonyms, school and career track', () => {
  const p = buildProfile('Cornell University 2026. Mergers & acquisitions intern; financial modeling. Hobbies: hoops, bouldering, poker');
  assert.deepEqual(p.interests.sort(), ['basketball', 'poker', 'rock climbing']);
  assert.ok(p.schools.includes('Cornell University'));
  assert.equal(p.careerTracks[0], 'Investment Banking');
  const strong = scoreContact(p, { interests: 'basketball, poker', school: 'Cornell University', industry: 'Investment Banking' });
  const weak = scoreContact(p, { interests: 'golf', school: 'Howard University', industry: 'Law' });
  assert.ok(strong.score > 60);
  assert.equal(weak.score, 3); // golf is related (sports) to basketball
});

test('csv: quoted fields and CRLF', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
});

test('calendar: ics escaping/folding and business days', () => {
  const ics = toIcs([{ uid: 'u1', title: 'Chat; with, Ava', description: 'x'.repeat(200), starts_at: '2030-01-01T10:00:00Z', duration_min: 45 }]);
  assert.match(ics, /SUMMARY:Chat\; with\\, Ava/);
  assert.match(ics, /DTEND:20300101T104500Z/);
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
  assert.equal(addBusinessDays(new Date('2030-01-04T12:00:00Z'), 1).toISOString().slice(0, 10), '2030-01-07'); // Fri -> Mon
});
