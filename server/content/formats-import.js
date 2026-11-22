'use strict';
// Reads officers' email-format spreadsheets (.xlsx or .csv) into firm records.
// Expected columns (matched case-insensitively; extra columns are ignored):
//   Firm | Best Email Format | Confidence | Fallback / Notes | Category | Sites Agreeing | Sector (optional)
// Columns naming individual people's published addresses are deliberately never read.

const ExcelJS = require('exceljs');
const { parseCsv } = require('../csv');
const { parseFormat, fallbacksFromNotes } = require('../email/patterns');

const COLUMNS = {
  firm: ['firm', 'firm name', 'company'],
  format: ['best email format', 'email format', 'format'],
  confidence: ['confidence'],
  notes: ['fallback / notes', 'fallback/notes', 'notes', 'fallback'],
  category: ['category', 'type'],
  sector: ['sector', 'industry'],
  sources: ['sites agreeing', 'sources agreeing'],
};

const cellText = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.text) return cellText(v.text);
    if (v.result != null) return String(v.result);
    if (v.formula) return '';
  }
  return String(v);
};

/**
 * Turn a grid of rows into firm records.
 * @param rows  array of arrays of strings, header row somewhere near the top
 * @param defaults  { sector, researched_on } applied when the sheet doesn't say
 * @returns { firms, errors }
 */
function rowsToFirms(rows, defaults = {}) {
  const headerIdx = rows.findIndex((r) => r.some((c) => /^firm( name)?$/i.test(c.trim())) && r.some((c) => /format/i.test(c)));
  if (headerIdx === -1) return { firms: [], errors: ['Could not find a header row with "Firm" and "Best Email Format" columns.'] };
  const header = rows[headerIdx].map((h) => h.trim().toLowerCase());
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, header.findIndex((h) => names.includes(h))]));
  const firms = [], errors = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (k) => (col[k] === -1 ? '' : (r[col[k]] || '').trim());
    const name = get('firm');
    if (!name) continue;
    const parsed = parseFormat(get('format'));
    if (!parsed) {
      errors.push(`Row ${i + 1} (${name}): couldn't read the format "${get('format')}". Use something like first.last@firm.com.`);
      continue;
    }
    const notes = get('notes').replace(/^—$/, '');
    firms.push({
      name,
      sector: get('sector') || defaults.sector || null,
      category: get('category') || null,
      domain: parsed.domain,
      pattern: parsed.pattern,
      confidence: get('confidence') || null,
      max_local: parsed.maxLocal || null,
      fallbacks: fallbacksFromNotes(notes, parsed.domain).filter((f) => !(f.pattern === parsed.pattern && f.domain === parsed.domain)),
      notes: notes || null,
      sources_agree: get('sources') || null,
      researched_on: defaults.researched_on || null,
    });
  }
  return { firms, errors };
}

/** Guess the sector from a file name like "Top_50_Consulting_Firms_...xlsx". */
const sectorFromFilename = (name = '') => (/consult/i.test(name) ? 'Consulting' : /financ|bank|\bib\b/i.test(name) ? 'Finance' : /tech/i.test(name) ? 'Tech' : null);

async function readFormatsFile(buffer, filename = '', { sector } = {}) {
  const defaults = { sector: sector || sectorFromFilename(filename) };
  if (/\.csv$/i.test(filename)) return rowsToFirms(parseCsv(buffer.toString('utf8')), defaults);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const grid = (ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => rows.push(row.values.slice(1).map(cellText)));
    return rows;
  };
  // A "Researched" date on any sheet (e.g. the "Key & Method" tab) applies to every firm.
  for (const ws of wb.worksheets) {
    const hit = grid(ws).find((r) => /^researched$/i.test((r[0] || '').trim()));
    if (hit?.[1]) {
      const d = new Date(hit[1]);
      defaults.researched_on = Number.isNaN(d.getTime()) ? hit[1] : d.toISOString().slice(0, 10);
    }
  }
  const all = { firms: [], errors: [] };
  for (const ws of wb.worksheets) {
    const out = rowsToFirms(grid(ws), defaults);
    if (out.firms.length) { all.firms.push(...out.firms); all.errors.push(...out.errors); }
  }
  if (!all.firms.length) all.errors.push('No sheet had "Firm" and "Best Email Format" columns.');
  return all;
}

module.exports = { readFormatsFile, rowsToFirms, sectorFromFilename, cellText };
