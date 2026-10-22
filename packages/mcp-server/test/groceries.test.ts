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
    app.groceries.chooseProduct(H, "pesto", "B0CS56H5HL");
    const r = app.groceries.placeOrder(H, o.order_id!, true);
    expect(r).toMatchObject({ status: "placed", simulated: true, eta: `${TODAY}T17:00`, eta_spoken: "5pm" });
    expect(r.confirmation_number).toMatch(/^SIM-[A-Z0-9]{6}$/);
    expect(r.note).toMatch(/Simulated order recorded \(no payment, no card data\)/);
    expect(r.cart_url).toContain("amazon.com/gp/aws/cart/add.html");
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

describe("order realism and robustness", () => {
  it("rounds meal shortfalls up to the usual pack size when there is purchase history", () => {
    const { app } = seeded();
    app.pantry.update(H, [{ item: "baby spinach", quantity: 150, unit: "g", action: "set" }]);
    app.meals.savePlan(H, TODAY, [{ date: TODAY, recipe_id: "chickpea-spinach-curry" }]); // needs 100 g
    app.pantry.update(H, [{ item: "baby spinach", quantity: 90, unit: "g", action: "set" }]); // 10 g short
    const spinach = app.groceries.buildOrder(H).sections.flatMap((s) => s.items).find((i) => i.item === "baby spinach")!;
    expect(spinach).toMatchObject({ quantity: 200, unit: "g" }); // seeded history: 200 g bags
  });

  it("place_order without an order_id places the latest draft (still only with confirmed=true)", () => {
    const { app } = seeded();
    const o = app.groceries.buildOrder(H);
    app.groceries.chooseProduct(H, "pesto", "B0CS56H5HL");
    expect(() => app.groceries.placeOrder(H, undefined, false)).toThrow(/NOT placed/);
    expect(app.groceries.placeOrder(H, undefined, true)).toMatchObject({ order_id: o.order_id, status: "placed" });
    expect(() => app.groceries.placeOrder(H, undefined, true)).toThrow(/no draft order/);
  });
});

describe("store products: your usual, choices and a real Amazon cart", () => {
  it("picks the usual product from purchase history and asks about items without history", () => {
    const { app } = seeded();
    const o = app.groceries.buildOrder(H);
    const items = o.sections.flatMap((s) => s.items);
    expect(items.find((i) => i.item === "whole milk")!.product).toMatchObject({ asin: "B07YSWG9WS", why: "usual", packs: 1 });
    expect(items.find((i) => i.item === "egg")!.product).toMatchObject({ asin: "B07GBM7TZJ", why: "usual", packs: 1 });
    const pesto = items.find((i) => i.item === "pesto")!;
    expect(pesto.product).toBeNull();
    expect(pesto.choices!.map((c) => c.asin)).toEqual(["B0CS56H5HL", "B085DTX3K8", "B08KT6N4SH"]);
    expect(o.needs_choice.map((n) => n.item)).toEqual(["pesto"]);
    expect(o.note).toMatch(/Ask the user which product they want for: pesto/);
  });

  it("builds Amazon's add-to-cart link from chosen products, with an estimated total", () => {
    const { app } = seeded();
    app.groceries.buildOrder(H);
    const r = app.groceries.chooseProduct(H, "pesto", "B0CS56H5HL");
    expect(r.needs_choice).toEqual([]);
    expect(r.cart_url).toMatch(/^https:\/\/www\.amazon\.com\/gp\/aws\/cart\/add\.html\?ASIN\.1=/);
    for (const asin of ["B07YSWG9WS", "B07GBM7TZJ", "B0CS56H5HL"]) expect(r.cart_url).toContain(asin);
    expect(r.cart_url).toMatch(/Quantity\.1=1/);
    expect(r.estimated_total_usd).toBeGreaterThan(8);
  });

  it("refuses to place an order while a product choice is pending", () => {
    const { app } = seeded();
    app.groceries.buildOrder(H);
    expect(() => app.groceries.placeOrder(H, undefined, true)).toThrow(/ask the user which product to buy for pesto/);
  });

  it("validates choices and learns them: a placed choice becomes the usual next time", () => {
    const { app } = seeded();
    app.groceries.buildOrder(H);
    expect(() => app.groceries.chooseProduct(H, "pesto", "B07YSWG9WS")).toThrow(/not a product for pesto/);
    expect(() => app.groceries.chooseProduct(H, "caviar", "B0CS56H5HL")).toThrow(/not in order/);
    app.groceries.chooseProduct(H, "pesto", "B085DTX3K8");
    const placed = app.groceries.placeOrder(H, undefined, true);
    expect(placed.cart_url).toContain("B085DTX3K8");
    app.pantry.update(H, [{ item: "pesto", action: "remove" }]);
    const next = app.groceries.buildOrder(H).sections.flatMap((s) => s.items).find((i) => i.item === "pesto")!;
    expect(next.product).toMatchObject({ asin: "B085DTX3K8", why: "usual" });
  });

  it("adds the product_id column to databases created before it existed", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const Database = (await import("better-sqlite3")).default;
    const { openDb } = await import("../src/db.js");
    const dir = mkdtempSync(join(tmpdir(), "unrush-mig-"));
    const legacy = new Database(join(dir, "old.db"));
    legacy.exec("CREATE TABLE purchases (id INTEGER PRIMARY KEY, household_id TEXT, item TEXT, quantity REAL, unit TEXT, purchased_at TEXT, source TEXT)");
    legacy.close();
    const db = openDb(join(dir, "old.db"));
    const cols = (db.prepare("PRAGMA table_info(purchases)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("product_id");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
