import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { seedDemo } from "../src/seed.js";
import { Unrush } from "../src/service.js";
import { fixedClock } from "../src/time.js";
import { H, NOW, TODAY, lateMeeting, seeded } from "./helpers.js";

describe("proactive engine", () => {
  it("starts quiet after seeding", () => {
    const { app } = seeded();
    expect(app.proactive.getAlerts(H).alerts).toEqual([]);
  });

  it("speaks up when the late meeting lands: leave-by + dinner no longer fits", () => {
    const { app } = seeded();
    lateMeeting(app);
    const { alerts } = app.proactive.getAlerts(H);
    expect(alerts.map((a) => a.kind)).toEqual(["leave_by", "meal_fit"]);
    expect(alerts[0]!.message).toBe(
      "Your 5:30pm Project sync now runs to 7pm. To reach your 7:30pm Study group you'll need to leave by 7:05pm.",
    );
    expect(alerts[0]!.data).toMatchObject({ leave_by: `${TODAY}T19:05`, minutes_free_before_leaving: 5 });
    expect(alerts[1]!.message).toBe(
      "Tonight's Chicken curry with rice takes 45 minutes, but your longest free stretch before 9:30pm is 40 minutes (from 8:50pm).",
    );
    expect(alerts[1]!.data).toMatchObject({ prep_minutes: 45, longest_free_minutes: 40, suggested_max_minutes: 15 });
  });

  it("does not repeat itself, and mark_delivered hands each alert out once", () => {
    const { app } = seeded();
    lateMeeting(app);
    expect(app.proactive.check(H)).toEqual([]); // already recorded by the change hook
    expect(app.proactive.getAlerts(H, { markDelivered: true }).count).toBe(2);
    expect(app.proactive.getAlerts(H).count).toBe(0);
    expect(app.proactive.getAlerts(H, { includeDelivered: true }).count).toBeGreaterThanOrEqual(2);
  });

  it("resolves alerts when the problem goes away", () => {
    const { app } = seeded();
    lateMeeting(app);
    app.meals.savePlan(H, TODAY, [{ date: TODAY, recipe_id: "tomato-garlic-spaghetti" }]);
    expect(app.proactive.getAlerts(H).alerts.map((a) => a.kind)).toEqual(["leave_by"]);
    lateMeeting(app, "18:00"); // meeting back to normal
    expect(app.proactive.getAlerts(H).alerts).toEqual([]);
  });

  it("warns when a staple is out or runs out within 2 days", () => {
    const db = openDb(":memory:");
    const clock = fixedClock(NOW);
    seedDemo(db, H, { clock });
    db.prepare("DELETE FROM alerts").run(); // forget the seed's "already known" state
    const app = new Unrush(db, { clock, proactiveOnChange: "off" });
    const created = app.proactive.check(H);
    const runout = created.find((a) => a.kind === "runout")!;
    expect(runout.message).toBe("Egg is out, and whole milk will likely run out by tomorrow.");
    expect((runout.data.predictions as unknown[]).length).toBe(2);
  });

  it("alerts shortly before a departure even without a change", () => {
    const { app, clock } = seeded();
    clock.set(`${TODAY}T18:10`);
    const { alerts } = app.proactive.getAlerts(H);
    expect(alerts.find((a) => a.kind === "leave_by")!.message).toBe("To reach your 7:30pm Study group you'll need to leave by 7:05pm.");
  });
});

describe("proactive engine: repeated changes", () => {
  it("raises a fresh leave-by alert when the meeting moves again, and says when it overlaps", () => {
    const { app } = seeded();
    lateMeeting(app, "19:00");
    app.proactive.getAlerts(H, { markDelivered: true });
    lateMeeting(app, "19:15");
    const { alerts } = app.proactive.getAlerts(H);
    expect(alerts.map((a) => a.kind)).toEqual(["leave_by"]);
    expect(alerts[0]!.message).toBe(
      "Your 5:30pm Project sync now runs to 7:15pm. To reach your 7:30pm Study group you'll need to leave by 7:05pm. That's 10 minutes before Project sync ends.",
    );
  });
});
