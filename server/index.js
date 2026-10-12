'use strict';
const { openDb, seedIfEmpty } = require('./db');
const { createApp } = require('./app');

const db = openDb();
const seeded = process.env.SEED === 'off' ? 0 : seedIfEmpty(db);
if (seeded) console.log(`Seeded ${seeded} demo contacts (fictional firms on .example domains).`);

const port = Number(process.env.PORT) || 3000;
createApp(db).listen(port, () => console.log(`FirmConnect running at http://localhost:${port}`));
