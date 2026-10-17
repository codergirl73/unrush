/**
 * Builds the Unrush McpServer: 15 tools and 2 resources. A fresh McpServer is created
 * per MCP session (see index.ts); all of them share one Unrush instance and SQLite
 * DB, so state belongs to the household, not to the session.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WEEKDAYS } from "./dates.js";
import { UnrushError } from "./errors.js";
import { log } from "./log.js";
import type { Unrush } from "./service.js";

export const SERVER_INFO = { name: "unrush-mcp", version: "0.1.0" };

// ---------- shared input schemas ----------

const householdId = z.string().describe('Household identifier, e.g. "demo-household". All state is scoped to it.');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").describe("ISO calendar date, YYYY-MM-DD");
const localTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Use YYYY-MM-DDTHH:MM")
  .describe("Household-local time, YYYY-MM-DDTHH:MM (24h, no time zone)");
const weekStart = isoDate.describe("Any date in the target week (YYYY-MM-DD). It is normalized to that week's Monday.");
const ingredient = z.object({
  item: z.string().min(1).describe('Ingredient name, singular and generic, e.g. "egg", "basmati rice"'),
  quantity: z.number().positive().optional().describe("Amount for the whole household (omit if unknown)"),
  unit: z.string().optional().describe('g, kg, ml, l, cup, tbsp, tsp, oz, lb, count (default), or a package word like "can"'),
});

// ---------- shared output schemas ----------

const qty = z.object({ quantity: z.number(), unit: z.string() });
const nullableQty = { quantity: z.number().nullable(), unit: z.string().nullable() };
const pantryItemOut = z.object({ item: z.string(), quantity: z.number(), unit: z.string(), section: z.string(), updated_at: z.string() });
const pantryOut = z.object({ household_id: z.string(), item_count: z.number(), items: z.array(pantryItemOut) });

const preferencesShape = z.object({
  diets: z.array(z.string()),
  allergies: z.array(z.string()),
  dislikes: z.array(z.string()),
  household_size: z.number(),
  weekday_rules: z.record(z.string(), z.string()),
  usual_dinner_time: z.string(),
  latest_dinner_time: z.string(),
  cook_window_start: z.string(),
  leave_buffer_minutes: z.number(),
  home_location: z.string(),
  notes: z.string(),
});
const prefsOut = z.object({ household_id: z.string(), preferences: preferencesShape });

const ingredientOut = z.object({ item: z.string(), quantity: z.number().optional(), unit: z.string().optional() });
const planDayOut = z.object({
  date: z.string(),
  weekday: z.string(),
  meal: z.string(),
  prep_minutes: z.number(),
  ingredients: z.array(ingredientOut),
  previous_meal: z.string().nullable(),
  cooked: z.boolean(),
});
const planOut = z.object({ household_id: z.string(), week_start: z.string(), days: z.array(planDayOut) });

const eventOut = z.object({
  id: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  location: z.string().nullable(),
  previous_start: z.string().nullable(),
  previous_end: z.string().nullable(),
});

const leaveByOut = z.object({
  household_id: z.string(),
  event: eventOut,
  origin: z.string(),
  travel_minutes: z.number(),
  buffer_minutes: z.number(),
  leave_by: z.string(),
  leave_by_spoken: z.string(),
  needs_travel: z.boolean(),
  previous_event: z.object({ id: z.string(), title: z.string(), end: z.string(), previous_end: z.string().nullable() }).nullable(),
  minutes_free_before_leaving: z.number().nullable(),
  conflict: z.boolean(),
  travel_provider: z.string(),
  simulated: z.boolean(),
  explanation: z.string(),
});

const predictionOut = z.object({
  item: z.string(),
  status: z.enum(["out", "running_low", "ok"]),
  current: qty,
  daily_usage: qty,
  days_left: z.number(),
  predicted_runout_date: z.string(),
  confidence: z.number(),
  confidence_label: z.enum(["high", "medium", "low"]),
  typical_purchase: qty,
  reasoning: z.string(),
});

const orderSections = z.array(
  z.object({
    section: z.string(),
    items: z.array(z.object({ item: z.string(), ...nullableQty, section: z.string(), reasons: z.array(z.string()) })),
  }),
);

const alertOut = z.object({
  id: z.string(),
  kind: z.enum(["leave_by", "meal_fit", "runout"]),
  title: z.string(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()),
  status: z.enum(["pending", "delivered", "resolved"]),
  created_at: z.string(),
});

// ---------- wiring ----------

type Extra = { sessionId?: string };

/** Wrap a domain call: log it with timing, return text + structuredContent, turn UnrushErrors into tool errors. */
function run<T extends object>(tool: string, args: unknown, extra: Extra, fn: () => T): CallToolResult {
  const started = performance.now();
  try {
    const result = fn();
    log(`tool ✓ ${tool}`, { session: extra.sessionId?.slice(0, 8), ms: +(performance.now() - started).toFixed(1), args });
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`tool ✗ ${tool}`, { session: extra.sessionId?.slice(0, 8), ms: +(performance.now() - started).toFixed(1), error: message, args });
    if (err instanceof UnrushError) return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
    return { content: [{ type: "text", text: `Internal error in ${tool}: ${message}` }], isError: true };
  }
}

