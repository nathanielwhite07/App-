# FirmConnect

A model app for students networking into big firms. It has four parts:

1. **Email lookup.** Search your contact database by name, firm, industry, school or interest. If someone isn't in it, the email finder guesses their address.
2. **Resume matching.** Students upload a resume (PDF, DOCX or TXT). The app pulls out their interests, schools, career tracks and skills, then ranks contacts by what they have in common and explains why each match was made.
3. **Email verifier.** Works like RocketReach's grading. Each address gets a deliverability verdict, a 0–99 confidence score, a letter grade and a separate domain‑reputation rating.
4. **Calendar integration.** Book coffee chats from a contact's page. Follow-up and thank-you reminders are created automatically. Events can be exported as `.ics`, opened as one-click Google/Outlook links, or synced through a private feed URL that Google, Outlook or Apple Calendar can subscribe to.

## Quick start

```bash
npm install
npm start            # http://localhost:3000
npm test
```

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`, so no database server is needed).

On first run the app seeds **36 fictional contacts at 6 fictional firms** on `.example` domains so you can try every feature. Verification for those domains uses simulated DNS/SMTP answers (`server/seed/demo-dns.json`). All other domains use live lookups. To start without them, set `SEED=off`.

Try it: sign up, upload `samples/sample-resume.txt` on the Profile tab, then open **For you**.

## Bringing in your own email database

Go to Profile → Import contacts and upload a CSV, or `POST /api/import`. Header names are flexible (`First Name`/`first_name`, `Company`/`Firm`, `Interests`/`Hobbies`, …). See `samples/contacts-template.csv`. People are matched on name + firm, so they are updated instead of duplicated. Each import retrains the per-firm email-pattern model.

## How the verifier scores an email

| Signal | Effect |
|---|---|
| Syntax (RFC 5322 subset) | Fail → invalid |
| Typo of a popular domain (`gmial.com`) | −30, suggests a correction |
| Disposable domain | Invalid, reputation 0 |
| Role inbox (`info@`, `recruiting@`) | −15 |
| Free webmail vs. the firm's domain | −10 / −15 when the firm's domain differs |
| Matches the firm's learned naming pattern (`first.last@`) | up to +15; −15 if the firm clearly uses another pattern |
| MX records | +15; none (and no A record) → invalid |
| Enterprise mail host (Google Workspace, Microsoft 365, Proofpoint, Mimecast…) | +3 |
| SPF / DMARC (enforced) | +3 / +4, plus a large share of the reputation score |
| SMTP `RCPT TO` probe | 250 → **valid** (+30); 5xx → **invalid**; accepts a random address → **accept-all** (capped at 79) |
| Record not re-verified for over a year | −5 |

Statuses: `valid`, `likely_valid` (strong DNS and data signals, but no SMTP confirmation), `accept_all`, `risky`, `invalid`. Grades: A+ ≥ 90, A ≥ 80, B ≥ 70, C ≥ 55, D ≥ 35, F below that.

**SMTP probing note:** most cloud hosts and home ISPs block outbound port 25. When the probe can't connect, the result says so and the grade relies on the other signals. For production, run the probe from a host with port 25 open and a proper reverse DNS/HELO name (`SMTP_HELO_DOMAIN`), or plug a commercial verification API into `server/verifier/resolvers.js`. Set `SMTP_PROBE=off` to disable probing.

## Project layout

```
server/
  app.js              Express routes (auth, directory, matches, finder, verifier, import, pipeline, calendar)
  db.js               SQLite schema + upserts + seeding
  verifier/           Scoring engine, reference lists, live & demo DNS/SMTP resolvers
  patterns.js         Learns each firm's email format and generates candidates
  matcher/            Resume → profile extraction, interest taxonomy, match scoring, intro drafts
  calendar.js         ICS generation, Google/Outlook links, business-day maths
  resume.js, csv.js, auth.js
public/               Single-page frontend (vanilla JS, no build step)
test/                 node:test unit + API integration tests (run offline)
```

## Main API endpoints

All `/api` routes except auth require a session cookie or `Authorization: Bearer <token>`.

- `POST /api/auth/signup | login | logout`, `GET/PATCH /api/me`
- `POST /api/me/resume` (multipart `resume`, or `{ text }`), `PUT /api/me/profile`
- `GET /api/contacts?q=&company=&industry=&school=&interest=`, `GET /api/contacts/:id`
- `GET /api/matches`, `GET /api/contacts/:id/intro`
- `POST /api/finder { firstName, lastName, companyId | domain }`
- `POST /api/verify { email }`, `POST /api/verify/bulk { emails }`, `POST /api/contacts/:id/verify`
- `POST /api/import` (CSV file, `{ csv }` or `{ contacts }`)
- `GET/PUT/DELETE /api/saved/:contactId` (outreach pipeline; setting `emailed` schedules a follow-up)
- `GET/POST/DELETE /api/events`, `GET /api/events/:id.ics`, `GET /calendar/:token.ics` (subscribable feed)

## Next steps toward production

- Two-way Google Calendar sync through OAuth (Calendar API `events.insert`) and free/busy lookup for suggesting meeting times
- Run verification as a background job queue with caching per domain
- A maintained disposable-domain list and domain-age (WHOIS/RDAP) signals
- Admin roles for who can import or export contacts

## Compliance

Use contact data you are allowed to use. Cold outreach must follow CAN-SPAM (US), GDPR/UK GDPR (EU/UK, which requires a lawful basis for processing personal data) and CASL (Canada). Honour opt-out requests and remove people from your database when they ask.
