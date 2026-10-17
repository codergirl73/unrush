/** Household preferences: diet rules, allergies, household size and the evening rhythm Unrush plans around. */
import { WEEKDAYS, type Weekday } from "../dates.js";
import { UnrushError } from "../errors.js";
import { ensureHousehold, validateHousehold, type Ctx } from "./ctx.js";

export interface Preferences {
  diets: string[];
  allergies: string[];
  dislikes: string[];
  household_size: number;
  weekday_rules: Partial<Record<Weekday, string>>;
  /** When dinner is usually eaten, HH:MM. */
  usual_dinner_time: string;
  /** Latest acceptable dinner time, HH:MM. Cooking must finish by then. */
  latest_dinner_time: string;
  /** Earliest time on a weekday evening that cooking can start, HH:MM. */
  cook_window_start: string;
  /** Minutes of slack added before leaving for an event. */
  leave_buffer_minutes: number;
  /** Where travel starts from. */
  home_location: string;
  notes: string;
}

export const DEFAULT_PREFERENCES: Preferences = {
  diets: [],
  allergies: [],
  dislikes: [],
  household_size: 2,
  weekday_rules: {},
  usual_dinner_time: "18:30",
  latest_dinner_time: "21:30",
  cook_window_start: "17:00",
  leave_buffer_minutes: 5,
  home_location: "Home",
  notes: "",
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class PreferencesStore {
  constructor(private readonly ctx: Ctx) {}

  get(householdId: string): { household_id: string; preferences: Preferences } {
    validateHousehold(householdId);
    const row = this.ctx.db.prepare("SELECT data FROM preferences WHERE household_id = ?").get(householdId) as { data: string } | undefined;
    const preferences = { ...DEFAULT_PREFERENCES, ...(row ? (JSON.parse(row.data) as Partial<Preferences>) : {}) };
    return { household_id: householdId, preferences };
  }

  /** Partial update: only provided fields change. A weekday rule set to "" is removed. */
  set(householdId: string, patch: Partial<Preferences>) {
    ensureHousehold(this.ctx, householdId);
    const current = this.get(householdId).preferences;
    const next: Preferences = { ...current };
    const clean = (xs?: string[]) => (xs ? [...new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean))] : undefined);

    if (patch.diets) next.diets = clean(patch.diets)!;
    if (patch.allergies) next.allergies = clean(patch.allergies)!;
    if (patch.dislikes) next.dislikes = clean(patch.dislikes)!;
    if (patch.household_size !== undefined) {
      if (!Number.isInteger(patch.household_size) || patch.household_size < 1 || patch.household_size > 20) {
        throw new UnrushError("household_size must be an integer between 1 and 20.");
      }
      next.household_size = patch.household_size;
    }
    for (const key of ["usual_dinner_time", "latest_dinner_time", "cook_window_start"] as const) {
      const v = patch[key];
      if (v === undefined) continue;
      if (!HHMM.test(v)) throw new UnrushError(`${key} must be a 24h time like "18:30".`);
      next[key] = v;
    }
    if (patch.leave_buffer_minutes !== undefined) {
      if (!Number.isInteger(patch.leave_buffer_minutes) || patch.leave_buffer_minutes < 0 || patch.leave_buffer_minutes > 60) {
        throw new UnrushError("leave_buffer_minutes must be an integer between 0 and 60.");
      }
      next.leave_buffer_minutes = patch.leave_buffer_minutes;
    }
    if (patch.home_location !== undefined) next.home_location = patch.home_location.trim() || "Home";
    if (patch.notes !== undefined) next.notes = patch.notes.trim();
    if (patch.weekday_rules) {
      const rules = { ...current.weekday_rules };
      for (const [day, rule] of Object.entries(patch.weekday_rules)) {
        const d = day.toLowerCase() as Weekday;
        if (!WEEKDAYS.includes(d)) throw new UnrushError(`Unknown weekday "${day}". Use monday … sunday.`);
        const r = (rule ?? "").trim().toLowerCase();
        if (r) rules[d] = r;
        else delete rules[d];
      }
      next.weekday_rules = rules;
    }
    if (next.latest_dinner_time <= next.cook_window_start) {
      throw new UnrushError("latest_dinner_time must be after cook_window_start.");
    }

    this.ctx.db
      .prepare(
        `INSERT INTO preferences (household_id, data, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(household_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(householdId, JSON.stringify(next));
    this.ctx.changed(householdId, "preferences");
    return { household_id: householdId, preferences: next };
  }
}
