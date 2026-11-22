'use strict';
// Reads the officers' programs spreadsheet (.xlsx or .csv) into program records.
// Expected columns (matched case-insensitively; extra columns such as "Days left" are ignored):
//   Industry | Firm | Program | Affinity focus / who it's for | Eligible year | Format / location |
//   Deadline / timing | Deadline date | Status | Link | Notes

const ExcelJS = require('exceljs');
const { parseCsv } = require('../csv');
const { cellText } = require('./formats-import');

const ALL = ['investment-banking', 'consulting', 'swe', 'pm', 'sales-trading'];

const COLUMNS = {
  industry: ['industry'],
  firm: ['firm', 'organization'],
  name: ['program', 'program name'],
  affinity: ['affinity focus / who it\'s for', 'affinity focus', 'who it\'s for'],
  eligibility: ['eligible year', 'eligible years', 'eligibility'],
  format: ['format / location', 'format'],
  timing: ['deadline / timing', 'timing'],
  deadline: ['deadline date', 'deadline'],
  status: ['status'],
  link: ['link', 'url'],
  notes: ['notes'],
};

/** Map the sheet's Industry label (plus program text) to industry slugs and a kind. */
function classify(label, text) {
  const l = label.toLowerCase(), t = text.toLowerCase();
  const kind = l.includes('pipeline') ? 'pipeline' : 'firm';
  let slugs;
  if (l.includes('multi')) slugs = [...ALL];
  else if (l.includes('banking')) slugs = ['investment-banking'];
  else if (l.includes('consult')) slugs = ['consulting'];
  else if (l.includes('quant') || l.includes('trading') || l.includes('markets')) slugs = ['sales-trading', ...(/technolog/.test(t) ? ['swe'] : [])];
  else if (l.includes('finance')) slugs = ['investment-banking', 'sales-trading'];
  else if (l.includes('tech')) {
    slugs = /product|\bapm\b|design/.test(t) ? ['pm'] : ['swe'];
    if (/trading/.test(t)) slugs.push('sales-trading');
  } else {
    const direct = ALL.find((s) => s === l || s.replace('-', ' ') === l);
    slugs = direct ? [direct] : [];
  }
  return { kind, industries: slugs };
}

const STATUS = [
  [/not running|ended|canceled|cancelled/, 'not_running'],
  [/unconfirmed|verify/, 'unconfirmed'],
  [/closed/, 'closed'],
  [/check now/, 'check_now'],
  [/not posted|watch/, 'watch'],
  [/upcoming|opening soon/, 'upcoming'],
  [/open/, 'open'],
];
const mapStatus = (s) => (STATUS.find(([re]) => re.test(s.toLowerCase())) || [null, 'upcoming'])[1];

