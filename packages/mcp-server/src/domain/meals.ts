/** Meal plans, quick-meal suggestions from the pantry, and cooking (which subtracts ingredients). */
import { mondayOf, parseIsoDate, weekDates, weekdayOf } from "../dates.js";
import { UnrushError } from "../errors.js";
import { normalizeItemName } from "../names.js";
import { compatible, humanize, round, toCanonical } from "../units.js";
import { ensureHousehold, today, validateHousehold, type Ctx } from "./ctx.js";
import type { Pantry } from "./pantry.js";
import type { Preferences, PreferencesStore } from "./preferences.js";
import { RECIPES, recipeById, type RecipeIngredient } from "./recipes.js";

export type Ingredient = RecipeIngredient;

export interface PlanDayInput {
  date: string;
  /** Fill meal, prep time and ingredients from the recipe library. */
  recipe_id?: string;
  meal?: string;
  prep_minutes?: number;
  ingredients?: Ingredient[];
}

export interface PlanDay {
  date: string;
  weekday: string;
  meal: string;
  prep_minutes: number;
  ingredients: Ingredient[];
  previous_meal: string | null;
  cooked: boolean;
}

// Ingredients that break a vegetarian / vegan rule (checked by keyword).
const MEAT_WORDS = [
  "chicken", "beef", "pork", "bacon", "sausage", "turkey", "lamb", "ham", "salmon", "tuna",
  "shrimp", "prawn", "cod", "fish", "anchov", "mince", "steak", "chorizo", "pepperoni", "gelatin",
];
const ANIMAL_WORDS = [...MEAT_WORDS, "egg", "milk", "cheese", "butter", "yogurt", "yoghurt", "cream", "honey", "ghee", "paneer"];
const PLANT_BASED = /(oat|almond|soy|coconut|rice|cashew) milk|peanut butter|nut butter|vegan|egg noodle/;

export class Meals {
  constructor(
    private readonly ctx: Ctx,
    private readonly pantry: Pantry,
    private readonly prefs: PreferencesStore,
  ) {}

  /**
   * Upsert planned dinners. mode "replace" clears the week first; "merge" (default)
   * touches only the given dates. When a date's meal changes, the old one is kept as
   * previous_meal so the UI can show "before → after".
   */
  savePlan(householdId: string, weekStartInput: string, days: PlanDayInput[], mode: "merge" | "replace" = "merge") {
    ensureHousehold(this.ctx, householdId);
    const weekStart = mondayOf(checkDate(weekStartInput, "week_start"));
    const dates = new Set(weekDates(weekStart));
    if (!Array.isArray(days) || days.length === 0) throw new UnrushError("days must contain at least one {date, meal, prep_minutes, ingredients}.");

    const resolved = days.map((d) => this.resolveDay(d, weekStart, dates));
    const seen = new Set<string>();
    for (const d of resolved) {
      if (seen.has(d.date)) throw new UnrushError(`Date ${d.date} appears more than once; plan one dinner per day.`);
      seen.add(d.date);
    }

    const prefs = this.prefs.get(householdId).preferences;
    const warnings: string[] = [];
    this.ctx.db.transaction(() => {
      if (mode === "replace") {
        this.ctx.db.prepare("DELETE FROM meal_plan_days WHERE household_id = ? AND week_start = ?").run(householdId, weekStart);
      }
      const existing = this.ctx.db.prepare("SELECT meal FROM meal_plan_days WHERE household_id = ? AND date = ?");
      const upsert = this.ctx.db.prepare(
        `INSERT INTO meal_plan_days (household_id, date, week_start, meal, prep_minutes, ingredients, previous_meal, cooked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(household_id, date) DO UPDATE SET meal = excluded.meal, prep_minutes = excluded.prep_minutes,
           ingredients = excluded.ingredients, week_start = excluded.week_start, previous_meal = excluded.previous_meal, cooked_at = NULL`,
      );
      for (const d of resolved) {
        const before = existing.get(householdId, d.date) as { meal: string } | undefined;
        const previous = before && before.meal !== d.meal ? before.meal : null;
        upsert.run(householdId, d.date, weekStart, d.meal, d.prep_minutes, JSON.stringify(d.ingredients), previous);
        warnings.push(...ruleWarnings(d.date, d.meal, d.ingredients, prefs));
      }
    })();
    this.ctx.changed(householdId, "plan");
    return { ...this.getPlan(householdId, weekStart), warnings };
  }

