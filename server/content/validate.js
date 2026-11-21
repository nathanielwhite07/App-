'use strict';
// Normalise admin form input into the shapes store.js inserts. Throws { status: 400 } on bad input.

const { PATTERNS, parseFormat } = require('../email/patterns');

const CATEGORIES = ['explore', 'prepare', 'network', 'apply', 'interview'];
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const str = (v, max = 2000) => {
  const s = v == null ? '' : String(v).trim();
  if (s.length > max) throw bad(`Text is too long (max ${max} characters).`);
  return s || null;
};
const req = (v, label, max) => str(v, max) ?? (() => { throw bad(`${label} is required.`); })();
const years = (v) => {
  const arr = (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => Number(String(x).trim())).filter((x) => x);
  if (arr.some((y) => !Number.isInteger(y) || y < 1 || y > 4)) throw bad('Class years must be 1–4.');
  return [...new Set(arr)].sort();
};
const month = (v, label) => {
  const m = Number(v);
  if (!Number.isInteger(m) || m < 1 || m > 12) throw bad(`${label} must be a month from 1 to 12.`);
  return m;
};
const date = (v, label) => {
  const s = str(v, 10);
  if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(`${label} must be a date (YYYY-MM-DD).`);
  return s;
};
const url = (v) => {
  const s = str(v, 500);
  if (s && !/^https?:\/\//i.test(s)) throw bad('Links must start with http:// or https://');
  return s;
};

function industry(b) {
  const slug = req(b.slug, 'Slug', 60).toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) throw bad('Slug may only use lowercase letters, numbers and hyphens.');
  let guide = b.guide ?? [];
  if (typeof guide === 'string') {
    try { guide = JSON.parse(guide || '[]'); } catch { throw bad('Guide must be valid JSON.'); }
  }
  if (!Array.isArray(guide) || guide.some((s) => !s || typeof s.heading !== 'string' || !Array.isArray(s.items))) {
    throw bad('Guide must be a list of { "heading": "...", "items": ["..."] } sections.');
  }
  return { slug, name: req(b.name, 'Name', 100), summary: str(b.summary), guide, sort_order: Number(b.sort_order) || 0, active: b.active !== false && b.active !== 'false' };
}

function milestone(b) {
  const category = str(b.category, 20) || 'prepare';
  if (!CATEGORIES.includes(category)) throw bad(`Category must be one of ${CATEGORIES.join(', ')}.`);
  const priority = Number(b.priority ?? 2);
  if (![1, 2, 3].includes(priority)) throw bad('Priority must be 1 (high), 2 or 3.');
  const months = b.months ?? [b.start_month, b.end_month];
  return {
    industry: req(b.industry, 'Industry', 60), track: str(b.track, 60), class_years: years(b.class_years),
    months: [month(months[0], 'Start month'), month(months[1], 'End month')], title: req(b.title, 'Title', 200),
    details: str(b.details), category, link: url(b.link), priority, sort_order: Number(b.sort_order) || 0, source: str(b.source, 200),
  };
}

function program(b) {
  const p = {
    name: req(b.name, 'Program name', 200), firm: req(b.firm, 'Firm', 200), industry: req(b.industry, 'Industry', 60),
    eligible_years: years(b.eligible_years), cycle: str(b.cycle, 20), opens_on: date(b.opens_on, 'Opens on'),
    deadline: date(b.deadline, 'Deadline'), rolling: b.rolling === true || b.rolling === 'true', link: url(b.link),
    description: str(b.description), needs_review: b.needs_review === true || b.needs_review === 'true',
    active: b.active !== false && b.active !== 'false',
  };
  if (p.opens_on && p.deadline && p.opens_on > p.deadline) throw bad('"Opens on" is after the deadline.');
  return p;
}

function firm(b) {
  const parsed = b.format ? parseFormat(b.format) : { pattern: str(b.pattern, 30), domain: str(b.domain, 200)?.toLowerCase() };
  if (!parsed || !PATTERNS[parsed.pattern] || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(parsed.domain || '')) {
    throw bad(`Format must look like first.last@firm.com, using one of: ${Object.keys(PATTERNS).join(', ')}.`);
  }
  let fallbacks = b.fallbacks ?? [];
  if (typeof fallbacks === 'string') {
    fallbacks = fallbacks.split(/[\s,]+/).filter(Boolean).map((f) => parseFormat(f) || (() => { throw bad(`Couldn't read fallback "${f}".`); })());
  }
  return {
    name: req(b.name, 'Firm name', 200), sector: str(b.sector, 60), category: str(b.category, 100), ...parsed, confidence: str(b.confidence, 30),
    fallbacks, notes: str(b.notes), sources_agree: str(b.sources_agree, 30), researched_on: date(b.researched_on, 'Researched on'),
  };
}

module.exports = { industry, milestone, program, firm, CATEGORIES };
