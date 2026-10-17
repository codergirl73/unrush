import { describe, expect, it } from "vitest";
import { H, TODAY, empty, seeded } from "./helpers.js";

describe("predict_runouts", () => {
  it("predicts milk runs out tomorrow from ~6 weeks of purchases, with reasoning", () => {
    const { app } = seeded();
    const r = app.groceries.predictRunouts(H, 2);
    const milk = r.predictions.find((p) => p.item === "whole milk")!;
    expect(milk).toMatchObject({
      status: "running_low",
      predicted_runout_date: "2026-10-24",
      confidence_label: "high",
      current: { quantity: 600, unit: "ml" },
      typical_purchase: { quantity: 2, unit: "l" },
    });
    expect(milk.days_left).toBeGreaterThan(1);
    expect(milk.days_left).toBeLessThan(1.5);
    expect(milk.reasoning).toMatch(/Bought 11× in the last 6 weeks, about every 4 days/);
    expect(milk.reasoning).toMatch(/runs out tomorrow/);
  });

  it("reports eggs as out today and orders predictions soonest first", () => {
    const { app } = seeded();
    const r = app.groceries.predictRunouts(H, 2);
    expect(r.predictions.map((p) => p.item)).toEqual(["egg", "whole milk"]);
    expect(r.predictions[0]).toMatchObject({ status: "out", predicted_runout_date: TODAY, days_left: 0 });
  });

  it("widens with days_ahead and ignores items without enough history", () => {
    const { app } = seeded();
    const week = app.groceries.predictRunouts(H, 7).predictions.map((p) => p.item);
    expect(week).toContain("bread");
    expect(week).not.toContain("basmati rice"); // only 2 purchases
    expect(app.groceries.predictRunouts(H, 7).staples_tracked).toBe(6);
  });

  it("lowers confidence for irregular buying", () => {
    const { app, db } = empty();
    db.prepare("INSERT INTO households (id) VALUES (?)").run(H);
    for (const [d, q] of [["2026-09-01", 1], ["2026-09-03", 1], ["2026-09-20", 1], ["2026-09-22", 1]] as const) {
      app.pantry.logPurchase(H, "orange juice", { quantity: q * 1000, unit: "ml" }, "test", `${d}T10:00`);
    }
    app.pantry.write(H, "orange juice", 500, "ml");
    const p = app.groceries.predictRunouts(H, 60).predictions[0]!;
    expect(p.confidence_label).not.toBe("high");
  });

  it("validates days_ahead", () => {
    const { app } = seeded();
    expect(() => app.groceries.predictRunouts(H, -1)).toThrow(/days_ahead/);
  });
});

describe("build_grocery_order", () => {
  it("combines out-of-stock, predicted run-outs and missing meal ingredients, deduplicated by section", () => {
    const { app } = seeded();
    const o = app.groceries.buildOrder(H);
    expect(o.order_id).toMatch(/^ord_/);
    expect(o.simulated).toBe(true);
    const items = o.sections.flatMap((s) => s.items);
    expect(items.map((i) => i.item).sort()).toEqual(["egg", "pesto", "whole milk"]);
    const egg = items.find((i) => i.item === "egg")!;
    // Out of stock AND needed for Sunday's omelette → one line, the larger quantity, both reasons.
    expect(egg).toMatchObject({ quantity: 12, unit: "count", section: "Dairy & Eggs" });
    expect(egg.reasons).toEqual(expect.arrayContaining(["out of stock", "for sunday's Veggie omelette & toast"]));
    expect(items.find((i) => i.item === "whole milk")).toMatchObject({ quantity: 2, unit: "l", reasons: ["predicted to run out 2026-10-24"] });
    expect(o.sections.map((s) => s.section)).toEqual(["Dairy & Eggs", "Spices & Condiments"]);
    expect(o.read_back).toBe("12 eggs, 2 l whole milk and 100 g pesto");
  });

  it("returns no order when nothing is needed", () => {
    const { app } = empty();
    expect(app.groceries.buildOrder(H)).toMatchObject({ order_id: null, item_count: 0 });
  });
});

describe("place_order", () => {
  it("REFUSES without explicit confirmation and changes nothing", () => {
    const { app, db } = seeded();
    const o = app.groceries.buildOrder(H);
    expect(() => app.groceries.placeOrder(H, o.order_id!, false)).toThrow(/NOT placed.*explicitly said yes/);
    expect(() => app.groceries.placeOrder(H, o.order_id!, "yes" as unknown as boolean)).toThrow(/NOT placed/);
    expect(app.groceries.getOrder(H, o.order_id!).status).toBe("draft");
    const n = db.prepare("SELECT COUNT(*) AS n FROM purchases WHERE source LIKE 'order:%'").get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("with confirmed=true returns a simulated confirmation, stocks the pantry and teaches the predictor", () => {
    const { app } = seeded();
    const o = app.groceries.buildOrder(H);
    const r = app.groceries.placeOrder(H, o.order_id!, true);
    expect(r).toMatchObject({ status: "placed", simulated: true, eta: `${TODAY}T17:00`, eta_spoken: "5pm" });
    expect(r.confirmation_number).toMatch(/^SIM-[A-Z0-9]{6}$/);
    expect(r.note).toMatch(/SIMULATED.*no card data/);
    expect(app.pantry.row(H, "egg")).toEqual({ quantity: 12, unit: "count" });
    expect(app.pantry.row(H, "whole milk")).toEqual({ quantity: 2600, unit: "ml" });
    expect(app.groceries.predictRunouts(H, 2).predictions).toEqual([]);
    expect(() => app.groceries.placeOrder(H, o.order_id!, true)).toThrow(/already placed/);
  });

  it("explains unknown orders", () => {
    const { app } = seeded();
    expect(() => app.groceries.placeOrder(H, "ord_nope", true)).toThrow(/build_grocery_order/);
  });
});

describe("get_order", () => {
  it("returns the latest order (or null) with its read-back", () => {
    const { app } = seeded();
    expect(app.groceries.findOrder(H).order).toBeNull();
    const o = app.groceries.buildOrder(H);
    expect(app.groceries.findOrder(H).order).toMatchObject({ order_id: o.order_id, status: "draft", read_back: o.read_back });
    expect(() => app.groceries.findOrder(H, "ord_nope")).toThrow(/build_grocery_order/);
  });
});