  private resolveDay(d: PlanDayInput, weekStart: string, dates: Set<string>) {
    checkDate(d.date, "date");
    if (!dates.has(d.date)) {
      throw new UnrushError(`Date ${d.date} is outside the week starting ${weekStart} (${weekStart} … ${[...dates][6]}).`);
    }
    const recipe = d.recipe_id ? recipeById(d.recipe_id) : undefined;
    if (d.recipe_id && !recipe) {
      throw new UnrushError(`Unknown recipe_id "${d.recipe_id}". Use an id returned by suggest_quick_meal, or give meal + ingredients.`);
    }
    const meal = (d.meal ?? recipe?.name ?? "").trim();
    if (!meal) throw new UnrushError(`Meal name is empty for ${d.date}. Give meal (or recipe_id).`);
    const prep = d.prep_minutes ?? recipe?.prep_minutes;
    if (typeof prep !== "number" || !Number.isInteger(prep) || prep < 1 || prep > 600) {
      throw new UnrushError(`prep_minutes for ${d.date} must be a whole number of minutes (1-600).`);
    }
    const raw = d.ingredients ?? recipe?.ingredients;
    if (!Array.isArray(raw)) throw new UnrushError(`ingredients must be an array for ${d.date}.`);
    const ingredients = raw
      .filter((i) => i && i.item?.trim())
      .map((i) => ({
        item: normalizeItemName(i.item),
        ...(typeof i.quantity === "number" ? { quantity: i.quantity } : {}),
        ...(i.unit ? { unit: i.unit.trim().toLowerCase() } : {}),
      }));
    return { date: d.date, meal, prep_minutes: prep, ingredients };
  }

  getPlan(householdId: string, weekStartInput: string) {
    validateHousehold(householdId);
    const weekStart = mondayOf(checkDate(weekStartInput, "week_start"));
    const rows = this.ctx.db
      .prepare("SELECT * FROM meal_plan_days WHERE household_id = ? AND week_start = ? ORDER BY date")
      .all(householdId, weekStart) as PlanRow[];
    return { household_id: householdId, week_start: weekStart, days: rows.map(toDay) };
  }

  getDay(householdId: string, date: string): PlanDay | undefined {
    const row = this.ctx.db.prepare("SELECT * FROM meal_plan_days WHERE household_id = ? AND date = ?").get(householdId, date) as
      | PlanRow
      | undefined;
    return row ? toDay(row) : undefined;
  }

  /** Uncooked planned days in [from, to] inclusive. */
  daysBetween(householdId: string, from: string, to: string): PlanDay[] {
    const rows = this.ctx.db
      .prepare("SELECT * FROM meal_plan_days WHERE household_id = ? AND date >= ? AND date <= ? AND cooked_at IS NULL ORDER BY date")
      .all(householdId, from, to) as PlanRow[];
    return rows.map(toDay);
  }

  /**
   * Recipes from the library that take ≤ max_minutes, filtered by diet/allergy rules,
   * ranked by fewest missing pantry items, then by prep time.
   */
  suggestQuickMeal(householdId: string, maxMinutes: number, limit = 3) {
    validateHousehold(householdId);
    if (!Number.isFinite(maxMinutes) || maxMinutes < 5) throw new UnrushError("max_minutes must be at least 5.");
    const prefs = this.prefs.get(householdId).preferences;
    const date = today(this.ctx, householdId);
    const candidates = RECIPES.filter((r) => r.prep_minutes <= maxMinutes)
      .filter((r) => ruleWarnings(date, r.name, r.ingredients, prefs).length === 0)
      .map((r) => {
        const missing = r.ingredients
          .map((ing) => {
            const need = typeof ing.quantity === "number" ? toCanonical(ing.quantity, ing.unit) : { quantity: null, unit: toCanonical(1, ing.unit).unit };
            const item = normalizeItemName(ing.item);
            const short = this.pantry.shortfall(householdId, item, need.quantity, need.unit);
            return short ? { item, ...(short.quantity === null ? { quantity: null, unit: null } : humanize(short.quantity, short.unit)) } : null;
          })
          .filter((m): m is NonNullable<typeof m> => m !== null);
        return {
          recipe_id: r.id,
          name: r.name,
          prep_minutes: r.prep_minutes,
          ingredients: r.ingredients,
          missing,
          can_make_now: missing.length === 0,
        };
      })
      .sort((a, b) => a.missing.length - b.missing.length || a.prep_minutes - b.prep_minutes || a.name.localeCompare(b.name));

    return {
      household_id: householdId,
      max_minutes: maxMinutes,
      considered: candidates.length,
      suggestions: candidates.slice(0, Math.max(1, limit)),
      note:
        candidates.length === 0
          ? `No recipe in the library takes ${maxMinutes} minutes or less while matching the household's rules.`
          : "To swap it into the plan, call save_meal_plan with {date, recipe_id}.",
    };
  }

