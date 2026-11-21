# BBSA Career Hub

An internal recruiting tool for Vanderbilt's Black Business Student Association.

**Phase 1 (this version):**

- **Recruiting timelines** for investment banking, consulting and tech/trading/AI, broken down by class year. Each industry also has a guide covering roles, interview prep and resources. Officers can add more industries from the admin page without code changes.
- **Diversity & early-ID programs tracker** with program, firm, industry, eligible class years, deadline and link, filterable by industry, year and status.
- **This month**: what a student should focus on now, based on their class year (worked out from their graduation year) and the industries they chose. It shows open milestones they can tick off, deadlines in the next 45 days, what starts next month, and programs to watch.
- **Calendar** (kept from the original app): add program deadlines and milestone reminders, export `.ics`, use Google/Outlook links, or subscribe to a private feed.
- **Email formats** (kept): how 100 large consulting and finance firms format addresses, with confidence levels and fallbacks. Click a firm to build an address from a name.

Later phases are planned in [`docs/data-model.md`](docs/data-model.md) and not built yet.

## Running it

```bash
npm install
ADMIN_EMAILS=you@vanderbilt.edu npm start      # http://localhost:3000
npm test
```

Requires Node ≥ 22.13. The database is a single SQLite file at `data/bbsa.db`, created on first run and filled with the starter content in `server/content/`.

### Settings (environment variables)

| Variable | Purpose |
|---|---|
| `ADMIN_EMAILS` | Comma-separated officer emails who can use the Admin page. Edit this list to add or remove officers. |
| `ALLOWED_EMAIL_DOMAINS` | Who can sign up. Default `vanderbilt.edu`. |
| `SMTP_URL`, `MAIL_FROM` | Mail server for sign-up confirmation emails, e.g. `smtps://user:pass@smtp.example.com`. **Without it, confirmation links are printed to the server log** (fine for local testing). |
| `APP_URL` | Public URL used in confirmation links, e.g. `https://bbsa.example.com`. |
| `PORT`, `DB_FILE` | Port (default 3000) and database path. |

Sign-up requires a `@vanderbilt.edu` address, and the account only works after the confirmation link in that inbox is clicked.

## Editing content

Everything students see is stored in the database and edited from **Admin** (visible only to `ADMIN_EMAILS`):

- **Programs**: add each program's deadline, link and eligibility. Programs marked *needs review* show "details being confirmed" to students.
- **Timelines**: milestones have class years (none = every year) and a month window. Windows can wrap past December (Dec–Feb).
- **Industries**: add a new industry (e.g. Sales & Trading), then give it milestones and programs.
- **Email formats**: edit firms one at a time, or **upload a spreadsheet** (.xlsx or .csv) with `Firm` and `Best Email Format` columns, plus optional `Confidence`, `Fallback / Notes`, `Category`, `Sites Agreeing` and `Sector`. Firms are matched by name, so re-uploading updates them. Columns listing real people's published addresses are never read.
- **Backup**: download everything as one JSON file, or restore from one (for example, to hand over to next year's board).

The starter content in `server/content/*.json` is only used to fill an empty database. To regenerate the firms list from spreadsheets: `node scripts/formats-to-json.js sheet1.xlsx sheet2.xlsx > server/content/firms.json`.

### Where the starter content came from

- Timelines and industry guides: the IB (10/14/2026), consulting (10/28/2026) and tech/trading/AI (11/1/2026) recruiting slides. Each milestone records its source.
- Programs: the five early consulting programs named in the consulting slides (Bain BEL/CREW, BCG Embark/Advance, A&M CCDP). Their deadlines and links are blank and flagged for review. The slides didn't name specific IB or tech programs.
- Email formats: *Top 50 Consulting Firms* (researched 10/10/2026) and *Top 50 Finance & IB Firms* (researched 10/12/2026) spreadsheets.
- No junior- or senior-year milestones yet, because the slides focus on freshman and sophomore recruiting (except Big Tech, which recruits the summer before junior year).

## Privacy

- Resumes are not uploaded or stored in Phase 1. The Phase 2 resume checker is designed to process files in memory and keep only the results (see `docs/data-model.md`).
- The email verifier from the original app is kept in `server/email/verifier/` for the Phase 2 networking tracker, but it isn't in the interface. Its SMTP mailbox probe is off unless `SMTP_PROBE=on`.

## Project layout

```
server/
  app.js              wires routes together; profile endpoints
  routes/             auth (sign-up, confirmation), content (timelines, programs, this-month, formats), events, admin
  content/            starter JSON, store (seed/export/import), validation, spreadsheet importer
  db/                 schema.sql + SQLite connection
  email/              patterns.js (formats → addresses), verifier/ (Phase 2)
  academic.js         class year from graduation year; month windows
  calendar.js         .ics, Google/Outlook links
  auth.js, mailer.js, csv.js
public/               single-page frontend (vanilla JS, no build step)
scripts/              formats-to-json.js
docs/data-model.md    Phase 2/3 data model
test/                 node:test unit + API tests
```
