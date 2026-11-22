'use strict';
const path = require('node:path');
const { openDb } = require('./db');
const { syncContent } = require('./content/store');
const { createApp } = require('./app');

const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'bbsa.db');
const db = openDb(dbFile);
const sync = syncContent(db, { backupDir: path.dirname(dbFile) });
if (sync.seeded) console.log('Loaded starter content:', sync.seeded);
if (sync.upgraded) {
  console.log(`Updated starter content from v${sync.upgraded.from} to v${sync.upgraded.to} (${sync.upgraded.newFirms} new email formats).`);
  console.log(`The previous timelines and programs were saved to ${sync.upgraded.backup}`);
}
if (!process.env.ADMIN_EMAILS) console.warn('ADMIN_EMAILS is not set, so nobody can edit content. See README.');

const port = Number(process.env.PORT) || 3000;
createApp(db).listen(port, () => console.log(`BBSA Career Hub running at http://localhost:${port}`));
