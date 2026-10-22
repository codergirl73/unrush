/** Calendar awareness: schedule, event edits, leave-by times and free time for cooking. */
import { UnrushError } from "../errors.js";
import type { CalendarEvent } from "../providers/calendar.js";
import { at, isLocalDateTime, spokenTime, toMinutes, addMinutes, fromMinutes, dateOf } from "../time.js";
import { ensureHousehold, today, validateHousehold, type Ctx } from "./ctx.js";
import { checkDate } from "./meals.js";
import type { PreferencesStore } from "./preferences.js";

export interface EventInput {
  id?: string;
  title: string;
  start: string;
  end: string;
  location?: string | null;
}

export interface LeaveBy {
  household_id: string;
  event: CalendarEvent;
  origin: string;
  travel_minutes: number;
  buffer_minutes: number;
  leave_by: string;
  leave_by_spoken: string;
  needs_travel: boolean;
  previous_event: { id: string; title: string; end: string; previous_end: string | null } | null;
  minutes_free_before_leaving: number | null;
  conflict: boolean;
  travel_provider: string;
  simulated: boolean;
  explanation: string;
}

export interface Window {
  start: string;
  end: string;
  minutes: number;
}

export class Schedule {
  constructor(
    private readonly ctx: Ctx,
    private readonly prefs: PreferencesStore,
  ) {}

  get(householdId: string, date = today(this.ctx, householdId)) {
    validateHousehold(householdId);
    checkDate(date, "date");
    const events = this.ctx.calendar.listEvents(householdId, date).map((e) => ({
      ...e,
      leave_by: this.ctx.travel.estimate(this.home(householdId), e.location).minutes > 0 ? this.computeLeaveBy(householdId, e.id).leave_by : null,
    }));
    return {
      household_id: householdId,
      date,
      now: this.ctx.now(householdId),
      calendar_provider: this.ctx.calendar.name,
      simulated: this.ctx.calendar.simulated,
      events,
    };
  }

  /** Add a new event, or update one by id (e.g. a meeting that now runs late). */
  addOrUpdate(householdId: string, input: EventInput) {
    ensureHousehold(this.ctx, householdId);
    for (const [field, v] of [["start", input.start], ["end", input.end]] as const) {
      if (!isLocalDateTime(v)) throw new UnrushError(`Invalid ${field} "${v}". Use local time YYYY-MM-DDTHH:MM, e.g. ${today(this.ctx, householdId)}T19:00.`);
    }
    if (toMinutes(input.end) <= toMinutes(input.start)) throw new UnrushError("end must be after start.");
    if (!input.title?.trim()) throw new UnrushError("title is required.");
    const id = (input.id?.trim() || `evt_${Math.random().toString(36).slice(2, 8)}`).slice(0, 64);
    const existed = !!this.ctx.calendar.getEvent(householdId, id);
    const event = this.ctx.calendar.upsertEvent(
      householdId,
      { id, title: input.title.trim(), start: input.start, end: input.end, location: input.location?.trim() || null },
      this.ctx.now(householdId),
    );
    this.ctx.changed(householdId, "calendar");
    return { household_id: householdId, created: !existed, event, simulated: this.ctx.calendar.simulated };
  }

  /** leave_by = event start − travel time − buffer. */
  computeLeaveBy(householdId: string, eventId: string): LeaveBy {
    validateHousehold(householdId);
    const event = this.ctx.calendar.getEvent(householdId, eventId);
    if (!event) throw new UnrushError(`No event with id "${eventId}". Call get_schedule to see event ids.`);
    const prefs = this.prefs.get(householdId).preferences;
    const origin = prefs.home_location;
    const travel = this.ctx.travel.estimate(origin, event.location);
    const buffer = travel.minutes > 0 ? prefs.leave_buffer_minutes : 0;
    const leaveBy = addMinutes(event.start, -(travel.minutes + buffer));

    // The event that ends last before this one starts (same day) is what squeezes the departure.
    const prior = this.ctx.calendar
      .listEvents(householdId, dateOf(event.start))
      .filter((e) => e.id !== event.id && e.end <= event.start)
      .sort((a, b) => toMinutes(b.end) - toMinutes(a.end))[0];
    const free = prior ? toMinutes(leaveBy) - toMinutes(prior.end) : null;

    const parts = [
      `${event.title} starts ${spokenTime(event.start)}${event.location ? ` at ${event.location}` : ""}.`,
      travel.minutes > 0
        ? `${travel.simulated ? "Simulated travel" : "Travel"} ${travel.minutes} min + ${buffer} min buffer → leave by ${spokenTime(leaveBy)}.`
        : "No travel needed.",
    ];
    if (prior && free !== null) {
      parts.push(
        free < 0
          ? `${prior.title} ends ${spokenTime(prior.end)}, ${-free} min after you'd need to leave.`
          : `${prior.title} ends ${spokenTime(prior.end)}, leaving ${free} min.`,
      );
    }

    return {
      household_id: householdId,
      event,
      origin,
      travel_minutes: travel.minutes,
      buffer_minutes: buffer,
      leave_by: leaveBy,
      leave_by_spoken: spokenTime(leaveBy),
      needs_travel: travel.minutes > 0,
      previous_event: prior ? { id: prior.id, title: prior.title, end: prior.end, previous_end: prior.previous_end } : null,
      minutes_free_before_leaving: free,
      conflict: free !== null && free < 0,
      travel_provider: travel.provider,
      simulated: travel.simulated,
      explanation: parts.join(" "),
    };
  }

  /**
   * Free stretches tonight for cooking: from max(now, cook_window_start) to
   * latest_dinner_time, minus each event (including travel there and back).
   */
  freeWindows(householdId: string, date = today(this.ctx, householdId)): Window[] {
    const prefs = this.prefs.get(householdId).preferences;
    const now = this.ctx.now(householdId);
    let from = toMinutes(at(date, prefs.cook_window_start));
    const to = toMinutes(at(date, prefs.latest_dinner_time));
    if (dateOf(now) === date) from = Math.max(from, toMinutes(now));
    if (from >= to) return [];

    const busy = this.ctx.calendar
      .listEvents(householdId, date)
      .map((e) => {
        const travel = this.ctx.travel.estimate(prefs.home_location, e.location).minutes;
        const buffer = travel > 0 ? prefs.leave_buffer_minutes : 0;
        return [toMinutes(e.start) - travel - buffer, toMinutes(e.end) + travel] as const;
      })
      .sort((a, b) => a[0] - b[0]);

    const windows: Window[] = [];
    let cursor = from;
    for (const [s, e] of busy) {
      if (e <= cursor) continue;
      if (s >= to) break;
      if (s > cursor) windows.push(win(cursor, Math.min(s, to)));
      cursor = Math.max(cursor, e);
      if (cursor >= to) break;
    }
    if (cursor < to) windows.push(win(cursor, to));
    return windows.filter((w) => w.minutes > 0);
  }

  private home(householdId: string) {
    return this.prefs.get(householdId).preferences.home_location;
  }
}

function win(s: number, e: number): Window {
  return { start: fromMinutes(s), end: fromMinutes(e), minutes: Math.round(e - s) };
}
