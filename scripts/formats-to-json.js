'use strict';
// Usage: node scripts/formats-to-json.js <sheet.xlsx> [more.xlsx ...] > server/content/firms.json
// Regenerates the firms seed file from officers' email-format spreadsheets.
const fs = require('node:fs');
const path = require('node:path');
const { readFormatsFile } = require('../server/content/formats-import');

(async () => {
  const byName = new Map();
  for (const file of process.argv.slice(2)) {
    const { firms, errors } = await readFormatsFile(fs.readFileSync(file), path.basename(file));
    errors.forEach((e) => console.error(`${path.basename(file)}: ${e}`));
    for (const f of firms) byName.set(f.name, f);
  }
  process.stdout.write(JSON.stringify([...byName.values()], null, 2) + '\n');
  console.error(`${byName.size} firms`);
})();
