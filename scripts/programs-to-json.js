'use strict';
// Usage: node scripts/programs-to-json.js <programs.xlsx> [cycle] > server/content/programs.json
// Regenerates the programs seed file from the officers' programs spreadsheet.
const fs = require('node:fs');
const path = require('node:path');
const { readProgramsFile } = require('../server/content/programs-import');

(async () => {
  const [file, cycle = '2026-27'] = process.argv.slice(2);
  const { programs, errors } = await readProgramsFile(fs.readFileSync(file), path.basename(file), { cycle });
  errors.forEach((e) => console.error(e));
  process.stdout.write(JSON.stringify(programs, null, 2) + '\n');
  console.error(`${programs.length} programs`);
})();