export function createUnrushServer(app: Unrush): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { logging: {} },
    instructions:
      "Unrush keeps one household's evening on track: calendar, pantry, dinner plan and groceries. " +
      "Always read state with tools instead of guessing. Calendar, travel times and checkout are SIMULATED. " +
      "Never call place_order with confirmed=true unless the user explicitly said yes to the read-back order.",
  });

  // ----- calendar -----

  server.registerTool(
    "get_schedule",
    {
      title: "Get schedule",
      description:
        "List the household's calendar events for a date (default today), with a leave_by time for events that need travel. " +
        "Also returns the current local time ('now'). Calendar data is simulated.",
      inputSchema: { household_id: householdId, date: isoDate.optional().describe("Defaults to today") },
      outputSchema: {
        household_id: z.string(),
        date: z.string(),
        now: z.string(),
        calendar_provider: z.string(),
        simulated: z.boolean(),
        events: z.array(eventOut.extend({ leave_by: z.string().nullable() })),
      },
      annotations: { readOnlyHint: true },
    },
    (args, extra) => run("get_schedule", args, extra, () => app.schedule.get(args.household_id, args.date)),
  );

  server.registerTool(
    "add_or_update_event",
    {
      title: "Add or update event",
      description:
        "Add a calendar event, or change an existing one by id (e.g. a meeting that now runs late). " +
        "Changes trigger the proactive checker immediately.",
      inputSchema: {
        household_id: householdId,
        event: z.object({
          id: z.string().optional().describe("Existing event id to update; omit to create a new event"),
          title: z.string().min(1),
          start: localTime,
          end: localTime,
          location: z.string().nullable().optional().describe('Place name, e.g. "Library". Omit or "Home"/"Online" for no travel.'),
        }),
      },
      outputSchema: { household_id: z.string(), created: z.boolean(), event: eventOut, simulated: z.boolean() },
    },
    (args, extra) => run("add_or_update_event", args, extra, () => app.schedule.addOrUpdate(args.household_id, args.event)),
  );

  server.registerTool(
    "compute_leave_by",
    {
      title: "Compute leave-by time",
      description:
        "When to leave home to reach an event on time: event start − travel time − buffer. Also reports how much free time " +
        "remains after the previous event and whether it overlaps. Travel times are simulated estimates.",
      inputSchema: { household_id: householdId, event_id: z.string().describe("Event id from get_schedule") },
      outputSchema: leaveByOut,
      annotations: { readOnlyHint: true },
    },
    (args, extra) => run("compute_leave_by", args, extra, () => app.schedule.computeLeaveBy(args.household_id, args.event_id)),
  );

  // ----- pantry -----

  server.registerTool(
    "get_pantry",
    {
      title: "Get pantry",
      description: "List everything currently in the pantry/fridge with quantities and store section. Items at zero are absent.",
      inputSchema: { household_id: householdId },
      outputSchema: pantryOut,
      annotations: { readOnlyHint: true },
    },
    (args, extra) => run("get_pantry", args, extra, () => app.pantry.get(args.household_id)),
  );

  server.registerTool(
    "update_pantry",
    {
      title: "Update pantry",
      description:
        "Add, remove or set pantry quantities. 'add' = bought; 'remove' = used up; 'set' = correct the exact amount. " +
        "For \"we're out of eggs\", use action 'remove' with NO quantity: it empties the item and records that it ran out. " +
        "Returns a per-change result; fix and resend only changes with status 'error'.",
      inputSchema: {
        household_id: householdId,
        changes: z
          .array(
            z.object({
              item: z.string().min(1).describe("Item name, e.g. 'egg', 'whole milk'"),
              quantity: z.number().nonnegative().optional().describe("Required for add/set; optional for remove"),
              unit: z.string().optional().describe("g, kg, ml, l, cup, tbsp, tsp, oz, lb, count (default), dozen, can…"),
              action: z.enum(["add", "remove", "set"]),
            }),
          )
          .min(1)
          .max(50),
      },
      outputSchema: {
        household_id: z.string(),
        applied: z.number(),
        errors: z.number(),
        results: z.array(
          z.object({
            item: z.string(),
            action: z.string(),
            status: z.enum(["ok", "error", "noop"]),
            before: qty.nullable().optional(),
            after: qty.nullable().optional(),
            message: z.string().optional(),
          }),
        ),
        pantry: z.array(pantryItemOut),
      },
    },
    (args, extra) => run("update_pantry", args, extra, () => app.pantry.update(args.household_id, args.changes)),
  );

  // ----- preferences -----

  server.registerTool(
    "get_preferences",
    {
      title: "Get preferences",
      description:
        "Household preferences: diets, allergies, dislikes, household size, weekday rules, usual and latest dinner time, " +
        "leave buffer and home location.",
      inputSchema: { household_id: householdId },
      outputSchema: prefsOut,
      annotations: { readOnlyHint: true },
    },
    (args, extra) => run("get_preferences", args, extra, () => app.prefs.get(args.household_id)),
  );

  server.registerTool(
    "set_preferences",
    {
      title: "Set preferences",
      description:
        "Update household preferences. Partial update: only fields you pass change; list fields replace the old list. " +
        'weekday_rules merge per day; set a day to "" to remove its rule.',
      inputSchema: {
        household_id: householdId,
        diets: z.array(z.string()).optional().describe("e.g. ['vegetarian']"),
        allergies: z.array(z.string()).optional().describe("Never use these, e.g. ['peanut']"),
        dislikes: z.array(z.string()).optional(),
        household_size: z.number().int().min(1).max(20).optional(),
        // partialRecord: z.record(z.enum(...)) is exhaustive in zod 4 and would make all 7 days required.
        weekday_rules: z.partialRecord(z.enum(WEEKDAYS), z.string()).optional().describe('e.g. {"monday": "vegetarian"}'),
        usual_dinner_time: z.string().optional().describe("HH:MM, 24h"),
        latest_dinner_time: z.string().optional().describe("HH:MM, 24h; cooking must finish by then"),
        cook_window_start: z.string().optional().describe("HH:MM, earliest time cooking can start in the evening"),
        leave_buffer_minutes: z.number().int().min(0).max(60).optional(),
        home_location: z.string().optional(),
        notes: z.string().optional(),
      },
      outputSchema: prefsOut,
    },
    (args, extra) =>
      run("set_preferences", args, extra, () => {
        const { household_id, ...patch } = args;
        return app.prefs.set(household_id, patch);
      }),
  );

  // ----- meals -----

  server.registerTool(
    "get_meal_plan",
    {
      title: "Get meal plan",
      description:
        "Get the dinner plan for the week containing week_start: meal, prep_minutes, ingredients, whether it was cooked, " +
        "and previous_meal when a day was swapped.",
      inputSchema: { household_id: householdId, week_start: weekStart },
      outputSchema: planOut,
      annotations: { readOnlyHint: true },
    },
    (args, extra) => run("get_meal_plan", args, extra, () => app.meals.getPlan(args.household_id, args.week_start)),
  );

  server.registerTool(
    "save_meal_plan",
    {
      title: "Save meal plan",
      description:
        "Save planned dinners (one per date). To swap in a suggested recipe, pass {date, recipe_id} and the name, prep time and " +
        "ingredients are filled in. Otherwise give meal, prep_minutes and ingredients. mode 'merge' (default) only changes the " +
        "given dates. Returns 'warnings' if a meal breaks a diet rule or allergy.",
      inputSchema: {
        household_id: householdId,
        week_start: weekStart,
        days: z
          .array(
            z.object({
              date: isoDate,
              recipe_id: z.string().optional().describe("Recipe id from suggest_quick_meal"),
              meal: z.string().optional().describe("Dish name (required unless recipe_id is given)"),
              prep_minutes: z.number().int().min(1).max(600).optional().describe("Total cooking time (required unless recipe_id)"),
              ingredients: z.array(ingredient).optional().describe("Required unless recipe_id is given"),
            }),
          )
          .min(1)
          .max(7),
        mode: z.enum(["merge", "replace"]).optional().describe("Default 'merge'"),
      },
      outputSchema: planOut.extend({ warnings: z.array(z.string()) }),
    },
    (args, extra) => run("save_meal_plan", args, extra, () => app.meals.savePlan(args.household_id, args.week_start, args.days, args.mode)),
  );

  server.registerTool(
    "suggest_quick_meal",
    {
      title: "Suggest quick meal",
      description:
        "Suggest recipes that take at most max_minutes, made from what's in the pantry, ranked by fewest missing items. " +
        "Respects diet rules and allergies. Use when tonight's dinner no longer fits the free time.",
      inputSchema: {
        household_id: householdId,
        max_minutes: z.number().int().min(5).max(120).describe("Maximum cooking time in minutes, e.g. 15"),
        limit: z.number().int().min(1).max(10).optional().describe("How many suggestions (default 3)"),
      },
      outputSchema: {
        household_id: z.string(),
        max_minutes: z.number(),
        considered: z.number(),
        suggestions: z.array(
          z.object({
            recipe_id: z.string(),
            name: z.string(),
            prep_minutes: z.number(),
            ingredients: z.array(ingredientOut),
            missing: z.array(z.object({ item: z.string(), ...nullableQty })),
            can_make_now: z.boolean(),
          }),
        ),
        note: z.string(),
      },
      annotations: { readOnlyHint: true },
    },
    (args, extra) => run("suggest_quick_meal", args, extra, () => app.meals.suggestQuickMeal(args.household_id, args.max_minutes, args.limit)),
  );

  server.registerTool(
    "mark_meal_cooked",
    {
      title: "Mark meal cooked",
      description: "Record that the planned dinner for a date was cooked: subtracts its ingredients from the pantry and logs usage. Safe to call twice.",
      inputSchema: { household_id: householdId, date: isoDate },
      outputSchema: {
        household_id: z.string(),
        date: z.string(),
        meal: z.string(),
        already_cooked: z.boolean(),
        pantry_changes: z.array(z.object({ item: z.string(), before: qty, after: qty.nullable() })),
        notes: z.array(z.string()),
      },
      annotations: { idempotentHint: true },
    },
    (args, extra) => run("mark_meal_cooked", args, extra, () => app.meals.markCooked(args.household_id, args.date)),
  );

  // ----- groceries -----

  server.registerTool(
    "predict_runouts",
    {
      title: "Predict run-outs",
      description:
        "Predict when staples run out, from purchase and usage history. Returns items that are out or will run out within " +
        "days_ahead, with predicted date, confidence and a one-line reasoning.",
      inputSchema: { household_id: householdId, days_ahead: z.number().int().min(0).max(60).optional().describe("Default 7") },
      outputSchema: {
        household_id: z.string(),
        today: z.string(),
        days_ahead: z.number(),
        staples_tracked: z.number(),
        predictions: z.array(predictionOut),
      },
      annotations: { readOnlyHint: true },
    },
    (args, extra) => run("predict_runouts", args, extra, () => app.groceries.predictRunouts(args.household_id, args.days_ahead)),
  );

  server.registerTool(
    "build_grocery_order",
    {
      title: "Build grocery order",
      description:
        "Build a DRAFT grocery order: ingredients missing for upcoming planned dinners, staples predicted to run out, and items " +
        "that are out, deduplicated and grouped by store section. Nothing is bought. Read 'read_back' to the user and ask " +
        "'Shall I place the order?'.",
      inputSchema: {
        household_id: householdId,
        days_ahead: z.number().int().min(0).max(14).optional().describe("How many days of meals and run-outs to cover (default 2)"),
      },
      outputSchema: {
        household_id: z.string(),
        order_id: z.string().nullable(),
        status: z.literal("draft"),
        simulated: z.boolean(),
        item_count: z.number(),
        sections: orderSections,
        read_back: z.string(),
        note: z.string(),
      },
    },
    (args, extra) => run("build_grocery_order", args, extra, () => app.groceries.buildOrder(args.household_id, args.days_ahead)),
  );

  server.registerTool(
    "place_order",
    {
      title: "Place order (simulated)",
      description:
        "Place a draft grocery order through the SIMULATED store. confirmed MUST be true and may only be true after the user " +
        "explicitly said yes to the read-back order in this conversation; otherwise the call is refused. Returns a simulated " +
        "confirmation number and ETA. No payment or card data is ever involved.",
      inputSchema: {
        household_id: householdId,
        order_id: z.string().describe("order_id from build_grocery_order"),
        confirmed: z.boolean().describe("true only after the user explicitly said yes"),
      },
      outputSchema: {
        household_id: z.string(),
        order_id: z.string(),
        status: z.literal("placed"),
        simulated: z.boolean(),
        confirmation_number: z.string(),
        eta: z.string(),
        eta_spoken: z.string(),
        item_count: z.number(),
        sections: orderSections,
        note: z.string(),
      },
      annotations: { destructiveHint: false, idempotentHint: false },
    },
    (args, extra) => run("place_order", args, extra, () => app.groceries.placeOrder(args.household_id, args.order_id, args.confirmed)),
  );

  // ----- proactive -----

  server.registerTool(
    "get_alerts",
    {
      title: "Get proactive alerts",
      description:
        "Pending proactive alerts: leave-by deadlines, tonight's dinner no longer fitting, and staples about to run out. " +
        "Re-evaluates the rules first. mark_delivered=true marks the returned alerts as delivered so they are not repeated.",
      inputSchema: {
        household_id: householdId,
        mark_delivered: z.boolean().optional().describe("Default false"),
        include_delivered: z.boolean().optional().describe("Also return alerts already delivered today (default false)"),
      },
      outputSchema: { household_id: z.string(), now: z.string(), count: z.number(), alerts: z.array(alertOut) },
    },
    (args, extra) =>
      run("get_alerts", args, extra, () =>
        app.proactive.getAlerts(args.household_id, { markDelivered: args.mark_delivered, includeDelivered: args.include_delivered }),
      ),
  );

  // ----- resources -----

  const households = () => app.listHouseholds();

  server.registerResource(
    "pantry",
    new ResourceTemplate("unrush://households/{household_id}/pantry", {
      list: () => ({
        resources: households().map((h) => ({
          uri: `unrush://households/${h.id}/pantry`,
          name: `Pantry – ${h.name ?? h.id}`,
          mimeType: "application/json",
        })),
      }),
    }),
    { title: "Household pantry", description: "Current pantry contents as JSON.", mimeType: "application/json" },
    (uri, variables) => {
      log("resource read", { uri: uri.href });
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(app.pantry.get(String(variables.household_id)), null, 2) }] };
    },
  );

  server.registerResource(
    "schedule-today",
    new ResourceTemplate("unrush://households/{household_id}/schedule/today", {
      list: () => ({
        resources: households().map((h) => ({
          uri: `unrush://households/${h.id}/schedule/today`,
          name: `Today's schedule – ${h.name ?? h.id}`,
          mimeType: "application/json",
        })),
      }),
    }),
    { title: "Today's schedule", description: "Today's (simulated) calendar with leave-by times, as JSON.", mimeType: "application/json" },
    (uri, variables) => {
      log("resource read", { uri: uri.href });
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(app.schedule.get(String(variables.household_id)), null, 2) }] };
    },
  );

  return server;
}
