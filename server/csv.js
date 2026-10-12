'use strict';

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). Returns array of row arrays. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const s = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// Header aliases so exports from CRMs / spreadsheets import without renaming columns.
const ALIASES = {
  first_name: ['first_name', 'first name', 'firstname', 'given name'],
  last_name: ['last_name', 'last name', 'lastname', 'surname', 'family name'],
  full_name: ['name', 'full name', 'full_name'],
  email: ['email', 'email address', 'work email', 'e-mail'],
  title: ['title', 'job title', 'position', 'role'],
  department: ['department', 'team', 'group', 'division'],
  company: ['company', 'company name', 'firm', 'organization', 'employer'],
  domain: ['domain', 'company domain', 'website'],
  industry: ['industry', 'sector'],
  location: ['location', 'city', 'office'],
  school: ['school', 'university', 'college', 'alma mater', 'education'],
  interests: ['interests', 'hobbies', 'tags'],
  bio: ['bio', 'summary', 'about', 'notes'],
  linkedin: ['linkedin', 'linkedin url', 'linkedin_url', 'profile url'],
};

/** Map CSV rows to contact objects. Returns { contacts, errors }. */
function csvToContacts(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return { contacts: [], errors: ['File is empty.'] };
  const idx = {};
  header.forEach((h, i) => {
    const key = Object.keys(ALIASES).find((k) => ALIASES[k].includes(h.trim().toLowerCase()));
    if (key && idx[key] === undefined) idx[key] = i;
  });
  const contacts = [], errors = [];
  rows.forEach((r, n) => {
    const get = (k) => (idx[k] === undefined ? '' : (r[idx[k]] || '').trim());
    let first = get('first_name'), last = get('last_name');
    if ((!first || !last) && get('full_name')) {
      const parts = get('full_name').split(/\s+/);
      first = first || parts[0];
      last = last || parts.slice(1).join(' ');
    }
    const email = get('email').toLowerCase();
    let domain = get('domain').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (!domain && email.includes('@')) domain = email.split('@')[1];
    const company = get('company') || (domain ? domain.split('.')[0] : '');
    if (!first || !last || !company) {
      errors.push(`Row ${n + 2}: needs first/last name and a company (or email to infer it).`);
      return;
    }
    contacts.push({
      first_name: first, last_name: last, email: email || null, title: get('title'), department: get('department'),
      company, domain, industry: get('industry') || null, location: get('location'), school: get('school'),
      interests: get('interests').replace(/;/g, ','), bio: get('bio'), linkedin: get('linkedin'),
    });
  });
  return { contacts, errors };
}

module.exports = { parseCsv, csvToContacts };
