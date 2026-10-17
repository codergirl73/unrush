/**
 * Proactive engine. Rules run on a timer and right after calendar/pantry/plan
 * changes; each finding becomes an alert row with a dedupe key so the same
 * situation is reported once. Alerts whose situation went away are resolved.
 *
 *   (a) leave_by     – an event change squeezes the time before you must leave
 *   (b) meal_fit     – tonight's planned dinner no longer fits the free time
 *   (c) runout       – a staple is out or predicted to run out within 2 days
 */
import { addDays } from "../dates.js";
import { log } from "../log.js";
import { spokenTime, toMinutes } from "../time.js";
import { listHouseholds, newId, today, validateHousehold, type Ctx } from "./ctx.js";
import type { Groceries } from "./groceries.js";
import type { Meals } from "./meals.js";
import type { PreferencesStore } from "./preferences.js";
import type { Schedule } from "./schedule.js";

export type AlertKind = "leave_by" | "meal_fit" | "runout";

export interface Alert {
  id: string;
  kind: AlertKind;
  title: string;
  message: string;
  data: Record<string, unknown>;
  status: "pending" | "delivered" | "resolved";
  created_at: string;
}

interface Finding {
  kind: AlertKind;
  key: string;
  title: string;
  message: string;
  data: Record<string, unknown>;
}

/** Leave-by alerts fire when departure is this close to the previous event's end… */
const SQUEEZE_MINUTES = 30;
/** …or simply this close to now. */
const SOON_MINUTES = 60;
const RUNOUT_DAYS = 2;

export class ProactiveEngine {
  private timer?: NodeJS.Timeout;
  private queued = new Set<string>();

  constructor(
    private readonly ctx: Ctx,
    private readonly schedule: Schedule,
    private readonly meals: Meals,
    private readonly groceries: Groceries,
    private readonly prefs: PreferencesStore,
  ) {}

  /** Evaluate every rule for a household; insert new alerts and resolve stale ones. Returns newly created alerts. */
  check(householdId: string): Alert[] {
    validateHousehold(householdId);
    const findings = [...this.leaveBy(householdId), ...this.mealFit(householdId), ...this.runouts(householdId)];
    const created: Alert[] = [];
    const now = this.ctx.clock.now();

    this.ctx.db.transaction(() => {
      const insert = this.ctx.db.prepare(
        `INSERT INTO alerts (id, household_id, kind, dedupe_key, title, message, data, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT(household_id, dedupe_key) DO NOTHING`,
      );
      for (const f of findings) {
        const id = newId("alrt");
        const r = insert.run(id, householdId, f.kind, f.key, f.title, f.message, JSON.stringify(f.data), now);
        if (r.changes > 0) created.push({ id, kind: f.kind, title: f.title, message: f.message, data: f.data, status: "pending", created_at: now });
      }
      // Pending alerts whose situation no longer holds (meeting moved back, meal swapped, milk bought) are resolved.
      const live = new Set(findings.map((f) => f.key));
      const pending = this.ctx.db
        .prepare("SELECT id, dedupe_key FROM alerts WHERE household_id = ? AND status = 'pending'")
        .all(householdId) as Array<{ id: string; dedupe_key: string }>;
      const resolve = this.ctx.db.prepare("UPDATE alerts SET status = 'resolved' WHERE id = ?");
      for (const p of pending) if (!live.has(p.dedupe_key)) resolve.run(p.id);
    })();

    for (const a of created) log(`alert ⚑ ${a.kind}`, { household: householdId, message: a.message });
    return created;
  }

  /** Alerts for a household (pending by default). mark_delivered flips the returned pending alerts to delivered. */
  getAlerts(householdId: string, opts: { markDelivered?: boolean; includeDelivered?: boolean } = {}) {
    this.check(householdId);
    const statuses = opts.includeDelivered ? ["pending", "delivered"] : ["pending"];
    const rows = this.ctx.db
      .prepare(
        `SELECT id, kind, title, message, data, status, created_at FROM alerts
         WHERE household_id = ? AND status IN (${statuses.map(() => "?").join(",")}) AND created_at >= ?
         ORDER BY created_at, rowid`,
      )
      .all(householdId, ...statuses, `${addDays(today(this.ctx), -1)}T00:00`) as Array<Omit<Alert, "data"> & { data: string }>;
    const alerts: Alert[] = rows.map((r) => ({ ...r, data: JSON.parse(r.data) as Record<string, unknown> }));
    if (opts.markDelivered) {
      const mark = this.ctx.db.prepare("UPDATE alerts SET status = 'delivered' WHERE id = ? AND status = 'pending'");
      for (const a of alerts) if (a.status === "pending") mark.run(a.id);
    }
    return { household_id: householdId, now: this.ctx.clock.now(), count: alerts.length, alerts };
  }

  /** Mark every current pending alert as delivered (used by the seed so a fresh demo starts quiet). */
  markAllDelivered(householdId: string) {
    this.check(householdId);
    this.ctx.db.prepare("UPDATE alerts SET status = 'delivered' WHERE household_id = ? AND status = 'pending'").run(householdId);
  }

  // ---------- scheduling ----------

