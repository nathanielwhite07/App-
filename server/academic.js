'use strict';
// The academic year runs August to July. A student's class year is derived from their
// graduation year, so it advances on its own every August.

const YEAR_NAMES = { 1: 'Freshman', 2: 'Sophomore', 3: 'Junior', 4: 'Senior' };
const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Calendar year in which the current academic year started (Aug 2026–Jul 2027 -> 2026). */
const academicYearStart = (d = new Date()) => (d.getMonth() + 1 >= 8 ? d.getFullYear() : d.getFullYear() - 1);

/** 1–4 for a current student, 0 before freshman year, 5 after graduating, null if unknown. */
function classYear(gradYear, d = new Date()) {
  if (!gradYear) return null;
  const y = 4 - (Number(gradYear) - (academicYearStart(d) + 1));
  return Math.max(0, Math.min(5, y));
}

/** Is calendar month m (1–12) inside a window that may wrap past December (e.g. Dec–Feb)? */
const inWindow = (m, start, end) => (start <= end ? m >= start && m <= end : m >= start || m <= end);

/** Position of a month within the academic year (Aug = 0 ... Jul = 11), for sorting. */
const academicIndex = (m) => (m + 4) % 12;

/** "Dec–Feb", "Apr", or "All year". */
function windowLabel(start, end) {
  if ((end % 12) + 1 === start) return 'All year';
  return start === end ? MONTHS[start] : `${MONTHS[start]}–${MONTHS[end]}`;
}

module.exports = { YEAR_NAMES, MONTHS, academicYearStart, classYear, inWindow, academicIndex, windowLabel };
