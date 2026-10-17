import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root (…/packages/mcp-server/src → ../../..). Relative DB paths resolve from here. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function resolveDbPath(p = process.env.UNRUSH_DB_PATH ?? "./data/unrush.db"): string {
  return p === ":memory:" || isAbsolute(p) ? p : resolve(REPO_ROOT, p);
}

export type DB = Database.Database;

/*
 * Times are household-local wall-clock strings ("YYYY-MM-DDTHH:MM"); see time.ts.
 * Quantities are stored in canonical units (g | ml | count | <package word>); see units.ts.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS households (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pantry_items (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  item         TEXT NOT NULL,
  quantity     REAL NOT NULL,
  unit         TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (household_id, item)
);

CREATE TABLE IF NOT EXISTS preferences (
  household_id TEXT PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  data         TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One planned dinner per household per date. previous_meal remembers what a swap replaced.
CREATE TABLE IF NOT EXISTS meal_plan_days (
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  week_start    TEXT NOT NULL,
  meal          TEXT NOT NULL,
  prep_minutes  INTEGER NOT NULL,
  ingredients   TEXT NOT NULL,
  previous_meal TEXT,
  cooked_at     TEXT,
  PRIMARY KEY (household_id, date)
);
CREATE INDEX IF NOT EXISTS idx_plan_week ON meal_plan_days(household_id, week_start);

-- Calendar events (SimulatedCalendar storage). previous_* keep the last change so alerts can say "now runs to 7".
CREATE TABLE IF NOT EXISTS events (
  household_id   TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  id             TEXT NOT NULL,
  title          TEXT NOT NULL,
  start          TEXT NOT NULL,
  end            TEXT NOT NULL,
  location       TEXT,
  previous_start TEXT,
  previous_end   TEXT,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (household_id, id)
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(household_id, start);

-- Every purchase (seeded history, manual "we bought…", placed orders). Feeds run-out prediction.
CREATE TABLE IF NOT EXISTS purchases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  item         TEXT NOT NULL,
  quantity     REAL NOT NULL,
  unit         TEXT NOT NULL,
  purchased_at TEXT NOT NULL,
  source       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchases_item ON purchases(household_id, item);

-- Recorded usage (cooking, "we're out of eggs"). quantity NULL = ran out entirely.
CREATE TABLE IF NOT EXISTS consumption_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  item         TEXT NOT NULL,
  quantity     REAL,
  unit         TEXT,
  reason       TEXT NOT NULL,
  logged_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('draft', 'placed')),
  data         TEXT NOT NULL,
  confirmation TEXT,
  created_at   TEXT NOT NULL,
  placed_at    TEXT
);

-- Proactive alerts. dedupe_key stops the checker from repeating itself.
CREATE TABLE IF NOT EXISTS alerts (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  dedupe_key   TEXT NOT NULL,
  title        TEXT NOT NULL,
  message      TEXT NOT NULL,
  data         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'resolved')),
  created_at   TEXT NOT NULL,
  UNIQUE (household_id, dedupe_key)
);
`;

/** Open (or create) the SQLite database. Pass ":memory:" for tests. */
export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 3000");
  db.exec(SCHEMA);
  return db;
}
