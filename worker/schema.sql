-- Ice cream debt tracker schema (Cloudflare D1 / SQLite).
-- All timestamps are milliseconds since the Unix epoch.

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT    NOT NULL CHECK (type IN ('owe', 'paid')),
  qty        INTEGER NOT NULL,
  by         TEXT    NOT NULL,          -- 'Muneeb', 'Fiza' or 'system'
  note       TEXT,
  flavour    TEXT,
  shop_id    INTEGER,                   -- shops.id for 'paid' events (optional)
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_created ON events (created_at);
CREATE INDEX IF NOT EXISTS idx_events_by_created ON events (by, created_at);

CREATE TABLE IF NOT EXISTS shops (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  area       TEXT,
  address    TEXT,
  lat        REAL    NOT NULL,
  lng        REAL    NOT NULL,
  note       TEXT,
  visited    INTEGER DEFAULT 0,         -- 0/1
  is_next    INTEGER DEFAULT 0,         -- 0/1, at most one shop is "next"
  added_by   TEXT,
  created_at INTEGER NOT NULL
);

-- Milestones every 10 ice creams owed (all-time). Muneeb can pre-write a sealed
-- note for any of them; opened_at records when Fiza opened the envelope.
CREATE TABLE IF NOT EXISTS milestones (
  at         INTEGER PRIMARY KEY,       -- 20, 30, 40, ...
  note       TEXT,
  opened_at  INTEGER,
  updated_at INTEGER NOT NULL
);

-- Small key/value store. 'pin_fiza' holds a hash of Fiza's PIN once Muneeb
-- resets it from the site (until then the PIN_FIZA secret is used).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Wrong-PIN counter per client IP: 10 misses locks that IP out for 15 minutes.
CREATE TABLE IF NOT EXISTS pin_attempts (
  ip           TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL,
  locked_until INTEGER,
  updated_at   INTEGER NOT NULL
);

-- Fiza's visits (she knows they're logged): start time, country, and the last
-- check-in while the page was on screen (so last_seen - at = time spent).
-- No IP, city or device. Logins with her PIN on browsers Muneeb has marked as
-- his aren't recorded. Kept for 90 days.
CREATE TABLE IF NOT EXISTS opens (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  country   TEXT,
  last_seen INTEGER
);
CREATE INDEX IF NOT EXISTS idx_opens_at ON opens (at);
