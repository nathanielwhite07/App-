# BBSA Career Hub

An internal recruiting tool for Vanderbilt's Black Business Student Association.

**Phase 1 (this version):**

- **Recruiting timelines** for investment banking, consulting, software engineering, product management and sales & trading, broken down by class year. Each industry also has a guide covering roles, interview prep and resources. Officers can add more industries from the admin page without code changes.
- **Diversity & early-ID programs tracker**: 84 programs and pipeline organizations with firm, industries, who it's for, eligibility, format, timing, deadline and link. Filterable by industry, class year, status and type. Students can **pin** programs and set **reminders** for when applications open, a "start your application" nudge, and the deadline.
- **This month**: what a student should focus on now, based on their class year (worked out from their graduation year) and the industries they chose. It shows open milestones they can tick off, deadlines in the next 45 days, what starts next month, and programs to watch.
- **Calendar**: every reminder can be added to **Google Calendar, Outlook (Vanderbilt / Microsoft 365), Outlook.com or Apple Calendar (.ics)**, and students can subscribe to a private feed so new reminders sync automatically. Each student can save a preferred calendar.
- **Email formats**: how 150 large consulting, finance and tech firms format addresses, with confidence levels and fallbacks. Click a firm to build an address from a name.

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

- **Programs**: edit programs one at a time, or **upload the programs spreadsheet** (.xlsx or .csv with Industry, Firm, Program, and optionally Affinity focus, Eligible year, Format / location, Deadline / timing, Deadline date, Status, Link, Notes). Programs are matched by firm + name, so re-uploading an updated sheet refreshes them without losing students' pins or reminders. Status updates itself as dates pass: a passed deadline shows *Closed*, and an *upcoming* program whose expected month arrives shows *Check now*.
- **Timelines**: milestones have class years (none = every year) and a month window. Windows can wrap past December (Dec–Feb).
- **Industries**: add a new industry (e.g. Sales & Trading), then give it milestones and programs.
- **Email formats**: edit firms one at a time, or **upload a spreadsheet** (.xlsx or .csv) with `Firm` and `Best Email Format` columns, plus optional `Confidence`, `Fallback / Notes`, `Category`, `Sites Agreeing` and `Sector`. Firms are matched by name, so re-uploading updates them. Columns listing real people's published addresses are never read.
- **Backup**: download everything as one JSON file, or restore from one (for example, to hand over to next year's board).

The starter content in `server/content/*.json` fills an empty database. When the starter content changes in a new version of the app (`CONTENT_VERSION` in `server/content/store.js`), an existing database is upgraded on startup: industries, timelines and programs are replaced, new email formats are added (edited firms are left alone), and **the previous content is saved first** to a `backup-content-*.json` file next to the database. Students' own calendar events are kept.

To regenerate the seed files from spreadsheets:

```bash
node scripts/formats-to-json.js consulting.xlsx finance.xlsx tech.xlsx > server/content/firms.json
node scripts/programs-to-json.js programs.xlsx 2026-27 > server/content/programs.json
```

### Where the starter content came from

- Timelines and industry guides: BBSA's recruiting materials, rewritten for BBSA members.
- Programs: the *BBSA Affinity Programs 2026-27* sheet (compiled Nov 21, 2026).
- Email formats: the *Top 50 Consulting*, *Top 50 Finance & IB* and *Top 50 Tech Firms* email-format sheets.

## Calendar notes

- "Add to Outlook" opens Outlook on the web with the event filled in. Vanderbilt accounts use the Microsoft 365 option; personal Hotmail/Outlook.com accounts use Outlook.com.
- Subscribing to the feed (Calendar tab) needs the app on a public web address (`APP_URL`), because Google and Outlook fetch the feed from their own servers and can't reach `localhost`. One-off "Add to calendar" links and `.ics` downloads work anywhere.

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
