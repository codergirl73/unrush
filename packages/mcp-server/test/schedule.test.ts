import { describe, expect, it } from "vitest";
import { SimulatedTravel } from "../src/providers/travel.js";
import { H, TODAY, lateMeeting, seeded } from "./helpers.js";

describe("get_schedule", () => {
  it("returns today's simulated events with leave-by for events that need travel", () => {
    const { app } = seeded();
    const s = app.schedule.get(H);
    expect(s.date).toBe(TODAY);
    expect(s.simulated).toBe(true);
    expect(s.events.map((e) => e.id)).toEqual(["evt-lecture", "evt-project-sync", "evt-study-group"]);
    expect(s.events.find((e) => e.id === "evt-project-sync")!.leave_by).toBeNull(); // online
    expect(s.events.find((e) => e.id === "evt-study-group")!.leave_by).toBe(`${TODAY}T19:05`);
  });

  it("rejects an invalid date", () => {
    const { app } = seeded();
    expect(() => app.schedule.get(H, "23/10/2026")).toThrow(/Invalid date/);
  });
});

describe("compute_leave_by", () => {
  it("is event start − simulated travel − buffer", () => {
    const { app } = seeded();
    const lb = app.schedule.computeLeaveBy(H, "evt-study-group");
    expect(lb).toMatchObject({
      travel_minutes: 20,
      buffer_minutes: 5,
      leave_by: `${TODAY}T19:05`,
      leave_by_spoken: "7:05pm",
      simulated: true,
      conflict: false,
      minutes_free_before_leaving: 65,
      previous_event: { id: "evt-project-sync", end: `${TODAY}T18:00` },
    });
    expect(lb.explanation).toContain("leave by 7:05pm");
  });

  it("shrinks the free time when the previous meeting runs late, and flags overlap", () => {
    const { app } = seeded();
    lateMeeting(app, "19:00");
    expect(app.schedule.computeLeaveBy(H, "evt-study-group")).toMatchObject({ minutes_free_before_leaving: 5, conflict: false });
    lateMeeting(app, "19:15");
    const lb = app.schedule.computeLeaveBy(H, "evt-study-group");
    expect(lb).toMatchObject({ minutes_free_before_leaving: -10, conflict: true });
    expect(lb.explanation).toContain("10 min after you'd need to leave");
  });

  it("respects the household's buffer preference", () => {
    const { app } = seeded();
    app.prefs.set(H, { leave_buffer_minutes: 10 });
    expect(app.schedule.computeLeaveBy(H, "evt-study-group").leave_by).toBe(`${TODAY}T19:00`);
  });

  it("needs no travel for online events", () => {
    const { app } = seeded();
    expect(app.schedule.computeLeaveBy(H, "evt-project-sync")).toMatchObject({ needs_travel: false, travel_minutes: 0, leave_by: `${TODAY}T17:30` });
  });

  it("explains unknown event ids", () => {
    const { app } = seeded();
    expect(() => app.schedule.computeLeaveBy(H, "nope")).toThrow(/get_schedule/);
  });
});

describe("add_or_update_event", () => {
  it("updates by id and remembers the previous end time", () => {
    const { app } = seeded();
    const r = lateMeeting(app);
    expect(r.created).toBe(false);
    expect(r.event).toMatchObject({ end: `${TODAY}T19:00`, previous_end: `${TODAY}T18:00` });
  });

  it("creates new events with a generated id", () => {
    const { app } = seeded();
    const r = app.schedule.addOrUpdate(H, { title: "Dentist", start: `${TODAY}T12:00`, end: `${TODAY}T12:30`, location: "Downtown" });
    expect(r.created).toBe(true);
    expect(r.event.id).toMatch(/^evt_/);
  });

  it("validates times", () => {
    const { app } = seeded();
    expect(() => app.schedule.addOrUpdate(H, { title: "x", start: `${TODAY}T12:00`, end: `${TODAY}T11:00` })).toThrow(/end must be after start/);
    expect(() => app.schedule.addOrUpdate(H, { title: "x", start: "tomorrow 5pm", end: `${TODAY}T11:00` })).toThrow(/YYYY-MM-DDTHH:MM/);
  });
});

describe("free windows for cooking", () => {
  it("subtracts events and travel from the evening", () => {
    const { app } = seeded();
    expect(app.schedule.freeWindows(H).map((w) => w.minutes)).toEqual([30, 65, 40]);
    lateMeeting(app);
    expect(app.schedule.freeWindows(H).map((w) => [w.start.slice(11), w.minutes])).toEqual([
      ["17:00", 30],
      ["19:00", 5],
      ["20:50", 40],
    ]);
  });

  it("starts from now when the evening is under way", () => {
    const { app } = seeded(`${TODAY}T20:55`);
    expect(app.schedule.freeWindows(H)).toEqual([{ start: `${TODAY}T20:55`, end: `${TODAY}T21:30`, minutes: 35 }]);
  });
});

describe("SimulatedTravel", () => {
  it("is deterministic per place", () => {
    const t = new SimulatedTravel();
    expect(t.estimate("Home", "City Library").minutes).toBe(20);
    expect(t.estimate("Home", "Gym").minutes).toBe(10);
    expect(t.estimate("Home", "Somewhere new").minutes).toBe(20);
    expect(t.estimate("Home", "Online").minutes).toBe(0);
    expect(t.estimate("Home", null).minutes).toBe(0);
  });
});
