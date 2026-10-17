/**
 * Seed (and fully reset) the demo household: a busy student flat with ~6 weeks of
 * grocery history, eggs out, milk low, a week's dinner plan with tonight's 45-minute
 * curry, and a calendar with 7:30pm plans. Everything is relative to "today" on the
 * Unrush clock (real time, or UNRUSH_NOW), so every take starts from the same state.
 *
 *   npm run seed            # HOUSEHOLD_ID or "demo-household"
 */
import { pathToFileURL } from "node:url";
import { addDays, mondayOf, weekDates } from "./dates.js";
import { openDb, resolveDbPath, type DB } from "./db.js";
import { log } from "./log.js";
import { normalizeItemName } from "./names.js";
import { Unrush, type UnrushOptions } from "./service.js";
import { at } from "./time.js";
import { toCanonical } from "./units.js";

export const DEMO_HOUSEHOLD = "demo-household";

export const DEMO_EVENT_IDS = { meeting: "evt-project-sync", plans: "evt-study-group" } as const;

/** What's on hand right now. No eggs (the user said "we're out of eggs" this morning); milk is low. */
const PANTRY: Array<[string, number, string?]> = [
  ["whole milk", 600, "ml"],
  ["cheddar cheese", 300, "g"],
  ["butter", 200, "g"],
  ["greek yogurt", 250, "g"],
  ["chicken thigh", 600, "g"],
  ["yellow onion", 3],
  ["garlic", 10, "clove"],
  ["carrot", 4],
  ["bell pepper", 1],
  ["baby spinach", 150, "g"],
  ["spaghetti", 500, "g"],
  ["basmati rice", 1.5, "kg"],
  ["canned tomatoes", 3, "can"],
  ["canned chickpeas", 2, "can"],
  ["coconut milk", 2, "can"],
  ["red lentils", 400, "g"],
  ["vegetable stock", 1, "l"],
  ["olive oil", 500, "ml"],
  ["soy sauce", 200, "ml"],
  ["curry powder", 50, "g"],
  ["frozen peas", 300, "g"],
  ["bread", 10, "slice"],
  ["tortilla", 6],
];

/** Purchase history: [item, quantity, unit, days-ago list]. Milk ~every 4 days, eggs weekly, bread every ~6 days… */
const HISTORY: Array<[string, number, string | undefined, number[]]> = [
  ["whole milk", 2, "l", [42, 38, 35, 31, 27, 23, 19, 15, 11, 6, 2]],
  ["egg", 12, undefined, [42, 35, 28, 21, 14, 7]],
  ["bread", 20, "slice", [42, 36, 30, 24, 18, 12, 6]],
  ["cheddar cheese", 200, "g", [42, 35, 28, 21, 14, 7]],
  ["spaghetti", 500, "g", [40, 30, 20, 10]],
  ["baby spinach", 200, "g", [40, 33, 26, 19, 12, 5]],
  ["basmati rice", 2, "kg", [40, 12]],
  ["chicken thigh", 600, "g", [3]],
];

function mealPlan(weekStart: string, todayIso: string) {
  const dinners: Array<[string, number, Array<{ item: string; quantity?: number; unit?: string }>]> = [
    ["Red lentil soup", 35, [{ item: "red lentils", quantity: 200, unit: "g" }, { item: "yellow onion", quantity: 1 }, { item: "carrot", quantity: 2 }, { item: "vegetable stock", quantity: 750, unit: "ml" }]],
    ["Veggie noodle stir-fry", 20, [{ item: "egg noodle", quantity: 200, unit: "g" }, { item: "bell pepper", quantity: 1 }, { item: "soy sauce", quantity: 30, unit: "ml" }]],
    ["Black bean quesadillas", 15, [{ item: "tortilla", quantity: 4 }, { item: "canned black beans", quantity: 1, unit: "can" }, { item: "cheddar cheese", quantity: 100, unit: "g" }]],
    ["Chickpea & spinach curry", 25, [{ item: "canned chickpeas", quantity: 1, unit: "can" }, { item: "coconut milk", quantity: 1, unit: "can" }, { item: "baby spinach", quantity: 100, unit: "g" }, { item: "basmati rice", quantity: 150, unit: "g" }]],
    ["Pesto pasta with spinach", 12, [{ item: "spaghetti", quantity: 200, unit: "g" }, { item: "pesto", quantity: 100, unit: "g" }, { item: "baby spinach", quantity: 60, unit: "g" }]],
    ["Veggie omelette & toast", 15, [{ item: "egg", quantity: 4 }, { item: "bread", quantity: 4, unit: "slice" }, { item: "bell pepper", quantity: 1 }]],
    ["Lemon garlic salmon & rice", 30, [{ item: "salmon fillet", quantity: 2 }, { item: "lemon", quantity: 1 }, { item: "garlic", quantity: 2, unit: "clove" }, { item: "basmati rice", quantity: 150, unit: "g" }]],
  ];
  const tonight = {
    meal: "Chicken curry with rice",
    prep_minutes: 45,
    ingredients: [
      { item: "chicken thigh", quantity: 500, unit: "g" },
      { item: "coconut milk", quantity: 1, unit: "can" },
      { item: "yellow onion", quantity: 1 },
      { item: "canned tomatoes", quantity: 1, unit: "can" },
      { item: "curry powder", quantity: 15, unit: "g" },
      { item: "basmati rice", quantity: 150, unit: "g" },
    ],
  };
  let i = 0;
  return weekDates(weekStart).map((date) => {
    if (date === todayIso) return { date, ...tonight };
    const [meal, prep_minutes, ingredients] = dinners[i++ % dinners.length]!;
    return { date, meal, prep_minutes, ingredients };
  });
}