  /** Subtract a planned meal's ingredients from the pantry and log consumption. Idempotent per date. */
  markCooked(householdId: string, date: string) {
    validateHousehold(householdId);
    checkDate(date, "date");
    const day = this.getDay(householdId, date);
    if (!day) {
      throw new UnrushError(`No meal is planned for ${date}. Use get_meal_plan to see planned dates, or update_pantry to record what was used.`);
    }
    if (day.cooked) {
      return { household_id: householdId, date, meal: day.meal, already_cooked: true, pantry_changes: [], notes: [`${day.meal} was already marked cooked; pantry unchanged.`] };
    }
    const changes: Array<{ item: string; before: { quantity: number; unit: string }; after: { quantity: number; unit: string } | null }> = [];
    const notes: string[] = [];

    this.ctx.db.transaction(() => {
      for (const ing of day.ingredients) {
        const have = this.pantry.row(householdId, ing.item);
        if (!have) {
          notes.push(`${ing.item} wasn't in the pantry.`);
          continue;
        }
        if (typeof ing.quantity !== "number") {
          notes.push(`${ing.item}: no quantity in the recipe, left unchanged.`);
          continue;
        }
        const need = toCanonical(ing.quantity, ing.unit);
        if (!compatible(have.unit, need.unit)) {
          notes.push(`${ing.item}: recipe uses ${need.unit} but the pantry tracks ${have.unit}; left unchanged.`);
          continue;
        }
        const left = round(have.quantity - need.quantity);
        this.pantry.write(householdId, ing.item, left, have.unit);
        this.pantry.logConsumption(householdId, ing.item, { quantity: Math.min(need.quantity, have.quantity), unit: have.unit }, `cooked ${day.meal}`);
        changes.push({ item: ing.item, before: humanize(have.quantity, have.unit), after: left > 0 ? humanize(left, have.unit) : null });
      }
      this.ctx.db.prepare("UPDATE meal_plan_days SET cooked_at = ? WHERE household_id = ? AND date = ?").run(this.ctx.now(householdId), householdId, date);
    })();
    this.ctx.changed(householdId, "pantry");
    return { household_id: householdId, date, meal: day.meal, already_cooked: false, pantry_changes: changes, notes };
  }
}

type PlanRow = {
  date: string;
  meal: string;
  prep_minutes: number;
  ingredients: string;
  previous_meal: string | null;
  cooked_at: string | null;
};

function toDay(r: PlanRow): PlanDay {
  return {
    date: r.date,
    weekday: weekdayOf(r.date),
    meal: r.meal,
    prep_minutes: r.prep_minutes,
    ingredients: JSON.parse(r.ingredients) as Ingredient[],
    previous_meal: r.previous_meal,
    cooked: r.cooked_at !== null,
  };
}

export function checkDate(s: string, field: string): string {
  try {
    parseIsoDate(s);
    return s;
  } catch {
    throw new UnrushError(`Invalid ${field} "${s}". Use an ISO date like 2026-10-23.`);
  }
}

export function ruleWarnings(date: string, meal: string, ingredients: Ingredient[], prefs: Preferences): string[] {
  const out: string[] = [];
  const day = weekdayOf(date);
  const rules = [...prefs.diets, prefs.weekday_rules[day] ?? ""].filter(Boolean).join(" ");
  const names = ingredients.map((i) => normalizeItemName(i.item));
  const hits = (words: string[]) => names.filter((n) => !PLANT_BASED.test(n) && words.some((w) => n.includes(w)));

  if (/vegan/.test(rules)) {
    const bad = hits(ANIMAL_WORDS);
    if (bad.length) out.push(`${day} ${date} (${meal}) should be vegan but includes: ${bad.join(", ")}.`);
  } else if (/vegetarian|meatless|veggie/.test(rules)) {
    const bad = hits(MEAT_WORDS);
    if (bad.length) out.push(`${day} ${date} (${meal}) should be vegetarian but includes: ${bad.join(", ")}.`);
  }
  for (const allergen of prefs.allergies) {
    const a = normalizeItemName(allergen);
    const bad = names.filter((n) => n.includes(a));
    if (bad.length) out.push(`${day} ${date} (${meal}) contains allergen "${allergen}": ${bad.join(", ")}.`);
  }
  for (const dislike of prefs.dislikes) {
    const d = normalizeItemName(dislike);
    if (names.some((n) => n.includes(d))) out.push(`${day} ${date} (${meal}) includes disliked "${dislike}".`);
  }
  return out;
}
