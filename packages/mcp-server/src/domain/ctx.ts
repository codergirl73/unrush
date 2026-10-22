/**
 * Shared context for every domain module. Tools are thin wrappers over these
 * modules, so the logic is unit-testable with an in-memory DB and a fixed clock.
 */
import type { DB } from "../db.js";
import { UnrushError } from "../errors.js";
import type { CalendarProvider } from "../providers/calendar.js";
import type { TravelProvider } from "../providers/travel.js";
import type { Clock } from "../time.js";

export type ChangeKind = "calendar" | "pantry" | "plan" | "orders" | "preferences";

export interface Ctx {
  db: DB;
  clock: Clock;
  /** The household's local time: the clock plus the household's demo offset (0 unless seeded with a start time). */
  now(householdId: string): string;
  calendar: CalendarProvider;
  travel: TravelProvider;
  /** Called after any write so the proactive checker can re-run immediately. */
  changed(householdId: string, kind: ChangeKind): void;
}

const HOUSEHOLD_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function validateHousehold(id: string): string {
  if (typeof id !== "string" || !HOUSEHOLD_RE.test(id)) {
    throw new UnrushError(`Invalid household_id "${id}". Use 1-64 letters, digits, "-" or "_" (e.g. "demo-household").`);
  }
  return id;
}

export function ensureHousehold(ctx: Ctx, id: string, name?: string) {
  validateHousehold(id);
  ctx.db
    .prepare("INSERT INTO households (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, households.name)")
    .run(id, name ?? null);
}

export function listHouseholds(ctx: Ctx): Array<{ id: string; name: string | null }> {
  return ctx.db.prepare("SELECT id, name FROM households ORDER BY id").all() as Array<{ id: string; name: string | null }>;
}

export function today(ctx: Ctx, householdId: string): string {
  return ctx.now(householdId).slice(0, 10);
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
