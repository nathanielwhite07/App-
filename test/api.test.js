'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, seedIfEmpty } = require('../server/db');
const { createApp } = require('../server/app');
const { demoResolver } = require('../server/verifier/resolvers');

let server, base, token;
const api = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body && { 'content-type': 'application/json' }), ...headers },
    body: body && JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
};

before(async () => {
  const db = openDb(':memory:');
  seedIfEmpty(db);
  server = createApp(db, { resolver: demoResolver(), smtp: true }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('signup, resume upload and matches', async () => {
  assert.equal((await api('GET', '/api/me')).status, 401);
  const s = await api('POST', '/api/auth/signup', { email: 'student@school.edu', password: 'hunter22!', name: 'Jamie Student', location: 'New York, NY' });
  assert.equal(s.status, 201);
  token = s.body.token;

  const r = await api('POST', '/api/me/resume', { text: 'Jamie Student\nNew York University, B.S. Finance 2027\nInvestment banking club, DCF and M&A modeling. Hobbies: basketball, jazz, travel, chess' });
  assert.equal(r.status, 200);
  assert.ok(r.body.profile.interests.includes('basketball'));
  assert.equal(r.body.school, 'New York University');

  const m = await api('GET', '/api/matches');
  assert.equal(m.body.needsResume, false);
  assert.ok(m.body.results.length > 0);
  const top = m.body.results[0];
  assert.ok(top.match.score > 0 && top.match.reasons.length > 0);
  for (let i = 1; i < m.body.results.length; i++) assert.ok(m.body.results[i - 1].match.score >= m.body.results[i].match.score);
});

test('search and contact verification', async () => {
  const s = await api('GET', '/api/contacts?q=Northbridge');
  assert.equal(s.body.results.length, 6);
  const target = s.body.results.find((c) => c.email && !c.email.startsWith('recruiting'));
  const v = await api('POST', `/api/contacts/${target.id}/verify`);
  assert.equal(v.body.status, 'valid');
  assert.ok(['A', 'A+'].includes(v.body.grade));
  assert.ok(v.body.checks.find((c) => c.id === 'pattern').status === 'pass');
  const again = await api('GET', `/api/contacts/${target.id}`);
  assert.equal(again.body.verification.status, 'valid');
});

test('email finder guesses using the firm pattern', async () => {
  const cos = await api('GET', '/api/companies');
  const nb = cos.body.find((c) => c.name === 'Northbridge Capital');
  assert.equal(nb.emailPattern.dominant, 'first.last');
  // A known person: the first guess should be confirmed by the (simulated) mail server.
  const known = (await api('GET', `/api/contacts?company=${nb.id}`)).body.results.find((c) => /^[a-z]+\.[a-z]+@/.test(c.email));
  const f = await api('POST', '/api/finder', { firstName: known.firstName, lastName: known.lastName, companyId: nb.id });
  assert.equal(f.body.best.email, known.email);
  assert.equal(f.body.best.verification.status, 'valid');
  // Catch-all domain: stops after the first candidate with accept_all.
  const mer = cos.body.find((c) => c.domain === 'meridianam.example');
  const g = await api('POST', '/api/finder', { firstName: 'New', lastName: 'Person', companyId: mer.id });
  assert.equal(g.body.candidates.length, 1);
  assert.equal(g.body.best.verification.status, 'accept_all');
});

test('import CSV then calendar flow', async () => {
  const csv = 'First Name,Last Name,Email,Company,Title,School,Interests\n"Dana","Ortiz",dana.ortiz@acme.example,Acme Corp,Analyst,New York University,"jazz; travel"\nBad,,x@y.example,,,,\n';
  const imp = await api('POST', '/api/import', { csv });
  assert.equal(imp.body.created, 1);
  assert.equal(imp.body.errors.length, 1);
  const dana = (await api('GET', '/api/contacts?q=Ortiz')).body.results[0];
  assert.ok(dana.match.reasons.some((r) => r.type === 'school'));

  const saved = await api('PUT', `/api/saved/${dana.id}`, { status: 'emailed' });
  assert.equal(saved.body.followUp.kind, 'follow_up');

  const ev = await api('POST', '/api/events', { contactId: dana.id, startsAt: '2030-03-04T15:00:00Z', durationMin: 30, location: 'Zoom' });
  assert.equal(ev.status, 201);
  assert.match(ev.body.event.title, /Dana Ortiz/);
  assert.match(ev.body.event.links.google, /calendar\.google\.com/);
  assert.ok(ev.body.followUp);

  const ics = await api('GET', ev.body.event.links.ics);
  assert.match(ics.body, /BEGIN:VEVENT[\s\S]*DTSTART:20300304T150000Z/);
  const me = await api('GET', '/api/me');
  const feed = await api('GET', me.body.calendarFeed, null, { authorization: '' });
  assert.equal((feed.body.match(/BEGIN:VEVENT/g) || []).length, 3);
});