  /** Run a check soon (coalesces bursts of writes into one pass). */
  queue(householdId: string) {
    if (this.queued.has(householdId)) return;
    this.queued.add(householdId);
    setImmediate(() => {
      this.queued.delete(householdId);
      this.safeCheck(householdId);
    });
  }

  start(intervalMs = 60_000) {
    this.stop();
    const tick = () => {
      for (const h of listHouseholds(this.ctx)) this.safeCheck(h.id);
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private safeCheck(householdId: string) {
    try {
      this.check(householdId);
    } catch (err) {
      // A DB closed during shutdown or a household deleted mid-check is not worth crashing for.
      log("proactive check failed", { household: householdId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ---------- rules ----------

  /** (a) An upcoming event whose departure is squeezed by the previous event, or is soon. */
  private leaveBy(householdId: string): Finding[] {
    const now = this.ctx.clock.now();
    const out: Finding[] = [];
    for (const e of this.ctx.calendar.listEvents(householdId, today(this.ctx))) {
      if (e.start <= now) continue;
      const lb = this.schedule.computeLeaveBy(householdId, e.id);
      if (!lb.needs_travel) continue;
      const untilLeave = toMinutes(lb.leave_by) - toMinutes(now);
      const squeezed = lb.minutes_free_before_leaving !== null && lb.minutes_free_before_leaving <= SQUEEZE_MINUTES;
      const soon = untilLeave >= 0 && untilLeave <= SOON_MINUTES;
      if (!squeezed && !soon) continue;

      const prior = lb.previous_event;
      const changed = prior && prior.previous_end && prior.previous_end !== prior.end;
      const lead = changed
        ? `Your ${spokenTime(this.ctx.calendar.getEvent(householdId, prior.id)!.start)} ${prior.title} now runs to ${spokenTime(prior.end)}. `
        : "";
      out.push({
        kind: "leave_by",
        key: `leave_by:${e.id}:${lb.leave_by}`,
        title: `Leave by ${lb.leave_by_spoken}`,
        message: `${lead}To reach your ${spokenTime(e.start)} ${e.title} you'll need to leave by ${lb.leave_by_spoken}.`,
        data: {
          event_id: e.id,
          event_title: e.title,
          event_start: e.start,
          location: e.location,
          leave_by: lb.leave_by,
          travel_minutes: lb.travel_minutes,
          buffer_minutes: lb.buffer_minutes,
          previous_event: prior,
          minutes_free_before_leaving: lb.minutes_free_before_leaving,
          conflict: lb.conflict,
          simulated_travel: lb.simulated,
        },
      });
    }
    return out;
  }

  /** (b) Tonight's planned, uncooked dinner takes longer than the longest free stretch. */
  private mealFit(householdId: string): Finding[] {
    const date = today(this.ctx);
    const day = this.meals.getDay(householdId, date);
    if (!day || day.cooked) return [];
    const windows = this.schedule.freeWindows(householdId, date);
    const longest = windows.reduce((m, w) => Math.max(m, w.minutes), 0);
    if (longest >= day.prep_minutes) return [];
    const latest = this.prefs.get(householdId).preferences.latest_dinner_time;
    const best = windows.find((w) => w.minutes === longest);
    return [
      {
        kind: "meal_fit",
        key: `meal_fit:${date}:${day.meal}:${longest}`,
        title: "Tonight's dinner no longer fits",
        message:
          longest > 0
            ? `Tonight's ${day.meal} takes ${day.prep_minutes} minutes, but your longest free stretch before ${spokenTime(latest)} is ${longest} minutes${best ? ` (from ${spokenTime(best.start)})` : ""}.`
            : `Tonight's ${day.meal} takes ${day.prep_minutes} minutes and there's no free time left to cook before ${spokenTime(latest)}.`,
        data: {
          date,
          meal: day.meal,
          prep_minutes: day.prep_minutes,
          longest_free_minutes: longest,
          windows,
          suggested_max_minutes: Math.max(10, Math.min(longest, 20)),
        },
      },
    ];
  }

  /** (c) Staples that are out or predicted to run out within 2 days, grouped into one alert per day. */
  private runouts(householdId: string): Finding[] {
    const { predictions } = this.groceries.predictRunouts(householdId, RUNOUT_DAYS);
    if (predictions.length === 0) return [];
    const date = today(this.ctx);
    const out = predictions.filter((p) => p.status === "out").map((p) => p.item);
    const low = predictions.filter((p) => p.status !== "out");
    const parts = [
      out.length ? `${list(out)} ${out.length === 1 ? "is" : "are"} out` : "",
      low.length ? `${list(low.map((p) => p.item))} will likely run out by ${low.at(-1)!.predicted_runout_date === date ? "today" : low.at(-1)!.predicted_runout_date === addDays(date, 1) ? "tomorrow" : low.at(-1)!.predicted_runout_date}` : "",
    ].filter(Boolean);
    const sentence = parts.join(", and ");
    return [
      {
        kind: "runout",
        key: `runout:${date}:${predictions.map((p) => p.item).sort().join(",")}`,
        title: "Running low",
        message: `${sentence[0]!.toUpperCase()}${sentence.slice(1)}.`,
        data: { predictions },
      },
    ];
  }
}

function list(xs: string[]) {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}
