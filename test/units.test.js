'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { verifyEmail } = require('../server/email/verifier');
const { demoResolver } = require('../server/email/verifier/resolvers');
const { detectPattern, parseFormat, fallbacksFromNotes, buildAddress } = require('../server/email/patterns');
const { classYear, academicYearStart, inWindow, windowLabel } = require('../server/academic');
const { rowsToFirms } = require('../server/content/formats-import');
const validate = require('../server/content/validate');
const { parseCsv } = require('../server/csv');
const { toIcs, addBusinessDays } = require('../server/calendar');
const { emailAllowed } = require('../server/auth');

const resolver = demoResolver(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'demo-dns.json'), 'utf8')));
const v = (email, opts = {}) => verifyEmail(email, { resolver, smtp: true, ...opts });

test('academic calendar: class year rolls over in August', () => {
  assert.equal(academicYearStart(new Date(2026, 7, 1)), 2026);
  assert.equal(academicYearStart(new Date(2027, 6, 31)), 2026);
  assert.equal(classYear(2029, new Date(2026, 10, 21)), 2); // Class of 2029: sophomore in Nov 2026
  assert.equal(classYear(2029, new Date(2027, 6, 1)), 2);   // still a sophomore in July (rising junior)
  assert.equal(classYear(2029, new Date(2027, 7, 1)), 3);
  assert.equal(classYear(2031, new Date(2026, 10, 1)), 0);
  assert.equal(classYear(2026, new Date(2026, 10, 1)), 5);
  assert.equal(classYear(null), null);
});

test('academic calendar: month windows wrap past December', () => {
  assert.ok(inWindow(1, 12, 2) && inWindow(12, 12, 2) && !inWindow(3, 12, 2));
  assert.ok(inWindow(4, 4, 4) && !inWindow(5, 4, 4));
  assert.ok([1, 6, 8, 12].every((m) => inWindow(m, 8, 7)));
  assert.equal(windowLabel(8, 7), 'All year');
  assert.equal(windowLabel(12, 2), 'Dec–Feb');
  assert.equal(windowLabel(4, 4), 'Apr');
});

test('auth: only exact allowed domains', () => {
  assert.ok(emailAllowed('jane.doe@vanderbilt.edu'));
  assert.ok(emailAllowed('Jane.Doe@VANDERBILT.EDU'));
  assert.ok(!emailAllowed('jane@gmail.com'));
  assert.ok(!emailAllowed('jane@vanderbilt.edu.evil.com'));
  assert.ok(!emailAllowed('jane@sub.vanderbilt.edu'));
});

test('patterns: parse formats, fallbacks and build addresses', () => {
  assert.deepEqual(parseFormat('first_last@mckinsey.com'), { pattern: 'first_last', domain: 'mckinsey.com' });
  assert.deepEqual(parseFormat('lastf@stifel.com'), { pattern: 'lastf', domain: 'stifel.com' });
  assert.equal(parseFormat('whatever@x.com'), null);
  assert.deepEqual(fallbacksFromNotes('Fallbacks: djane@deshaw.com (LeadIQ 39%), then jane-doe@deshaw.com'), [
    { pattern: 'lfirst', domain: 'deshaw.com' }, { pattern: 'first-last', domain: 'deshaw.com' },
  ]);
  assert.equal(buildAddress("D'Andre", 'Smith-Jones', { pattern: 'first.last', domain: 'gs.com' }), 'dandre.smithjones@gs.com');
  assert.equal(buildAddress('Jane', 'Doe', { pattern: 'last_first', domain: 'bah.com' }), 'doe_jane@bah.com');
  assert.equal(detectPattern('doej@stifel.com', 'Jane', 'Doe'), 'lastf');
});

test('formats import: header detection, notes and bad rows', () => {
  const rows = [
    ['Top firms'],
    ['Rank', 'Firm', 'Confidence', 'Best Email Format', 'Fallback / Notes', 'Category', "Firm's Own Published Address"],
    ['1', 'Alpha', 'Confirmed', 'flast@alpha.com', 'Fallback: jane.doe@alpha.com (RocketReach 20%)', 'Strategy', 'real.person@alpha.com'],
    ['2', 'Beta', 'High', 'first.last@beta.com', '—', '', ''],
    ['3', 'Gamma', 'High', 'not a format', '', '', ''],
  ];
  const { firms, errors } = rowsToFirms(rows, { sector: 'Consulting', researched_on: '2026-10-10' });
  assert.equal(firms.length, 2);
  assert.equal(errors.length, 1);
  assert.deepEqual(firms[0].fallbacks, [{ pattern: 'first.last', domain: 'alpha.com' }]);
  assert.equal(firms[1].notes, null);
  assert.ok(!JSON.stringify(firms).includes('real.person'));
});

