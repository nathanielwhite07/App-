# Data model

Phase 1 tables are in `server/db/schema.sql`. This document plans the tables for the later
phases so Phase 1 doesn't paint them into a corner. **None of the Phase 2/3 tables exist yet.**

## Phase 1 (built)

| Table | Purpose |
|---|---|
| `users` | Vanderbilt-only accounts. `grad_year` is stored and class year is derived from it (the academic year turns over in August). `industry_slugs` holds the industries the student follows. Admins are not stored here: they come from the `ADMIN_EMAILS` setting. |
| `sessions` | Login sessions. |
| `industries` | Investment banking, consulting, tech, plus any industries officers add. `guide_json` holds the industry guide sections. |
| `milestones` | Recurring, academic-year-relative guidance: class years plus a month window (`start_month`–`end_month`, which may wrap past December). |
| `programs` | Diversity, early-ID and pipeline programs: firm, kind, industries (several allowed), eligible years, who it's for, timing, status, confirmed dates or an expected month, link. |
| `program_pins` | Programs a student has pinned. |
| `firms` | Email format per firm (pattern + domain + fallbacks), imported from officers' spreadsheets. |
| `milestone_progress` | A student's "done" checkmarks, keyed by academic year so they reset each August. |
| `events` | Calendar items (meetings, deadlines, reminders). Optional `program_id`/`milestone_id`. The Phase 2 networking tracker adds `contact_id`. |

## Phase 2: guides and resume checker

```sql
-- Officer-written guides (resume format, email etiquette, cold-email structure...).
CREATE TABLE guides (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('resume','email','networking','interview')),
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,                 -- markdown, rendered client-side
  sort_order INTEGER DEFAULT 0,
  updated_by TEXT, updated_at TEXT
);

-- One row per check. The uploaded file is parsed in memory and discarded:
-- there is deliberately NO column for the file or its text.
CREATE TABLE resume_checks (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  page_count INTEGER,
  rule_results_json TEXT NOT NULL,       -- [{ rule: 'one_page'|'action_verbs'|'quantified_bullets'|'date_format'|..., status, details, line_refs }]
  score INTEGER,                         -- 0-100 from rule results
  ai_feedback TEXT,                      -- AI-written feedback (generated from the text in memory)
  ai_model TEXT
);
```

**Resume storage:** off by default. If a "keep my resume so I can re-check it" option is ever
added, it gets its own table (`resume_files(user_id, filename, text, expires_at)`) that is opt-in
per user, auto-expires, and is deletable from the profile page. It should never be a column on
`users`, which is how the original prototype stored it.

Rule checks planned: one page; bullets start with an action verb (from a curated list); share of
bullets with a number, %, or $; consistent date format (e.g. all "Jun 2026" vs "06/2026");
consistent bullet punctuation; required sections (Education first for students); GPA format;
no first-person pronouns.

## Phase 2: networking tracker

Reuses the kept email features: `firms` (format → address), the verifier in
`server/email/verifier/` (still not shown in the UI), and `events` for follow-ups.

```sql
-- Private to each student. Nobody else (including officers) can see them.
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL, last_name TEXT NOT NULL,
  firm_id INTEGER REFERENCES firms(id),   -- links to the email format
  firm_name TEXT,                         -- for firms not in the formats list
  title TEXT, email TEXT,
  email_source TEXT CHECK (email_source IN ('format','given','other')),
  verification_json TEXT,                 -- cached verifier result
  how_met TEXT,                           -- e.g. "BBSA alumni panel"
  status TEXT NOT NULL DEFAULT 'to_contact'
    CHECK (status IN ('to_contact','emailed','replied','chatted','thanked','closed')),
  next_follow_up_on TEXT,
  notes TEXT,
  created_at TEXT, updated_at TEXT
);

CREATE TABLE interactions (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind TEXT CHECK (kind IN ('email','call','coffee_chat','event','linkedin')),
  happened_on TEXT, notes TEXT
);

-- Officer-written templates students start from.
CREATE TABLE email_templates (
  id INTEGER PRIMARY KEY,
  purpose TEXT CHECK (purpose IN ('cold_outreach','follow_up','thank_you','referral_ask')),
  title TEXT, body TEXT,                  -- with {first_name}, {firm} placeholders
  updated_by TEXT, updated_at TEXT
);

-- Feedback on the student's OWN draft (rule checks + AI comments), not a generated email.
CREATE TABLE draft_reviews (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  created_at TEXT,
  rule_results_json TEXT,                 -- length, clear ask, subject line, personalisation...
  ai_feedback TEXT
  -- whether to keep the draft text itself is an open question; default to not storing it
);

ALTER TABLE events ADD COLUMN contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL;
```

The follow-up reminders from the original prototype come back here: marking a contact
"emailed" creates a reminder event five business days later (`addBusinessDays` is still in
`server/calendar.js`).

## Phase 3: opt-in alumni / upperclassmen directory

```sql
CREATE TABLE directory_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  visible INTEGER NOT NULL DEFAULT 0,     -- opt-in: nobody is listed until they turn this on
  role TEXT CHECK (role IN ('student','alum')),
  grad_year INTEGER, major TEXT,
  industries_json TEXT,                   -- industry slugs
  experience_json TEXT,                   -- [{ firm, role, year }] internships / jobs
  open_to_json TEXT,                      -- ['coffee_chat','resume_review','mock_interview']
  contact_pref TEXT,                      -- 'platform' | 'email' | 'linkedin'
  linkedin TEXT, bio TEXT,
  updated_at TEXT
);

-- Alumni no longer have @vanderbilt.edu addresses, so they join by officer invite.
CREATE TABLE invites (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'alum',
  invited_by TEXT, created_at TEXT, used_at TEXT
);
```

Directory access: signed-in members only; contact details shown only for fields the person
chose to share; profile hidden immediately when `visible` is turned off.

## Internships (built)

| Table | Purpose |
|---|---|
| `internships` | One row per firm program: the 17 spreadsheet columns, keyed by the spreadsheet's `id`, plus `updated_by` (`seed` until an officer edits it). The status students see is computed: a past `deadline_date` always shows "Closed". |
| `internship_stars` | A student's own "My list". Only read for that student; starred deadlines are turned into all-day calendar events when the calendar or feed is requested, so they follow officer edits. |

`meta.internships_seed_hash` records which seed file was last loaded, and `meta.internships_deleted` records rows officers deleted, so reloading the seed doesn't bring them back.
