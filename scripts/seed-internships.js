'use strict';
// Usage: npm run seed:internships            (load server/content/internships.json, keeping officer edits)
//        npm run seed:internships -- --force (overwrite officer edits and restore deleted rows)
const path = require('node:path');
const { openDb } = require('../server/db');
const { seedInternships } = require('../server/content/internships');

const force = process.argv.includes('--force');
const db = openDb(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'bbsa.db'));
const r = seedInternships(db, { force });
if (r.unchanged) console.log('The seed file has not changed since it was last loaded. Use --force to reload it anyway.');
else {
  console.log(`${r.created} added, ${r.updated} updated.`);
  for (const s of r.skipped) console.log(`Skipped #${s.id} ${s.company} (${s.reason})`);
}