test('validate: milestones and programs', () => {
  const m = validate.milestone({ industry: 'tech', class_years: '2, 1', start_month: '12', end_month: '2', title: ' Network ' });
  assert.deepEqual(m.class_years, [1, 2]);
  assert.deepEqual(m.months, [12, 2]);
  assert.equal(m.title, 'Network');
  assert.throws(() => validate.milestone({ industry: 'tech', start_month: 1, end_month: 2, title: 'x', class_years: [5] }), /1–4/);
  assert.throws(() => validate.program({ name: 'x', firm: 'y', industry: 'z', opens_on: '2027-03-01', deadline: '2027-02-01' }), /after the deadline/);
  assert.throws(() => validate.program({ name: 'x', firm: 'y', industry: 'z', deadline: '03/01/2027' }), /YYYY-MM-DD/);
});

test('verifier (kept for Phase 2): confirmed, rejected, catch-all, disposable', async () => {
  assert.equal((await v('ava.chen@northbridgecapital.example')).status, 'valid');
  assert.equal((await v('ghost.person@northbridgecapital.example')).status, 'invalid');
  assert.equal((await v('anyone@meridianam.example')).status, 'accept_all');
  assert.equal((await v('kid@mailinator.com', { smtp: false })).status, 'invalid');
  assert.equal((await v('bob@gmial.com', { smtp: false })).suggestion, 'bob@gmail.com');
  const noProbe = await verifyEmail('ava.chen@northbridgecapital.example', { resolver });
  assert.equal(noProbe.checks.find((c) => c.id === 'smtp').status, 'skip'); // probing is opt-in
});

test('csv: quoted fields and CRLF', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
});

test('calendar: ics escaping/folding and business days', () => {
  const ics = toIcs([{ uid: 'u1', kind: 'deadline', title: 'Chat; with, Ava', description: 'x'.repeat(200), starts_at: '2030-01-01T10:00:00Z', duration_min: 45 }]);
  assert.match(ics, /SUMMARY:Chat\\; with\\, Ava/);
  assert.match(ics, /DTEND:20300101T104500Z/);
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
  assert.equal(addBusinessDays(new Date('2030-01-04T12:00:00Z'), 1).toISOString().slice(0, 10), '2030-01-07');
});

test('programs import: eligibility, industry mapping and expected month', () => {
  const { parseYears, classify, expectedMonth } = require('../server/content/programs-import');
  assert.deepEqual(parseYears('Freshman & sophomore (3.2 GPA)', 2026), [1, 2]);
  assert.deepEqual(parseYears('Freshman – junior', 2026), [1, 2, 3]);
  assert.deepEqual(parseYears('1st–3rd year', 2026), [1, 2, 3]);
  assert.deepEqual(parseYears('Students two years from graduation', 2026), [2]);
  assert.deepEqual(parseYears('Grads fall 2028 – summer 2030', 2026), [1, 2, 3]);
  assert.deepEqual(parseYears('All undergrad years', 2026), []);
  assert.deepEqual(parseYears('Freshman (and HS seniors)', 2026), [1]);
  assert.deepEqual(classify('Pipeline org (multi-industry)', 'SEO Career').industries.length, 5);
  assert.deepEqual(classify('Tech', 'Thrive (Product Designer track)').industries, ['pm']);
  assert.deepEqual(classify('Tech', 'WiTTI (Women in Trading & Technology Initiative)').industries, ['swe', 'sales-trading']);
  assert.deepEqual(classify('Finance (Quant/Trading)', 'FTTP (First-Year Trading & Technology Program)').industries, ['sales-trading', 'swe']);
  assert.equal(classify('Pipeline org (finance)', 'x').kind, 'pipeline');
  const now = new Date(2026, 10, 22);
  assert.equal(expectedMonth('Applications expected to open Nov 2026', now), '2026-11');
  assert.equal(expectedMonth('Summer 2027 cycle opened Jan 2026; expect ~Jan 2027', now), '2027-01');
  assert.equal(expectedMonth('Priority deadlines historically Nov 1 and Mar 1', now), '2027-03');
  assert.equal(expectedMonth('Applications open late Mar–early Apr 2027', now), '2027-03');
  assert.equal(expectedMonth('No summer 2027 posting as of Oct 8, 2026', now), null);
});

