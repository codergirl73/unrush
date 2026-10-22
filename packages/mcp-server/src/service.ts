/**
 * Composition root for the domain: one Unrush instance per database, shared by
 * every MCP session. Providers are injectable so tests and future real
 * integrations (Google Calendar, a maps API) can swap the simulated defaults.
 */
import type { DB } from "./db.js";
import { listHouseholds, type ChangeKind, type Ctx } from "./domain/ctx.js";
import { Groceries } from "./domain/groceries.js";
import { Meals } from "./domain/meals.js";
import { Pantry } from "./domain/pantry.js";
import { PreferencesStore } from "./domain/preferences.js";
import { ProactiveEngine } from "./domain/proactive.js";
import { Schedule } from "./domain/schedule.js";
import { SimulatedCalendar, type CalendarProvider } from "./providers/calendar.js";
import { SimulatedTravel, type TravelProvider } from "./providers/travel.js";
import { addMinutes, clockFromEnv, type Clock } from "./time.js";

export interface UnrushOptions {
  clock?: Clock;
  calendar?: CalendarProvider;
  travel?: TravelProvider;
  /** "queue" (default) re-checks alerts asynchronously after writes; "sync" checks inline (tests); "off" disables. */
  proactiveOnChange?: "queue" | "sync" | "off";
}

export class Unrush {
  readonly ctx: Ctx;
  readonly pantry: Pantry;
  readonly prefs: PreferencesStore;
  readonly meals: Meals;
  readonly schedule: Schedule;
  readonly groceries: Groceries;
  readonly proactive: ProactiveEngine;

  constructor(db: DB, opts: UnrushOptions = {}) {
    const mode = opts.proactiveOnChange ?? "queue";
    const clock = opts.clock ?? clockFromEnv();
    const offset = db.prepare("SELECT clock_offset_min FROM households WHERE id = ?").pluck();
    this.ctx = {
      db,
      clock,
      now: (householdId: string) => {
        const min = (offset.get(householdId) as number | undefined) ?? 0;
        return min ? addMinutes(clock.now(), min) : clock.now();
      },
      calendar: opts.calendar ?? new SimulatedCalendar(db),
      travel: opts.travel ?? new SimulatedTravel(),
      changed: (householdId: string, _kind: ChangeKind) => {
        if (mode === "queue") this.proactive.queue(householdId);
        else if (mode === "sync") this.proactive.check(householdId);
      },
    };
    this.pantry = new Pantry(this.ctx);
    this.prefs = new PreferencesStore(this.ctx);
    this.meals = new Meals(this.ctx, this.pantry, this.prefs);
    this.schedule = new Schedule(this.ctx, this.prefs);
    this.groceries = new Groceries(this.ctx, this.pantry, this.meals);
    this.proactive = new ProactiveEngine(this.ctx, this.schedule, this.meals, this.groceries, this.prefs);
  }

  listHouseholds() {
    return listHouseholds(this.ctx);
  }
}

export { UnrushError } from "./errors.js";
