'use strict';
const { openDb } = require('./db');
const { seedIfEmpty } = require('./content/store');
const { createApp } = require('./app');

const db = openDb();
const seeded = seedIfEmpty(db);
if (Object.keys(seeded).length) console.log('Loaded starter content:', seeded);
if (!process.env.ADMIN_EMAILS) console.warn('ADMIN_EMAILS is not set, so nobody can edit content. See README.');

const port = Number(process.env.PORT) || 3000;
createApp(db).listen(port, () => console.log(`BBSA Career Hub running at http://localhost:${port}`));