test('internships: status is computed from the deadline date, not trusted', () => {
  const I = require('../server/content/internships');
  const today = '2026-11-22';
  // A past deadline means Closed, whatever was stored.
  assert.equal(I.computeStatus({ status: 'Open', deadline_date: '2026-11-21' }, today).status, 'Closed');
  assert.equal(I.computeStatus({ status: 'Expected', deadline_date: '2026-01-01' }, today).group, 5);
  // Today and future deadlines stay as entered, with a countdown.
  const due = I.computeStatus({ status: 'Open', deadline_date: '2026-12-04' }, today);
  assert.equal(due.status, 'Open');
  assert.equal(due.daysLeft, 12);
  assert.equal(due.tone, 'soon');
  assert.equal(I.computeStatus({ status: 'Open', deadline_date: today }, today).daysLeft, 0);
  assert.equal(I.computeStatus({ status: 'Open', deadline_date: '2027-03-01' }, today).tone, 'open');
  // No date: stored status decides the group.
  assert.equal(I.computeStatus({ status: 'Rolling' }, today).group, 2);
  assert.equal(I.computeStatus({ status: 'Closing soon' }, today).group, 2);
  assert.equal(I.computeStatus({ status: 'Expected' }, today).group, 3);
  assert.equal(I.computeStatus({ status: 'Not tracked' }, today).group, 4);
  assert.equal(I.computeStatus({ status: 'Mostly closed' }, today).group, 5);
  assert.equal(I.computeStatus({ status: 'Likely closed' }, today).status, 'Likely closed');
});

test('internships: default sort order', () => {
  const I = require('../server/content/internships');
  const today = '2026-11-22';
  const rows = [
    { id: 1, company: 'Zeta', status: 'Closed', deadline_date: '' },
    { id: 2, company: 'Alpha', status: 'Expected', deadline_date: '' },
    { id: 3, company: 'Beta', status: 'Open', deadline_date: '2027-01-15' },
    { id: 4, company: 'Gamma', status: 'Not tracked', deadline_date: '' },
    { id: 5, company: 'Delta', status: 'Rolling', deadline_date: '' },
    { id: 6, company: 'Eps', status: 'Open', deadline_date: '2026-12-01' },
    { id: 7, company: 'Aardvark', status: 'Open', deadline_date: '2026-11-01' }, // passed -> closed
    { id: 8, company: 'Kappa', status: 'Open', deadline_date: '' },
    { id: 9, company: 'Mostly', status: 'Mostly closed', deadline_date: '' },
  ];
  assert.deepEqual(I.sortInternships(rows, today).map((r) => r.id), [6, 3, 5, 8, 2, 4, 7, 9, 1]);
});

test('internships: link labels, needs attention, CSV round trip', () => {
  const I = require('../server/content/internships');
  assert.equal(I.linkLabel({ link: 'https://x', link_type: 'Posting' }), 'Apply');
  assert.equal(I.linkLabel({ link: 'https://x', link_type: 'Posting (interest form)' }), 'Apply (interest form)');
  assert.equal(I.linkLabel({ link: 'https://x', link_type: 'Careers page' }), 'Careers page');
  assert.equal(I.linkLabel({ link: 'https://x', link_type: 'Careers board' }), 'Careers page');
  assert.equal(I.linkLabel({ link: 'https://x', link_type: 'Tracker guide (Extern)' }), 'Tracker guide');
  assert.equal(I.linkLabel({ link: '', link_type: 'Posting' }), null);
  const today = '2026-11-22';
  assert.deepEqual(I.attentionReasons({ link: '', status: 'Check site', as_of: '2026-10-09' }, today), ['no_link', 'status', 'stale']);
  assert.deepEqual(I.attentionReasons({ link: 'https://x', status: 'Open', as_of: '2026-10-23' }, today), []); // exactly 30 days is fine
  assert.deepEqual(I.attentionReasons({ link: 'https://x', status: 'Open', as_of: '2026-10-22' }, today), ['stale']);
  const row = { id: 9, company: 'A, "B"', industry: 'finance', program: 'Analyst', notes: 'line1\nline2', deadline_date: '2027-01-15', as_of: today };
  const back = I.fromCsv(I.toCsv([I.normalize(row)]));
  assert.deepEqual(back.errors, []);
  assert.equal(back.rows[0].company, 'A, "B"');
  assert.equal(back.rows[0].industry, 'Finance');
  assert.equal(back.rows[0].notes, 'line1\nline2');
  assert.match(I.fromCsv('company,industry,program,deadline_date\nX,Finance,Y,15/01/2027\n').errors[0], /date like/);
});
