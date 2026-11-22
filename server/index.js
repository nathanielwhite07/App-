'use strict';
const path = require('node:path');
const { openDb } = require('./db');
const { syncContent } = require('./content/store');
const { seedInternships } = require('./content/internships');
const { createApp } = require('./app');

const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'bbsa.db');
const db = openDb(dbFile);
const sync = syncContent(db, { backupDir: path.dirname(dbFile) });
if (sync.seeded) console.log('Loaded starter content:', sync.seeded);
if (sync.upgraded) {
  console.log(`Updated starter content from v${sync.upgraded.from} to v${sync.upgraded.to} (${sync.upgraded.newFirms} new email formats).`);
  console.log(`The previous timelines and programs were saved to ${sync.upgraded.backup}`);
}
const seeded = seedInternships(db);
if (!seeded.unchanged) {
  console.log(`Internships: ${seeded.created} added, ${seeded.updated} updated from server/content/internships.json.`);
  if (seeded.skipped.length) {
    console.log(`Kept ${seeded.skipped.length} officer-edited internship row(s) as they are (run "npm run seed:internships -- --force" to overwrite):`);
    for (const s of seeded.skipped) console.log(`  #${s.id} ${s.company} (${s.reason})`);
  }
}
if (!process.env.ADMIN_EMAILS) console.warn('ADMIN_EMAILS is not set, so nobody can edit content. See README.');

const port = Number(process.env.PORT) || 3000;
createApp(db).listen(port, () => console.log(`BBSA Career Hub running at http://localhost:${port}`));
