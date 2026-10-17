import { describe, expect, it } from "vitest";
import { H, TODAY, seeded } from "./helpers.js";

const WEEK = "2026-10-19";

describe("suggest_quick_meal", () => {
  it("ranks recipes makeable from the pantry first, then by prep time", () => {
    const { app } = seeded();
    const r = app.meals.suggestQuickMeal(H, 15, 5);
    expect(r.suggestions.every((s) => s.prep_minutes <= 15)).toBe(true);
    expect(r.suggestions[0]).toMatchObject({ recipe_id: "tomato-garlic-spaghetti", can_make_now: true, missing: [] });
    const missing = r.suggestions.map((s) => s.missing.length);
    expect(missing).toEqual([...missing].sort((a, b) => a - b));
    // Eggs are out, so the omelette needs them.
    const omelette = app.meals.suggestQuickMeal(H, 15, 10).suggestions.find((s) => s.recipe_id === "spinach-omelette")!;
    expect(omelette.missing).toEqual([{ item: "egg", quantity: 4, unit: "count" }]);
  });

  it("respects allergies and diet rules", () => {
    const { app } = seeded();
    app.prefs.set(H, { allergies: ["cheddar"] });
    const ids = app.meals.suggestQuickMeal(H, 20, 10).suggestions.map((s) => s.recipe_id);
    expect(ids).not.toContain("tomato-garlic-spaghetti");
    app.prefs.set(H, { allergies: [], diets: ["vegan"] });
    const vegan = app.meals.suggestQuickMeal(H, 45, 10).suggestions.map((s) => s.recipe_id);
    expect(vegan).toEqual(expect.arrayContaining(["chickpea-spinach-curry", "veggie-noodle-stir-fry"]));
    expect(vegan).not.toContain("chicken-curry");
  });

  it("rejects silly limits", () => {
    const { app } = seeded();
    expect(() => app.meals.suggestQuickMeal(H, 2)).toThrow(/at least 5/);
  });
});

describe("get_meal_plan / save_meal_plan", () => {
  it("has tonight's 45-minute curry from the seed", () => {
    const { app } = seeded();
    const tonight = app.meals.getPlan(H, TODAY).days.find((d) => d.date === TODAY)!;
    expect(tonight).toMatchObject({ meal: "Chicken curry with rice", prep_minutes: 45, cooked: false, previous_meal: null });
  });

  it("swaps a day by recipe_id and remembers what it replaced", () => {
    const { app } = seeded();
    const r = app.meals.savePlan(H, WEEK, [{ date: TODAY, recipe_id: "tomato-garlic-spaghetti" }]);
    expect(r.days.find((d) => d.date === TODAY)).toMatchObject({
      meal: "Tomato & garlic spaghetti",
      prep_minutes: 15,
      previous_meal: "Chicken curry with rice",
    });
    expect(r.days).toHaveLength(7); // merge keeps the rest of the week
  });

  it("validates days", () => {
    const { app } = seeded();
    expect(() => app.meals.savePlan(H, WEEK, [{ date: "2026-11-01", meal: "x", prep_minutes: 10, ingredients: [] }])).toThrow(/outside the week/);
    expect(() => app.meals.savePlan(H, WEEK, [{ date: TODAY, recipe_id: "nope" }])).toThrow(/Unknown recipe_id/);
    expect(() => app.meals.savePlan(H, WEEK, [{ date: TODAY, meal: "Toast", ingredients: [] }])).toThrow(/prep_minutes/);
  });

  it("warns about rule violations", () => {
    const { app } = seeded();
    app.prefs.set(H, { weekday_rules: { friday: "vegetarian" } });
    const r = app.meals.savePlan(H, WEEK, [{ date: TODAY, recipe_id: "chicken-curry" }]);
    expect(r.warnings[0]).toMatch(/vegetarian.*chicken thigh/);
  });
});

describe("mark_meal_cooked", () => {
  it("subtracts ingredients, logs consumption, and is idempotent", () => {
    const { app, db } = seeded();
    const r = app.meals.markCooked(H, TODAY);
    expect(r.already_cooked).toBe(false);
    expect(r.pantry_changes).toContainEqual({ item: "chicken thigh", before: { quantity: 600, unit: "g" }, after: { quantity: 100, unit: "g" } });
    const coconut = r.pantry_changes.find((c) => c.item === "coconut milk")!;
    expect(coconut.after).toEqual({ quantity: 1, unit: "can" });
    const n = db.prepare("SELECT COUNT(*) AS n FROM consumption_log WHERE reason LIKE 'cooked%'").get() as { n: number };
    expect(n.n).toBe(6);
    expect(app.meals.markCooked(H, TODAY)).toMatchObject({ already_cooked: true, pantry_changes: [] });
  });

  it("explains a missing plan", () => {
    const { app } = seeded();
    expect(() => app.meals.markCooked(H, "2026-12-01")).toThrow(/No meal is planned/);
  });
});
