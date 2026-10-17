/**
 * CalendarProvider: where events come from. The default SimulatedCalendar keeps
 * events in SQLite (seeded demo data, edited by add_or_update_event). A real
 * provider (e.g. Google Calendar) would implement the same interface.
 */
import type { DB } from "../db.js";

export interface CalendarEvent {
  id: string;
  title: string;
  /** Local wall-clock "YYYY-MM-DDTHH:MM". */
  start: string;
  end: string;
  /** Free text place name; null/"Home"/"Online" means no travel needed. */
  location: string | null;
  /** Set when the event was moved/extended, so alerts can explain what changed. */
  previous_start: string | null;
  previous_end: string | null;
}

export interface CalendarProvider {
  readonly name: string;
  readonly simulated: boolean;
  /** Events overlapping the local date, ordered by start. */
  listEvents(householdId: string, date: string): CalendarEvent[];
  getEvent(householdId: string, id: string): CalendarEvent | undefined;
  /** Insert or update; returns the stored event (with previous_* filled on time changes). */
  upsertEvent(householdId: string, event: Omit<CalendarEvent, "previous_start" | "previous_end">, now: string): CalendarEvent;
}

export class SimulatedCalendar implements CalendarProvider {
  readonly name = "simulated-calendar";
  readonly simulated = true;

  constructor(private readonly db: DB) {}

  listEvents(householdId: string, date: string): CalendarEvent[] {
    return this.db
      .prepare(
        `SELECT id, title, start, end, location, previous_start, previous_end FROM events
         WHERE household_id = ? AND start < ? AND end > ? ORDER BY start, id`,
      )
      .all(householdId, `${date}T24:00`, `${date}T00:00`) as CalendarEvent[];
  }

  getEvent(householdId: string, id: string): CalendarEvent | undefined {
    return this.db
      .prepare("SELECT id, title, start, end, location, previous_start, previous_end FROM events WHERE household_id = ? AND id = ?")
      .get(householdId, id) as CalendarEvent | undefined;
  }

  upsertEvent(householdId: string, e: Omit<CalendarEvent, "previous_start" | "previous_end">, now: string): CalendarEvent {
    const before = this.getEvent(householdId, e.id);
    const moved = before && (before.start !== e.start || before.end !== e.end);
    this.db
      .prepare(
        `INSERT INTO events (household_id, id, title, start, end, location, previous_start, previous_end, updated_at)
         VALUES (@household_id, @id, @title, @start, @end, @location, @previous_start, @previous_end, @now)
         ON CONFLICT(household_id, id) DO UPDATE SET title = excluded.title, start = excluded.start, end = excluded.end,
           location = excluded.location, previous_start = excluded.previous_start, previous_end = excluded.previous_end,
           updated_at = excluded.updated_at`,
      )
      .run({
        household_id: householdId,
        ...e,
        previous_start: moved ? before.start : (before?.previous_start ?? null),
        previous_end: moved ? before.end : (before?.previous_end ?? null),
        now,
      });
    return this.getEvent(householdId, e.id)!;
  }
}
