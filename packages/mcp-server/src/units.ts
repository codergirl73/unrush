/**
 * Unit normalization. Every quantity is stored in a canonical base unit so the
 * pantry and meal-plan ingredients can be compared and subtracted:
 *   mass   -> "g"
 *   volume -> "ml"
 *   count  -> "count"
 * Units we don't recognise (e.g. "can", "bunch", "jar") are kept as their own
 * canonical unit with factor 1, so "2 can" + "1 can" still works.
 */

export interface Canonical {
  quantity: number;
  unit: string;
}

const FACTORS: Record<string, { unit: string; factor: number }> = {};

function define(unit: string, factor: number, aliases: string[]) {
  for (const a of aliases) FACTORS[a] = { unit, factor };
}

define("g", 1, ["g", "gram", "grams", "gr"]);
define("g", 1000, ["kg", "kilo", "kilos", "kilogram", "kilograms"]);
define("g", 28.3495, ["oz", "ounce", "ounces"]);
define("g", 453.592, ["lb", "lbs", "pound", "pounds"]);
define("ml", 1, ["ml", "milliliter", "milliliters", "millilitre", "millilitres"]);
define("ml", 1000, ["l", "liter", "liters", "litre", "litres"]);
define("ml", 240, ["cup", "cups"]);
define("ml", 15, ["tbsp", "tablespoon", "tablespoons"]);
define("ml", 5, ["tsp", "teaspoon", "teaspoons"]);
define("ml", 29.5735, ["fl oz", "floz", "fluid ounce", "fluid ounces"]);
define("ml", 946.353, ["quart", "quarts", "qt"]);
define("ml", 3785.41, ["gallon", "gallons", "gal"]);
define("count", 1, ["", "count", "each", "ea", "pc", "pcs", "piece", "pieces", "item", "items", "whole", "x", "unit", "units"]);
define("count", 12, ["dozen", "dozens"]);

const SINGULAR_UNITS: Record<string, string> = {
  cans: "can",
  jars: "jar",
  bunches: "bunch",
  heads: "head",
  cloves: "clove",
  loaves: "loaf",
  bags: "bag",
  boxes: "box",
  packs: "pack",
  packages: "pack",
  package: "pack",
  bottles: "bottle",
  slices: "slice",
  sticks: "stick",
  blocks: "block",
  cartons: "carton",
  tins: "tin",
};

export function normalizeUnitName(unit: string | undefined | null): string {
  const u = (unit ?? "").trim().toLowerCase().replace(/\.$/, "");
  return SINGULAR_UNITS[u] ?? u;
}

/** Convert a quantity in any unit to its canonical base unit. */
export function toCanonical(quantity: number, unit?: string | null): Canonical {
  const u = normalizeUnitName(unit);
  const f = FACTORS[u];
  if (f) return { quantity: round(quantity * f.factor), unit: f.unit };
  return { quantity: round(quantity), unit: u };
}

/** True when two canonical units can be added/subtracted. */
export function compatible(a: string, b: string): boolean {
  return a === b;
}

/** Render a canonical quantity in a friendlier unit for humans / speech. */
export function humanize(quantity: number, unit: string): { quantity: number; unit: string } {
  if (unit === "g" && quantity >= 1000) return { quantity: round(quantity / 1000), unit: "kg" };
  if (unit === "ml" && quantity >= 1000) return { quantity: round(quantity / 1000), unit: "l" };
  return { quantity: round(quantity), unit };
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}