/** "Freshman & sophomore (3.2 GPA)" -> [1, 2]; [] means every year. */
function parseYears(text, cycleStart) {
  const t = text.toLowerCase();
  if (!t.trim() || /all (undergrad )?years|all undergrad|^undergraduate|undergrad &/.test(t)) return [];
  const found = new Set();
  if (/freshm|first-year|\b1st\b/.test(t)) found.add(1);
  if (/sophomore|second-year|\b2nd\b|two years from graduation/.test(t)) found.add(2);
  if (/junior|\b3rd\b/.test(t)) found.add(3);
  if (/senior(?!s)/.test(t) && !/hs senior/.test(t)) found.add(4);
  if (!found.size) {
    // "Grads fall 2028 – summer 2030": convert graduation years to class years for this cycle.
    for (const [, y] of t.matchAll(/\b(20\d\d)\b/g)) {
      const cy = 4 - (Number(y) - (cycleStart + 1));
      if (cy >= 1 && cy <= 4) found.add(cy);
    }
  }
  const ys = [...found].sort();
  // "Freshman – junior", "1st–3rd year": fill in the range.
  if (ys.length === 2 && /[–-]/.test(t) && ys[1] - ys[0] > 1) for (let y = ys[0] + 1; y < ys[1]; y++) ys.push(y);
  return [...new Set(ys)].sort();
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// "Summer 2027" usually names the internship term, not the application window, so it isn't used.
const SEASONS = { early: 1, winter: 1, spring: 3, fall: 9, late: 10 };

/**
 * Estimate when applications are expected from free text such as "Expected ~Feb 2027" or
 * "Priority deadlines historically Nov 1 and Mar 1": the earliest date mentioned that is
 * not already past (a bare month counts until its last day). Returns "YYYY-MM" or null.
 */
function expectedMonth(text, now = new Date()) {
  const t = String(text || '');
  if (/\bno\b[^;.]*\bposting\b|not posted/i.test(t) && !/expect/i.test(t)) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const candidates = [];
  const add = (year, month, day) => {
    const when = day ? new Date(year, month - 1, day) : new Date(year, month, 0);
    if (when >= today) candidates.push(when);
  };
  const re = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(\d{1,2})(?!\d))?/gi;
  for (const m of t.matchAll(re)) {
    const month = MONTHS[m[1].toLowerCase()];
    const day = m[2] ? Number(m[2]) : null;
    // the year that follows this month, if any, before the next month name
    const rest = t.slice(m.index + m[0].length);
    const ym = /^[^a-z]*?(?:(?:early|mid|late)[- ]?)?(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{0,2}\s*)?,?\s*(20\d\d)\b/i.exec(rest);
    let year = ym ? Number(ym[1]) : null;
    if (year) add(year, month, day);
    else {
      year = now.getFullYear();
      if ((day ? new Date(year, month - 1, day) : new Date(year, month, 0)) < today) year++;
      add(year, month, day);
    }
  }
  for (const m of t.matchAll(/\b(early|winter|spring|fall|late)\s+(20\d\d)\b/gi)) add(Number(m[2]), SEASONS[m[1].toLowerCase()], null);
  if (!candidates.length) return null;
  const d = candidates.sort((a, b) => a - b)[0];
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const toYmd = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/**
 * @param rows  array of arrays (cell values), header row somewhere near the top
 * @param opts  { cycle: '2026-27', now: Date }
 */
function rowsToPrograms(rows, { cycle = null, now = new Date() } = {}) {
  const headerIdx = rows.findIndex((r) => r.some((c) => /^program$/i.test(cellText(c).trim())) && r.some((c) => /^firm$/i.test(cellText(c).trim())));
  if (headerIdx === -1) return { programs: [], errors: ['Could not find a header row with "Firm" and "Program" columns.'] };
  // "Status (as of Nov 21, 2026)" -> "status"
  const header = rows[headerIdx].map((h) => cellText(h).trim().toLowerCase().replace(/\s*\(.*\)\s*$/, ''));
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, header.findIndex((h) => names.includes(h))]));
  const cycleStart = Number((cycle || '').slice(0, 4)) || (now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1);
  const programs = [], errors = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const raw = (k) => (col[k] === -1 ? null : r[col[k]]);
    const get = (k) => cellText(raw(k)).trim();
    const name = get('name'), firm = get('firm');
    if (!name && !firm) continue;
    if (!name || !firm) { errors.push(`Row ${i + 1}: needs both a firm and a program name.`); continue; }
    const { kind, industries } = classify(get('industry'), `${name} ${get('affinity')}`);
    if (!industries.length) { errors.push(`Row ${i + 1} (${name}): unknown industry "${get('industry')}".`); continue; }
    let link = get('link'), notes = get('notes');
    if (link && !/^https?:\/\//i.test(link)) { notes = [link, notes].filter(Boolean).join(' '); link = null; }
    const timing = get('timing');
    const status = mapStatus(get('status'));
    const deadline = toYmd(raw('deadline') instanceof Date ? raw('deadline') : get('deadline'));
    const future = deadline && deadline >= now.toISOString().slice(0, 10);
    programs.push({
      name, firm, kind, industries, eligible_years: parseYears(get('eligibility'), cycleStart), eligibility: get('eligibility') || null,
      affinity: get('affinity') || null, format: get('format') && get('format') !== '—' ? get('format') : null,
      timing: timing && timing !== '—' ? timing : null, status, cycle, deadline,
      expected_month: !future && ['upcoming', 'watch', 'check_now', 'unconfirmed'].includes(status) ? expectedMonth(timing, now) : null,
      rolling: /rolling/i.test(timing), link: link || null, description: notes || null,
    });
  }
  return { programs, errors };
}

async function readProgramsFile(buffer, filename = '', opts = {}) {
  if (/\.csv$/i.test(filename)) return rowsToPrograms(parseCsv(buffer.toString('utf8')), opts);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  for (const ws of wb.worksheets) {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => rows.push(row.values.slice(1)));
    const out = rowsToPrograms(rows, opts);
    if (out.programs.length) return out;
  }
  return { programs: [], errors: ['No sheet had "Firm" and "Program" columns.'] };
}

module.exports = { readProgramsFile, rowsToPrograms, parseYears, expectedMonth, classify };