export function seedDemo(db: DB, householdId = DEMO_HOUSEHOLD, opts: UnrushOptions = {}) {
  const app = new Unrush(db, { ...opts, proactiveOnChange: "off" });
  const now = app.ctx.clock.now();
  const today = now.slice(0, 10);
  const weekStart = mondayOf(today);

  db.transaction(() => {
    db.prepare("DELETE FROM households WHERE id = ?").run(householdId); // cascades to every table
    db.prepare("INSERT INTO households (id, name) VALUES (?, ?)").run(householdId, "Maya & Sam's student flat");

    app.prefs.set(householdId, {
      household_size: 2,
      diets: [],
      allergies: [],
      usual_dinner_time: "18:15",
      latest_dinner_time: "21:30",
      cook_window_start: "17:00",
      leave_buffer_minutes: 5,
      home_location: "Home",
      notes: "Two busy students. Weeknights need to be quick.",
    });

    for (const [item, quantity, unit] of PANTRY) {
      const c = toCanonical(quantity, unit);
      app.pantry.write(householdId, normalizeItemName(item), c.quantity, c.unit);
    }

    for (const [item, quantity, unit, daysAgo] of HISTORY) {
      const c = toCanonical(quantity, unit);
      for (const d of daysAgo) app.pantry.logPurchase(householdId, normalizeItemName(item), c, "seed history", at(addDays(today, -d), "18:00"));
    }
    app.pantry.logConsumption(householdId, "egg", null, "ran out", at(today, "08:10"));

    app.meals.savePlan(householdId, weekStart, mealPlan(weekStart, today), "replace");
    // Earlier dinners this week were cooked (no pantry change: the pantry above is "after" them).
    db.prepare("UPDATE meal_plan_days SET cooked_at = ? WHERE household_id = ? AND date < ?").run(now, householdId, today);
    db.prepare("UPDATE meal_plan_days SET previous_meal = NULL WHERE household_id = ?").run(householdId);

    const cal = app.ctx.calendar;
    cal.upsertEvent(householdId, { id: "evt-lecture", title: "Data Structures lecture", start: at(today, "10:00"), end: at(today, "11:30"), location: "Campus" }, now);
    cal.upsertEvent(householdId, { id: DEMO_EVENT_IDS.meeting, title: "Project sync", start: at(today, "17:30"), end: at(today, "18:00"), location: "Online" }, now);
    cal.upsertEvent(householdId, { id: DEMO_EVENT_IDS.plans, title: "Study group", start: at(today, "19:30"), end: at(today, "20:30"), location: "Library" }, now);
    cal.upsertEvent(householdId, { id: "evt-gym", title: "Gym with Sam", start: at(addDays(today, 1), "08:00"), end: at(addDays(today, 1), "09:00"), location: "Gym" }, now);

    // Start quiet: anything already true at seed time (milk low, eggs out) counts as known.
    app.proactive.markAllDelivered(householdId);
  })();

  return { householdId, today, now, weekStart };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const householdId = process.env.HOUSEHOLD_ID ?? DEMO_HOUSEHOLD;
  const path = resolveDbPath();
  const db = openDb(path);
  const r = seedDemo(db, householdId);
  db.close();
  log("seeded demo household (full reset)", { household: r.householdId, today: r.today, now: r.now, db: path });
  if (r.now.slice(11) > "16:45") {
    console.warn(
      `\n⚠ It's ${r.now.slice(11)} on the Unrush clock: the 5:30pm meeting has started, so the demo won't play as scripted.\n` +
        "  Set UNRUSH_NOW=15:00 in .env (the clock then ticks from 3pm) and run `npm run seed` again.\n",
    );
  }
}
