'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

process.env.ADMIN_EMAILS = 'officer@vanderbilt.edu';
process.env.ALLOWED_EMAIL_DOMAINS = 'vanderbilt.edu';
delete process.env.SMTP_URL;
delete process.env.APP_URL;

const { openDb } = require('../server/db');
const { syncContent, CONTENT_VERSION } = require('../server/content/store');
const { createApp } = require('../server/app');
const { seedInternships } = require('../server/content/internships');

let server, base, db;
const tokens = {};

async function api(method, url, body, who) {
  const res = await fetch(base + url, {
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

const log = console.log;
before(async () => {
  db = openDb(':memory:');
  syncContent(db);
  seedInternships(db);
  console.log = () => {}; // the dev mailer prints verification emails
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
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
  const officer = await signUpAndLogin('officer', 'Officer@Vanderbilt.edu');
  assert.equal(officer.isAdmin, true);
  assert.equal((await api('GET', '/api/admin/programs', null, 'student')).status, 403);
  assert.equal((await api('GET', '/api/admin/programs', null, 'officer')).status, 200);
});

test('five tracks with guides, written without slide or club references', async () => {
  const inds = await api('GET', '/api/industries', null, 'student');
  assert.deepEqual(inds.body.map((i) => i.slug), ['investment-banking', 'consulting', 'swe', 'pm', 'sales-trading']);
  assert.ok(inds.body.every((i) => i.guide.length >= 5));
  const all = [];
  for (const i of inds.body) all.push(...(await api('GET', `/api/timelines?industry=${i.slug}`, null, 'student')).body);
  assert.ok(all.length > 60);
  const text = JSON.stringify([inds.body, all]);
  assert.doesNotMatch(text, /akpsi|alpha kappa|slides?\b|slideshow|\bBDP\b|\b(nov|oct)\w* \d+ meeting|meeting of/i);
  assert.ok(all.every((m) => !m.source));
  for (const slug of ['swe', 'pm', 'sales-trading']) {
    const years = new Set(all.filter((m) => m.industry === slug).flatMap((m) => m.classYears));
    assert.deepEqual([...years].sort(), [1, 2, 3, 4], `${slug} covers every class year`);
  }
  const st = await api('GET', '/api/timelines?industry=sales-trading&year=2', null, 'student');
  assert.ok(st.body.some((m) => m.when === 'Dec–Feb' && /apply/i.test(m.title)));
});

test('this-month view filters by class year, industries and date', async () => {
  await api('PATCH', '/api/me', { gradYear: 2029, industries: ['consulting'] }, 'student');
  const jan = await api('GET', '/api/this-month?asOf=2027-01-15', null, 'student');
  assert.equal(jan.body.classYear, 2);
  assert.ok(jan.body.now.length > 0);
  assert.ok(jan.body.now.every((m) => m.industry === 'consulting'));
  const first = jan.body.now[0];
  await api('PUT', `/api/milestones/${first.id}/progress?asOf=2027-01-15`, { done: true }, 'student');
  const again = await api('GET', '/api/this-month?asOf=2027-01-20', null, 'student');
  assert.equal(again.body.now.at(-1).id, first.id);
  assert.equal(again.body.now.at(-1).done, true);
  const pre = await api('GET', '/api/this-month?asOf=2024-09-01', null, 'student');
  assert.equal(pre.body.outOfRange, true);
});

test('programs from the spreadsheet: statuses follow the calendar', async () => {
  const nov = await api('GET', '/api/programs?asOf=2026-11-22', null, 'student');
  assert.equal(nov.body.length, 84);
  const bel = nov.body.find((p) => p.name.startsWith('Building Entrepreneurial Leaders'));
  assert.equal(bel.status, 'open');
  assert.equal(bel.daysLeft, 8);
  assert.equal(bel.closingSoon, true);
  assert.match(bel.link, /^https:\/\/www\.bain\.com/);
  assert.deepEqual(bel.eligibleYears, [2]);
  // Deadline passes -> closed.
  const dec = (await api('GET', '/api/programs?asOf=2026-12-01', null, 'student')).body;
  assert.equal(dec.find((p) => p.id === bel.id).status, 'closed');
  // Expected month arrives -> check now.
  const gs = nov.body.find((p) => p.name.startsWith('Possibilities Series'));
  assert.equal(gs.status, 'upcoming');
  assert.equal(gs.expectedMonth, '2027-02');
  const feb = (await api('GET', '/api/programs?asOf=2027-02-03', null, 'student')).body;
  assert.equal(feb.find((p) => p.id === gs.id).status, 'check_now');
  // Multi-industry pipeline orgs show under each industry; filters combine.
  const swe = (await api('GET', '/api/programs?industry=swe&asOf=2026-11-22', null, 'student')).body;
  assert.ok(swe.some((p) => p.firm === 'INROADS') && swe.some((p) => p.firm === 'ColorStack'));
  assert.ok(swe.every((p) => p.industries.includes('swe')));
  const freshmanPipelines = (await api('GET', '/api/programs?year=1&kind=pipeline&status=open&asOf=2026-11-22', null, 'student')).body;
  assert.ok(freshmanPipelines.length > 0 && freshmanPipelines.every((p) => p.kind === 'pipeline' && p.status === 'open'));
});

test('pin programs and add their dates to the calendar', async () => {
  const progs = (await api('GET', '/api/programs?asOf=2026-11-22', null, 'student')).body;
  const fttp = progs.find((p) => p.name.startsWith('FTTP'));
  const pin = await api('PUT', `/api/programs/${fttp.id}/pin`, { pinned: true }, 'student');
  assert.equal(pin.body.pinned, true);
  const pinned = (await api('GET', '/api/programs?pinned=1', null, 'student')).body;
  assert.deepEqual(pinned.map((p) => p.id), [fttp.id]);
  // Pinned programs show on This month even outside the student's industries (they follow consulting).
  const tm = (await api('GET', '/api/this-month?asOf=2026-11-22', null, 'student')).body;
  assert.ok(tm.pinned.some((p) => p.id === fttp.id));

  const rem = await api('POST', `/api/programs/${fttp.id}/reminders`, {
    items: [{ type: 'apply', startsAt: '2027-01-24T15:00:00Z' }, { type: 'deadline', startsAt: '2027-01-31T15:00:00Z' }],
  }, 'student');
  assert.equal(rem.status, 201);
  assert.equal(rem.body.events.length, 2);
  assert.match(rem.body.events[0].title, /^Start your application: FTTP.*due Jan 31/);
  assert.equal(rem.body.events[1].kind, 'deadline');
  const ev = rem.body.events[1];
  assert.match(ev.links.google, /calendar\.google\.com/);
  assert.match(ev.links.outlook, /^https:\/\/outlook\.office\.com\/calendar\/0\/deeplink\/compose/);
  assert.match(ev.links.outlookcom, /^https:\/\/outlook\.live\.com\/calendar\/0\/deeplink\/compose/);
  // Adding the same reminders again doesn't duplicate them.
  const again = await api('POST', `/api/programs/${fttp.id}/reminders`, { items: [{ type: 'deadline', startsAt: '2027-01-31T15:00:00Z' }] }, 'student');
  assert.equal(again.body.events[0].id, ev.id);
  const bad = await api('POST', `/api/programs/${fttp.id}/reminders`, { items: [{ type: 'party', startsAt: '2027-01-01' }] }, 'student');
  assert.equal(bad.status, 400);

  const ics = await api('GET', `/api/events/export.ics?ids=${rem.body.events.map((e) => e.id).join(',')}`, null, 'student');
  assert.equal((ics.body.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.match(ics.body, /TRIGGER:-P1D/);

  await api('PUT', `/api/programs/${fttp.id}/pin`, { pinned: false }, 'student');
  assert.equal((await api('GET', '/api/programs?pinned=1', null, 'student')).body.length, 0);
});

test('calendar preference and subscribe links for Google and Outlook', async () => {
  const me = await api('PATCH', '/api/me', { calendarProvider: 'outlook' }, 'student');
  assert.equal(me.body.calendarProvider, 'outlook');
  const sub = me.body.calendarSubscribe;
  assert.match(sub.outlook, /^https:\/\/outlook\.office\.com\/calendar\/0\/addfromweb\?url=http/);
  assert.match(sub.outlookcom, /^https:\/\/outlook\.live\.com\/calendar\/0\/addfromweb/);
  assert.match(sub.google, /calendar\.google\.com\/calendar\/r\?cid=webcal/);
  assert.match(sub.ics, /^webcal:\/\//);
  assert.equal((await api('PATCH', '/api/me', { calendarProvider: 'yahoo' }, 'student')).status, 400);
  const feed = await api('GET', me.body.calendarFeed);
  assert.match(feed.body, /SUMMARY:Deadline: FTTP/);
});

test('officer edits programs and re-uploads the spreadsheet', async () => {
  const rows = (await api('GET', '/api/admin/programs', null, 'officer')).body;
  const lazard = rows.find((p) => p.firm === 'Lazard');
  const upd = await api('PUT', `/api/admin/programs/${lazard.id}`, { ...lazard, deadline: '2027-02-15', status: 'open', industries: ['investment-banking', 'sales-trading'] }, 'officer');
  assert.equal(upd.status, 200, JSON.stringify(upd.body));
  const badLink = await api('PUT', `/api/admin/programs/${lazard.id}`, { ...lazard, link: 'javascript:alert(1)' }, 'officer');
  assert.equal(badLink.status, 400);
  const noInd = await api('PUT', `/api/admin/programs/${lazard.id}`, { ...lazard, industries: [] }, 'officer');
  assert.equal(noInd.status, 400);

  const csv = 'Industry,Firm,Program,Eligible year,Deadline / timing,Deadline date,Status,Link\n'
    + 'Banking,Lazard,Early Insights,Sophomore,Updated timing,2027-02-20,Open,https://www.lazard.com/careers/\n'
    + 'Tech,Example Co,Product Explorers,Freshman & sophomore,Expected Mar 2027,,Upcoming,https://example.com/apm\n'
    + 'Space,Nobody,Moon Program,Freshman,,,Open,\n';
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'programs.csv');
  fd.append('cycle', '2026-27');
  const up = await fetch(`${base}/api/admin/programs/import`, { method: 'POST', headers: { authorization: `Bearer ${tokens.officer}` }, body: fd }).then((r) => r.json());
  assert.equal(up.updated, 1);
  assert.equal(up.created, 1);
  assert.equal(up.errors.length, 1);
  const after = (await api('GET', '/api/admin/programs', null, 'officer')).body;
  assert.equal(after.find((p) => p.id === lazard.id).deadline, '2027-02-20'); // same row updated, so pins/reminders survive
  const ex = after.find((p) => p.firm === 'Example Co');
  assert.deepEqual(ex.industries, ['pm']);
  assert.deepEqual(ex.eligible_years, [1, 2]);
  assert.equal(ex.expected_month, '2027-03');
});

test('officer can add industries and milestones without code changes', async () => {
  assert.equal((await api('POST', '/api/admin/industries', { slug: 'private-equity', name: 'Private Equity', sort_order: 6 }, 'officer')).status, 201);
  const ms = await api('POST', '/api/admin/milestones', {
    industry: 'private-equity', class_years: [3], start_month: 11, end_month: 2, title: 'Network with PE investors', category: 'network',
  }, 'officer');
  assert.equal(ms.status, 201, JSON.stringify(ms.body));
  assert.equal((await api('GET', '/api/timelines?industry=private-equity', null, 'student')).body[0].when, 'Nov–Feb');
  const rename = (await api('GET', '/api/admin/industries', null, 'officer')).body.find((i) => i.slug === 'private-equity');
  await api('PUT', `/api/admin/industries/${rename.id}`, { ...rename, slug: 'pe' }, 'officer');
  assert.equal((await api('GET', '/api/timelines?industry=pe', null, 'student')).body.length, 1);
});

test('content export/import round-trips', async () => {
  const exp = await api('GET', '/api/admin/content', null, 'officer');
  assert.ok(exp.body.programs.length >= 85);
  const imp = await api('POST', '/api/admin/content', exp.body, 'officer');
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.equal(imp.body.programs, exp.body.programs.length);
  assert.equal(imp.body.firms.created, 0);
});

test('email formats: tech firms, length limits and domainless fallbacks', async () => {
  const all = await api('GET', '/api/formats', null, 'student');
  assert.equal(all.body.results.length, 150);
  assert.deepEqual(all.body.sectors, ['Consulting', 'Finance', 'Tech']);
  const cisco = (await api('GET', '/api/formats?q=cisco', null, 'student')).body.results[0];
  const addr = await api('GET', `/api/formats/${cisco.id}/address?first=Alexandra&last=Vaverka`, null, 'student');
  assert.deepEqual(addr.body.primary, ['avaverka@cisco.com']);
  const long = await api('GET', `/api/formats/${cisco.id}/address?first=Jordan&last=Washington`, null, 'student');
  assert.deepEqual(long.body.primary, ['jwashing@cisco.com']);
  const ms = (await api('GET', '/api/formats?q=microsoft.com', null, 'student')).body.results[0];
  const msAddr = await api('GET', `/api/formats/${ms.id}/address?first=Jordan&last=Lee`, null, 'student');
  assert.deepEqual(msAddr.body.primary, ['jordanl@microsoft.com']);
  assert.deepEqual(msAddr.body.fallbacks, ['jlee@microsoft.com', 'jordan.lee@microsoft.com']);
  const bcg = (await api('GET', '/api/formats?q=bcg.com', null, 'student')).body.results[0];
  assert.equal(bcg.example, 'doe.jane@bcg.com');
});

test('upgrading a database from the previous version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbsa-upgrade-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password_hash TEXT NOT NULL, grad_year INTEGER,
      industry_slugs TEXT NOT NULL DEFAULT '[]', email_verified_at TEXT, verify_token TEXT UNIQUE, calendar_token TEXT UNIQUE, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE industries (id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, summary TEXT, guide_json TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, updated_by TEXT, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE programs (id INTEGER PRIMARY KEY, name TEXT NOT NULL, firm TEXT NOT NULL, industry_id INTEGER NOT NULL, eligible_years TEXT NOT NULL DEFAULT '[]',
      cycle TEXT, opens_on TEXT, deadline TEXT, rolling INTEGER NOT NULL DEFAULT 0, link TEXT, description TEXT, needs_review INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1, updated_by TEXT, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE firms (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, sector TEXT, category TEXT, domain TEXT NOT NULL, pattern TEXT NOT NULL, confidence TEXT,
      fallbacks_json TEXT NOT NULL DEFAULT '[]', notes TEXT, sources_agree TEXT, researched_on TEXT, updated_by TEXT, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE events (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, program_id INTEGER, milestone_id INTEGER, kind TEXT NOT NULL DEFAULT 'meeting',
      title TEXT NOT NULL, description TEXT, location TEXT, starts_at TEXT NOT NULL, duration_min INTEGER NOT NULL DEFAULT 30, uid TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now')));
    INSERT INTO users (id, email, name, password_hash, industry_slugs) VALUES (1, 'a@vanderbilt.edu', 'A', 'x', '["tech","consulting"]');
    INSERT INTO industries (id, slug, name) VALUES (1, 'tech', 'Tech'), (2, 'consulting', 'Consulting');
    INSERT INTO programs (id, name, firm, industry_id) VALUES (1, 'Old Program', 'Old Firm', 2);
    INSERT INTO firms (name, domain, pattern, notes) VALUES ('Officer Edited Firm', 'edited.com', 'flast', 'kept');
    INSERT INTO events (user_id, program_id, title, starts_at, uid) VALUES (1, 1, 'My reminder', '2027-01-01T15:00:00Z', 'u1');
  `);
  old.close();

  const up = openDb(file);
  const r = syncContent(up, { backupDir: dir });
  assert.equal(r.upgraded.to, CONTENT_VERSION);
  assert.ok(fs.existsSync(r.upgraded.backup));
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('backup-programs-v1-')));
  assert.equal(up.prepare('SELECT COUNT(*) AS n FROM programs').get().n, 84);
  assert.equal(up.prepare('SELECT COUNT(*) AS n FROM firms').get().n, 151); // 150 seed + the officer's own firm
  assert.equal(up.prepare("SELECT notes FROM firms WHERE name = 'Officer Edited Firm'").get().notes, 'kept');
  assert.deepEqual(JSON.parse(up.prepare('SELECT industry_slugs FROM users').get().industry_slugs), ['swe', 'pm', 'sales-trading', 'consulting']);
  const ev = up.prepare('SELECT title, program_id FROM events').get();
  assert.equal(ev.title, 'My reminder');
  assert.equal(ev.program_id, null);
  assert.deepEqual(syncContent(up, { backupDir: dir }), {}); // second start does nothing
  up.close();
  fs.rmSync(dir, { recursive: true });
});

test('internships: seed is idempotent and keeps officer edits', async () => {
  const n = () => db.prepare('SELECT COUNT(*) AS n FROM internships').get().n;
  assert.equal(n(), 165);
  assert.deepEqual(seedInternships(db), { unchanged: true }); // same file -> nothing to do
  const again = seedInternships(db, { force: true });
  assert.equal(again.created, 0);
  assert.equal(again.updated, 165);
  assert.equal(n(), 165);

  // An officer edits one row and deletes another; a changed seed file keeps both decisions.
  const row = (await api('GET', '/api/admin/internships', null, 'officer')).body.results.find((x) => x.company === 'Lazard');
  await api('PUT', `/api/admin/internships/${row.id}`, { ...row, notes: 'Officer note', as_of: '2026-11-22' }, 'officer');
  await api('DELETE', '/api/admin/internships/23', null, 'officer');
  const seedFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bbsa-seed-')), 'internships.json');
  const seed = require('../server/content/internships.json').map((x) => (x.id === 1 ? { ...x, notes: 'Changed in the seed' } : x));
  fs.writeFileSync(seedFile, JSON.stringify(seed));
  const r = seedInternships(db, { file: seedFile });
  assert.deepEqual(r.skipped.map((x) => x.id).sort((a, b) => a - b), [row.id, 23].sort((a, b) => a - b));
  assert.equal(db.prepare('SELECT notes FROM internships WHERE id = ?').get(row.id).notes, 'Officer note');
  assert.equal(db.prepare('SELECT notes FROM internships WHERE id = 1').get().notes, 'Changed in the seed');
  assert.equal(db.prepare('SELECT 1 FROM internships WHERE id = 23').get(), undefined);
  // --force restores everything from the file.
  seedInternships(db, { file: seedFile, force: true });
  assert.equal(n(), 165);
  assert.notEqual(db.prepare('SELECT notes FROM internships WHERE id = ?').get(row.id).notes, 'Officer note');
});

test('internships page: default order, computed status, filters, labels and email formats', async () => {
  const r = (await api('GET', '/api/internships?asOf=2026-11-22', null, 'student')).body;
  assert.equal(r.total, 165);
  const list = r.results;
  // Future deadline dates first, soonest first.
  assert.deepEqual(list.slice(0, 3).map((x) => [x.company, x.deadlineDate]), [
    ['Perella Weinberg Partners', '2026-12-01'], ['Moelis & Company', '2026-12-14'], ['Houlihan Lokey', '2026-12-18'],
  ]);
  assert.equal(list[0].daysLeft, 9);
  const groups = list.map((x) => x.statusGroup);
  assert.deepEqual(groups, [...groups].sort((a, b) => a - b));
  assert.equal(list.at(-1).statusGroup, 5);
  // Status follows the calendar: Lazard closes once Jan 15 passes.
  const feb = (await api('GET', '/api/internships?asOf=2027-02-01&q=lazard', null, 'student')).body.results[0];
  assert.equal(feb.status, 'Closed');
  assert.equal(feb.storedStatus, 'Open');
  // Labels and email format.
  const gs = list.find((x) => x.company === 'Goldman Sachs');
  assert.equal(gs.linkLabel, 'Careers page');
  assert.equal(gs.emailFormat.format, 'first.last@gs.com');
  assert.equal(list.find((x) => x.company === 'Lazard').linkLabel, 'Apply');
  assert.equal(list.find((x) => x.company === 'Barclays').linkLabel, 'Tracker guide');
  const ducera = list.find((x) => x.company === 'Ducera Partners');
  assert.equal(ducera.linkLabel, null);
  assert.equal(list.find((x) => x.company === 'Roblox').emailFormat, null);
  assert.ok(list.every((x) => x.asOf && x.source));
  // Filters.
  const f = (await api('GET', `/api/internships?industry=Consulting&category=${encodeURIComponent('Strategy (MBB)')}`, null, 'student')).body;
  assert.deepEqual(f.results.map((x) => x.company).sort(), ['Bain & Company', 'Boston Consulting Group (BCG)', 'McKinsey & Company']);
  assert.ok(f.facets.categories.every((c) => !['Bulge Bracket', 'Big Tech'].includes(c)));
  const soph = (await api('GET', `/api/internships?for=${encodeURIComponent('Sophomores (Class of 2029)')}`, null, 'student')).body;
  assert.equal(soph.results.length, 47);
  assert.deepEqual((await api('GET', '/api/internships?q=houlihan', null, 'student')).body.results.map((x) => x.company), ['Houlihan Lokey', 'Houlihan Lokey']);
});

test('internships: My list is private and starred deadlines reach the calendar', async () => {
  await signUpAndLogin('other', 'other@vanderbilt.edu', { gradYear: 2028 });
  const lazard = (await api('GET', '/api/internships?q=lazard', null, 'student')).body.results[0];
  const goldman = (await api('GET', '/api/internships?q=goldman', null, 'student')).body.results[0];
  await api('PUT', `/api/internships/${lazard.id}/star`, { starred: true }, 'student');
  await api('PUT', `/api/internships/${goldman.id}/star`, { starred: true }, 'student'); // no deadline date
  const mine = (await api('GET', '/api/internships?starred=1', null, 'student')).body.results;
  assert.deepEqual(mine.map((x) => x.company).sort(), ['Goldman Sachs', 'Lazard']);
  assert.equal((await api('GET', '/api/internships?starred=1', null, 'other')).body.results.length, 0);
  // Nothing in the admin view reveals who starred what.
  const adminRow = (await api('GET', '/api/admin/internships', null, 'officer')).body.results.find((x) => x.id === lazard.id);
  assert.doesNotMatch(JSON.stringify(adminRow), /star/i);

  // Calendar list, feed and .ics include the dated one as an all-day deadline.
  const events = (await api('GET', '/api/events', null, 'student')).body;
  const ev = events.find((e) => e.internshipId === lazard.id);
  assert.equal(ev.allDay, true);
  assert.equal(ev.date, '2027-01-15');
  assert.match(ev.links.outlook, /allday=true/);
  assert.ok(!events.some((e) => e.internshipId === goldman.id));
  const me = (await api('GET', '/api/me', null, 'student')).body;
  const feed = await api('GET', me.calendarFeed);
  assert.match(feed.body, /SUMMARY:Deadline: Lazard/);
  assert.match(feed.body, /DTSTART;VALUE=DATE:20270115/);
  assert.match((await api('GET', `/api/internships/${lazard.id}.ics`, null, 'student')).body, /DTEND;VALUE=DATE:20270116/);
  // An officer moving the deadline moves it on everyone's calendar.
  const row = (await api('GET', '/api/admin/internships', null, 'officer')).body.results.find((x) => x.id === lazard.id);
  await api('PUT', `/api/admin/internships/${row.id}`, { ...row, deadline_date: '2027-01-20' }, 'officer');
  assert.match((await api('GET', me.calendarFeed)).body, /DTSTART;VALUE=DATE:20270120/);
  // This month shows starred internships due in the next 45 days.
  const tm = (await api('GET', '/api/this-month?asOf=2026-12-15', null, 'student')).body;
  assert.deepEqual(tm.starredInternships.map((x) => x.id), [lazard.id]);
  await api('PUT', `/api/internships/${lazard.id}/star`, { starred: false }, 'student');
  assert.doesNotMatch((await api('GET', me.calendarFeed)).body, /Lazard/);
});

test('internships admin: needs attention, CSV export and import', async () => {
  assert.equal((await api('GET', '/api/admin/internships', null, 'student')).status, 403);
  const all = (await api('GET', '/api/admin/internships', null, 'officer')).body;
  assert.equal(all.staleDays, 30);
  assert.ok(all.counts.no_link > 0 && all.counts.status > 0 && all.counts.any <= all.total);
  const noLink = (await api('GET', '/api/admin/internships?attention=no_link', null, 'officer')).body.results;
  assert.equal(noLink.length, all.counts.no_link);
  assert.ok(noLink.every((x) => !x.link));

  const csv = (await api('GET', '/api/admin/internships.csv', null, 'officer')).body;
  const lines = csv.trim().split(/\r\n/);
  assert.equal(lines[0], 'id,company,industry,category,program,for_students,internship_summer,status,opens,deadline,deadline_date,link,link_type,next_cycle,notes,source,as_of');
  // Edit the export like a spreadsheet: change one row, add a new one, include a bad row.
  const header = lines[0];
  const edited = lines.find((l) => l.startsWith('22,')).replace(',Not tracked,', ',Open,').replace(/,,None found[^,]*,/, ',https://www.liontree.com/careers,Careers page,');
  const body = [header, edited, ',New Firm,Tech,Startup,SWE Intern,Juniors (Class of 2028),2027,Open,,,,https://example.com/jobs,Posting,,,Officer,2026-11-22', ',Bad Row,Space,,X'].join('\n');
  const fd = new FormData();
  fd.append('file', new Blob([body], { type: 'text/csv' }), 'internships.csv');
  const imp = await fetch(`${base}/api/admin/internships/import`, { method: 'POST', headers: { authorization: `Bearer ${tokens.officer}` }, body: fd }).then((x) => x.json());
  assert.equal(imp.updated, 1);
  assert.equal(imp.created, 1);
  assert.equal(imp.errors.length, 1);
  const lt = db.prepare('SELECT * FROM internships WHERE id = 22').get();
  assert.equal(lt.status, 'Open');
  assert.equal(lt.link, 'https://www.liontree.com/careers');
  assert.equal(lt.updated_by, 'officer@vanderbilt.edu');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM internships').get().n, 166);
  const bad = await api('POST', '/api/admin/internships', { company: 'X', industry: 'Finance', program: 'Y', link: 'ftp://nope' }, 'officer');
  assert.equal(bad.status, 400);
});
