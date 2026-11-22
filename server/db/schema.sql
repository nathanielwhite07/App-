-- BBSA Career Hub, Phase 1 schema.
-- Later-phase tables are planned in docs/data-model.md and are not created yet.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,              -- must be @vanderbilt.edu
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  grad_year INTEGER,                       -- class year is derived from this, never stored
  industry_slugs TEXT NOT NULL DEFAULT '[]', -- JSON array of industries the student follows
  email_verified_at TEXT,
  verify_token TEXT UNIQUE,
  calendar_token TEXT UNIQUE,              -- secret token for the subscribable .ics feed
  calendar_provider TEXT,                  -- preferred calendar: google | outlook | outlookcom | ics
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS industries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  summary TEXT,
  guide_json TEXT NOT NULL DEFAULT '[]',   -- [{ heading, items: [..] }] overview sections
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Recurring, academic-year-relative guidance: "sophomores, Dec–Feb: network heavily".
CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  industry_id INTEGER NOT NULL REFERENCES industries(id) ON DELETE CASCADE,
  track TEXT,                              -- optional sub-track, e.g. "Quant" within Tech
  class_years TEXT NOT NULL DEFAULT '[]',  -- JSON array of class years (1-4); [] = every year
  start_month INTEGER NOT NULL CHECK (start_month BETWEEN 1 AND 12),
  end_month INTEGER NOT NULL CHECK (end_month BETWEEN 1 AND 12), -- may wrap past December
  title TEXT NOT NULL,
  details TEXT,
  category TEXT NOT NULL DEFAULT 'prepare' CHECK (category IN ('explore','prepare','network','apply','interview')),
  link TEXT,
  priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3), -- 1 = high
  sort_order INTEGER NOT NULL DEFAULT 0,
  source TEXT,                             -- where the guidance came from
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_milestones_industry ON milestones(industry_id);

-- Dated, per-cycle opportunities: diversity, early-ID, insight programs and pipeline orgs.
CREATE TABLE IF NOT EXISTS programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  firm TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'firm' CHECK (kind IN ('firm','pipeline')), -- firm program vs. pipeline organization
  industries TEXT NOT NULL DEFAULT '[]',   -- JSON array of industry slugs (pipeline orgs often span several)
  eligible_years TEXT NOT NULL DEFAULT '[]', -- JSON array of class years, e.g. [1,2]
  eligibility TEXT,                        -- eligibility as written, e.g. "Sophomore (preferred GPA 3.2+)"
  affinity TEXT,                           -- who it's for, e.g. "Open to all", "Women"
  format TEXT,                             -- e.g. "Virtual, three weeks"
  timing TEXT,                             -- deadline/timing as written, e.g. "Expected ~Feb 2027"
  status TEXT NOT NULL DEFAULT 'upcoming'
    CHECK (status IN ('open','check_now','upcoming','watch','closed','not_running','unconfirmed')),
  cycle TEXT,                              -- e.g. "2026-27"
  opens_on TEXT,                           -- YYYY-MM-DD, confirmed opening date
  deadline TEXT,                           -- YYYY-MM-DD, confirmed deadline
  expected_month TEXT,                     -- YYYY-MM, estimated application window when no date is confirmed
  rolling INTEGER NOT NULL DEFAULT 0,
  link TEXT,
  description TEXT,                        -- notes for students
  needs_review INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (firm, name)
);
CREATE INDEX IF NOT EXISTS idx_programs_deadline ON programs(deadline);

CREATE TABLE IF NOT EXISTS program_pins (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, program_id)
);

-- Email formats for large firms (kept from the original app; imported from officers' spreadsheets).
CREATE TABLE IF NOT EXISTS firms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sector TEXT,                             -- e.g. Consulting, Finance
  category TEXT,                           -- e.g. Strategy (MBB), Bulge Bracket
  domain TEXT NOT NULL,
  pattern TEXT NOT NULL,                   -- key into server/email/patterns.js
  max_local INTEGER,                       -- some firms cap usernames (Cisco: 8 characters)
  confidence TEXT,                         -- Confirmed | Very High | High | Medium
  fallbacks_json TEXT NOT NULL DEFAULT '[]', -- [{ pattern, domain }]
  notes TEXT,
  sources_agree TEXT,                      -- e.g. "4 of 5"
  researched_on TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS milestone_progress (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  milestone_id INTEGER NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  academic_year INTEGER NOT NULL,          -- e.g. 2026 for 2026-27; progress resets each year
  done_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, milestone_id, academic_year)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL,
  milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'meeting',    -- meeting | deadline | reminder
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  starts_at TEXT NOT NULL,                 -- ISO-8601 UTC
  duration_min INTEGER NOT NULL DEFAULT 30,
  uid TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Key/value settings, e.g. which version of the starter content is loaded.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
