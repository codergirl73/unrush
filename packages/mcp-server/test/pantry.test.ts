import { describe, expect, it } from "vitest";
import { H, empty, seeded } from "./helpers.js";

describe("get_pantry / update_pantry", () => {
  it("records \"we're out of eggs\" as ran-out without needing a quantity", () => {
    const { app, db } = seeded();
    app.pantry.update(H, [{ item: "Eggs", quantity: 6, action: "add" }]);
    const r = app.pantry.update(H, [{ item: "eggs", action: "remove" }]);
    expect(r.results[0]).toMatchObject({ item: "egg", status: "ok", after: null, message: "marked as out" });
    expect(app.pantry.get(H).items.find((i) => i.item === "egg")).toBeUndefined();
    const logged = db.prepare("SELECT COUNT(*) AS n FROM consumption_log WHERE household_id = ? AND item = 'egg' AND reason = 'ran out'").get(H) as { n: number };
    expect(logged.n).toBe(2); // seeded this morning + now
  });

  it("logs adds as purchases (so predictions learn) and normalizes names/units", () => {
    const { app, db } = empty();
    const r = app.pantry.update(H, [{ item: " Whole Milks ", quantity: 1, unit: "l", action: "add" }]);
    expect(r.pantry).toEqual([expect.objectContaining({ item: "whole milk", quantity: 1, unit: "l", section: "Dairy & Eggs" })]);
    const p = db.prepare("SELECT item, quantity, unit, source FROM purchases").all();
    expect(p).toEqual([{ item: "whole milk", quantity: 1000, unit: "ml", source: "manual" }]);
  });

  it("reports unit mismatches per change and still applies the valid ones", () => {
    const { app } = seeded();
    const r = app.pantry.update(H, [
      { item: "whole milk", quantity: 2, unit: "count", action: "add" },
      { item: "lemon", quantity: 2, action: "add" },
    ]);
    expect(r.applied).toBe(1);
    expect(r.results[0]).toMatchObject({ status: "error", message: expect.stringContaining('"ml"') });
  });

  it("rejects bad input with a useful message", () => {
    const { app } = seeded();
    expect(() => app.pantry.update(H, [])).toThrow(/non-empty/);
    expect(() => app.pantry.get("bad id!")).toThrow(/Invalid household_id/);
    expect(app.pantry.update(H, [{ item: "rice", quantity: -1, action: "add" }]).results[0]!.status).toBe("error");
  });
});

describe("preferences", () => {
  it("partially updates and validates times", () => {
    const { app } = seeded();
    const r = app.prefs.set(H, { latest_dinner_time: "22:00" });
    expect(r.preferences).toMatchObject({ latest_dinner_time: "22:00", usual_dinner_time: "18:15", household_size: 2 });
    expect(() => app.prefs.set(H, { usual_dinner_time: "7pm" })).toThrow(/24h time/);
    expect(() => app.prefs.set(H, { weekday_rules: { funday: "x" } as never })).toThrow(/Unknown weekday/);
  });
});
