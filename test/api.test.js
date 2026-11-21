'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_EMAILS = 'officer@vanderbilt.edu';
process.env.ALLOWED_EMAIL_DOMAINS = 'vanderbilt.edu';
delete process.env.SMTP_URL;

const { openDb } = require('../server/db');
const { seedIfEmpty } = require('../server/content/store');
const { createApp } = require('../server/app');

let server, base, db;
const tokens = {};

async function api(method, path, body, who) {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: { ...(who && { authorization: `Bearer ${tokens[who]}` }), ...(body && { 'content-type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
}

async function signUpAndLogin(who, email, extra = {}) {
  const s = await api('POST', '/api/auth/signup', { email, password: 'password123', name: who, ...extra });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const { verify_token: vt } = db.prepare('SELECT verify_token FROM users WHERE email = lower(?)').get(email);
  const v = await api('GET', `/api/auth/verify?token=${vt}`);
  assert.equal(v.status, 302);
  const l = await api('POST', '/api/auth/login', { email, password: 'password123' });
  assert.equal(l.status, 200);
  tokens[who] = l.body.token;
  return l.body.user;
}

before(async () => {
  db = openDb(':memory:');
  seedIfEmpty(db);
  console.log = () => {}; // the dev mailer prints verification emails
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
const log = console.log;
after(() => { console.log = log; server.close(); });

test('only verified @vanderbilt.edu accounts can sign in', async () => {
  const gmail = await api('POST', '/api/auth/signup', { email: 'someone@gmail.com', password: 'password123', name: 'X' });
  assert.equal(gmail.status, 400);
  assert.match(gmail.body.error, /vanderbilt\.edu/);
  const sub = await api('POST', '/api/auth/signup', { email: 'x@evil.vanderbilt.edu.com', password: 'password123', name: 'X' });
  assert.equal(sub.status, 400);

  await api('POST', '/api/auth/signup', { email: 'unverified@vanderbilt.edu', password: 'password123', name: 'U' });
  const early = await api('POST', '/api/auth/login', { email: 'unverified@vanderbilt.edu', password: 'password123' });
  assert.equal(early.status, 403);
  assert.equal(early.body.needsVerification, true);
  const badLink = await api('GET', '/api/auth/verify?token=nope');
  assert.match(badLink.headers.get('location'), /verify=invalid/);
});

test('class year comes from graduation year; admin comes from ADMIN_EMAILS', async () => {
  const student = await signUpAndLogin('student', 'student@vanderbilt.edu', { gradYear: 2029 });
  assert.equal(student.isAdmin, false);
  assert.ok([1, 2, 3, 4].includes(student.classYear));
  const officer = await signUpAndLogin('officer', 'Officer@Vanderbilt.edu');
  assert.equal(officer.isAdmin, true);
  assert.equal((await api('GET', '/api/admin/programs', null, 'student')).status, 403);
  assert.equal((await api('GET', '/api/admin/programs', null, 'officer')).status, 200);
});

test('timelines and the industry guides are seeded from the slides', async () => {
  const inds = await api('GET', '/api/industries', null, 'student');
  assert.deepEqual(inds.body.map((i) => i.slug), ['investment-banking', 'consulting', 'tech']);
  assert.ok(inds.body.every((i) => i.guide.length > 0));
  const soph = await api('GET', '/api/timelines?industry=consulting&year=2', null, 'student');
  assert.ok(soph.body.length >= 8);
  assert.ok(soph.body.every((m) => m.classYears.length === 0 || m.classYears.includes(2)));
  assert.ok(soph.body.some((m) => m.when === 'Dec–Feb' && /network/i.test(m.title)));
});

test('this-month view filters by class year, industries and date', async () => {
  await api('PATCH', '/api/me', { gradYear: 2029, industries: ['consulting'] }, 'student');
  // Class of 2029 is a sophomore in 2026-27. January: consulting networking + case prep windows are open.
  const jan = await api('GET', '/api/this-month?asOf=2027-01-15', null, 'student');
  assert.equal(jan.body.classYear, 2);
  assert.equal(jan.body.academicYear, '2026-27');
  assert.ok(jan.body.now.length > 0);
  assert.ok(jan.body.now.every((m) => m.industry === 'consulting'));
  assert.ok(jan.body.now.some((m) => /Network heavily/.test(m.title)));
  assert.ok(jan.body.next.every((m) => m.startMonth === 2));
  // Mark one done; it sinks to the bottom and stays done for the academic year.
  const first = jan.body.now[0];
  await api('PUT', `/api/milestones/${first.id}/progress?asOf=2027-01-15`, { done: true }, 'student');
  const again = await api('GET', '/api/this-month?asOf=2027-01-20', null, 'student');
  assert.equal(again.body.now.find((m) => m.id === first.id).done, true);
  assert.equal(again.body.now.at(-1).id, first.id);
  // Next academic year the same milestone is fresh again (and the student is a junior).
  const later = await api('GET', '/api/this-month?asOf=2027-09-15', null, 'student');
  assert.equal(later.body.classYear, 3);

  const pre = await api('GET', '/api/this-month?asOf=2024-09-01', null, 'student');
  assert.equal(pre.body.outOfRange, true);
});

test('officer edits programs; deadlines show up in this-month and can go on the calendar', async () => {
  const progs = await api('GET', '/api/admin/programs', null, 'officer');
  const bel = progs.body.find((p) => p.name === 'Bain BEL');
  assert.equal(bel.needs_review, true);
  const upd = await api('PUT', `/api/admin/programs/${bel.id}`, { ...bel, deadline: '2027-02-01', link: 'https://www.bain.com/careers/', needs_review: false }, 'officer');
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  const badLink = await api('PUT', `/api/admin/programs/${bel.id}`, { ...bel, link: 'javascript:alert(1)' }, 'officer');
  assert.equal(badLink.status, 400);

  const added = await api('POST', '/api/admin/programs', {
    name: 'Example Early Insights', firm: 'Example Bank', industry: 'investment-banking', eligible_years: '1, 2', deadline: '2027-01-25',
  }, 'officer');
  assert.equal(added.status, 201);

  const filtered = await api('GET', '/api/programs?industry=consulting&year=2&asOf=2027-01-15', null, 'student');
  assert.ok(filtered.body.every((p) => p.industry === 'consulting'));
  const b = filtered.body.find((p) => p.name === 'Bain BEL');
  assert.equal(b.status, 'open');
  assert.equal(b.daysLeft, 17);

  const tm = await api('GET', '/api/this-month?asOf=2027-01-15', null, 'student');
  assert.deepEqual(tm.body.deadlines.map((p) => p.name), ['Bain BEL']); // IB program hidden: student follows consulting only
  assert.ok(tm.body.toWatch.some((p) => p.name === 'BCG Embark'));

  const ev = await api('POST', '/api/events', { programId: b.id, startsAt: '2027-02-01T15:00:00Z' }, 'student');
  assert.equal(ev.status, 201);
  assert.equal(ev.body.kind, 'deadline');
  assert.match(ev.body.title, /Bain BEL/);
  const ics = await api('GET', ev.body.links.ics, null, 'student');
  assert.match(ics.body, /TRIGGER:-P1D/);
  const me = await api('GET', '/api/me', null, 'student');
  const feed = await api('GET', me.body.calendarFeed);
  assert.match(feed.body, /SUMMARY:Deadline: Bain BEL/);
});

test('officer can add industries and milestones without code changes', async () => {
  const ind = await api('POST', '/api/admin/industries', { slug: 'sales-trading', name: 'Sales & Trading', sort_order: 4 }, 'officer');
  assert.equal(ind.status, 201);
  const ms = await api('POST', '/api/admin/milestones', {
    industry: 'sales-trading', class_years: [2], start_month: 11, end_month: 2, title: 'Network with S&T desks', category: 'network',
  }, 'officer');
  assert.equal(ms.status, 201, JSON.stringify(ms.body));
  const tl = await api('GET', '/api/timelines?industry=sales-trading', null, 'student');
  assert.equal(tl.body[0].when, 'Nov–Feb');
  const bad = await api('POST', '/api/admin/milestones', { industry: 'sales-trading', start_month: 13, end_month: 2, title: 'x' }, 'officer');
  assert.equal(bad.status, 400);
});

test('content export/import round-trips', async () => {
  const exp = await api('GET', '/api/admin/content', null, 'officer');
  assert.ok(exp.body.milestones.length > 20);
  const imp = await api('POST', '/api/admin/content', exp.body, 'officer');
  assert.equal(imp.status, 200);
  assert.equal(imp.body.milestones, exp.body.milestones.length);
  assert.equal(imp.body.firms.created, 0);
});

test('email formats: search, build an address, spreadsheet upload', async () => {
  const all = await api('GET', '/api/formats', null, 'student');
  assert.equal(all.body.results.length, 100);
  assert.deepEqual(all.body.sectors, ['Consulting', 'Finance']);
  const bcg = (await api('GET', '/api/formats?q=bcg.com', null, 'student')).body.results[0];
  assert.equal(bcg.example, 'doe.jane@bcg.com');
  const addr = await api('GET', `/api/formats/${bcg.id}/address?first=Jordan&last=Lee`, null, 'student');
  assert.deepEqual(addr.body.primary, ['lee.jordan@bcg.com']);
  const rb = (await api('GET', '/api/formats?q=Roland', null, 'student')).body.results[0];
  const umlaut = await api('GET', `/api/formats/${rb.id}/address?first=Jürgen&last=Müller`, null, 'student');
  assert.deepEqual(umlaut.body.primary, ['jurgen.muller@rolandberger.com', 'juergen.mueller@rolandberger.com']);

  const csv = 'Firm,Best Email Format,Confidence,Fallback / Notes,Category\nExample Tech,first.last@exampletech.com,High,Fallback: jdoe@exampletech.com,Big Tech\nBroken Co,nonsense,High,,\n';
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'tech-formats.csv');
  fd.append('sector', 'Tech');
  const up = await fetch(`${base}/api/admin/firms/import`, { method: 'POST', headers: { authorization: `Bearer ${tokens.officer}` }, body: fd }).then((r) => r.json());
  assert.equal(up.created, 1);
  assert.equal(up.errors.length, 1);
  const et = (await api('GET', '/api/formats?q=Example Tech', null, 'student')).body.results[0];
  assert.equal(et.sector, 'Tech');
  assert.equal(et.fallbacks[0].format, 'flast@exampletech.com');
});
