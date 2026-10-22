/**
 * Groceries: run-out prediction from purchase history, grocery-order building, and a
 * SIMULATED checkout that refuses to run without explicit confirmation.
 * No payment details exist anywhere in this system.
 */
import { addDays, weekdayOf } from "../dates.js";
import { UnrushError } from "../errors.js";
import { SECTIONS, sectionFor, type Section } from "../sections.js";
import { addMinutes, spokenTime, toMinutes } from "../time.js";
import { compatible, humanize, round, toCanonical } from "../units.js";
import { ensureHousehold, newId, today, validateHousehold, type Ctx } from "./ctx.js";
import type { Meals } from "./meals.js";
import type { Pantry } from "./pantry.js";

export interface Prediction {
  item: string;
  status: "out" | "running_low" | "ok";
  current: { quantity: number; unit: string };
  daily_usage: { quantity: number; unit: string };
  days_left: number;
  predicted_runout_date: string;
  confidence: number;
  confidence_label: "high" | "medium" | "low";
  typical_purchase: { quantity: number; unit: string };
  reasoning: string;
}

export interface OrderItem {
  item: string;
  quantity: number | null;
  unit: string | null;
  section: Section;
  reasons: string[];
}

export interface OrderData {
  days_ahead: number;
  items: OrderItem[];
}

const MIN_PURCHASES = 3;
const DELIVERY_MINUTES = 120;

export class Groceries {
  constructor(
    private readonly ctx: Ctx,
    private readonly pantry: Pantry,
    private readonly meals: Meals,
  ) {}

  /**
   * For each staple (bought at least 3 times), estimate daily usage as
   * (total bought − still on hand) / days since first purchase, then
   * days_left = on hand / daily usage. Returns items that are out or will run
   * out within days_ahead, soonest first.
   */
  predictRunouts(householdId: string, daysAhead = 7) {
    validateHousehold(householdId);
    if (!Number.isInteger(daysAhead) || daysAhead < 0 || daysAhead > 60) throw new UnrushError("days_ahead must be a whole number 0-60.");
    const now = this.ctx.clock.now();
    const date = today(this.ctx);
    const rows = this.ctx.db
      .prepare("SELECT item, quantity, unit, purchased_at FROM purchases WHERE household_id = ? ORDER BY item, purchased_at")
      .all(householdId) as Array<{ item: string; quantity: number; unit: string; purchased_at: string }>;
    const byItem = new Map<string, typeof rows>();
    for (const r of rows) byItem.set(r.item, [...(byItem.get(r.item) ?? []), r]);

    const all: Prediction[] = [];
    for (const [item, buys] of byItem) {
      if (buys.length < MIN_PURCHASES) continue;
      const unit = buys[buys.length - 1]!.unit;
      const same = buys.filter((b) => compatible(b.unit, unit));
      if (same.length < MIN_PURCHASES) continue;
      const p = this.predictOne(householdId, item, unit, same, now, date);
      if (p) all.push(p);
    }
    const horizon = addDays(date, daysAhead);
    const predictions = all
      .filter((p) => p.status === "out" || p.predicted_runout_date <= horizon)
      .sort((a, b) => a.predicted_runout_date.localeCompare(b.predicted_runout_date) || a.item.localeCompare(b.item));
    return { household_id: householdId, today: date, days_ahead: daysAhead, staples_tracked: all.length, predictions };
  }

  private predictOne(
    householdId: string,
    item: string,
    unit: string,
    buys: Array<{ quantity: number; purchased_at: string }>,
    now: string,
    date: string,
  ): Prediction | null {
    const have = this.pantry.row(householdId, item);
    const current = have && compatible(have.unit, unit) ? have.quantity : 0;
    const spanDays = Math.max(1, (toMinutes(now) - toMinutes(buys[0]!.purchased_at)) / 1440);
    const total = buys.reduce((s, b) => s + b.quantity, 0);
    const rate = Math.max(0, total - current) / spanDays;

    const intervals = buys.slice(1).map((b, i) => (toMinutes(b.purchased_at) - toMinutes(buys[i]!.purchased_at)) / 1440);
    const meanInterval = intervals.reduce((s, x) => s + x, 0) / intervals.length;
    const sd = Math.sqrt(intervals.reduce((s, x) => s + (x - meanInterval) ** 2, 0) / intervals.length);
    const cv = meanInterval > 0 ? sd / meanInterval : 1;
    const confidence = round(Math.min(0.95, Math.max(0.3, 0.45 + 0.07 * Math.min(buys.length, 7) - 0.6 * cv)));
    const label = confidence >= 0.75 ? "high" : confidence >= 0.5 ? "medium" : "low";

    const sorted = buys.map((b) => b.quantity).sort((a, b) => a - b);
    const typical = sorted[Math.floor(sorted.length / 2)]!;

    let status: Prediction["status"];
    let daysLeft: number;
    if (current <= 0) {
      status = "out";
      daysLeft = 0;
    } else if (rate <= 0) {
      return null; // never used up: nothing to predict
    } else {
      daysLeft = current / rate;
      status = "ok";
    }
    const runout = addDays(date, Math.floor(daysLeft));
    const h = (q: number) => humanize(q, unit);
    const fmt = (q: number) => {
      const x = h(q);
      const n = x.quantity >= 10 ? Math.round(x.quantity) : Math.round(x.quantity * 10) / 10;
      return x.unit === "count" ? `${n}` : `${n} ${x.unit}`;
    };
    const when = daysLeft < 1 ? "today" : daysLeft < 2 ? "tomorrow" : `${weekdayOf(runout)} (${runout})`;
    const history = `Bought ${buys.length}× in the last ${Math.round(spanDays / 7)} weeks, about every ${Math.round(meanInterval)} days (usually ${fmt(typical)}). Uses ~${fmt(round(rate))}/day.`;
    const reasoning =
      status === "out"
        ? `${history} None left now.`
        : `${history} ${fmt(current)} left → likely runs out ${when}.`;

    return {
      item,
      status: status === "out" ? "out" : daysLeft <= 2 ? "running_low" : "ok",
      current: h(current),
      daily_usage: h(round(rate)),
      days_left: round(daysLeft),
      predicted_runout_date: status === "out" ? date : runout,
      confidence,
      confidence_label: label,
      typical_purchase: h(typical),
      reasoning,
    };
  }

  /**
   * Build a draft order: ingredients missing for uncooked meals in the next
   * days_ahead days + predicted run-outs + items marked out, deduplicated and
   * grouped by store section. Nothing is bought here.
   */
  buildOrder(householdId: string, daysAhead = 2) {
    ensureHousehold(this.ctx, householdId);
    const date = today(this.ctx);
    const items = new Map<string, OrderItem & { canonical: { quantity: number | null; unit: string } }>();
    const add = (item: string, quantity: number | null, unit: string, reason: string) => {
      const prev = items.get(item);
      if (prev) {
        if (quantity !== null && (prev.canonical.quantity === null || (compatible(prev.canonical.unit, unit) && quantity > prev.canonical.quantity))) {
          prev.canonical = { quantity, unit };
        }
        if (!prev.reasons.includes(reason)) prev.reasons.push(reason);
        return;
      }
      items.set(item, { item, quantity: null, unit: null, section: sectionFor(item), reasons: [reason], canonical: { quantity, unit } });
    };

    // 1. Ingredients for upcoming meals that the pantry can't cover.
    const needs = new Map<string, { item: string; unit: string; quantity: number | null; meals: string[] }>();
    for (const day of this.meals.daysBetween(householdId, date, addDays(date, daysAhead))) {
      for (const ing of day.ingredients) {
        const c = typeof ing.quantity === "number" ? toCanonical(ing.quantity, ing.unit) : { quantity: null, unit: toCanonical(1, ing.unit).unit };
        const key = `${ing.item}|${c.unit}`;
        const n = needs.get(key) ?? { item: ing.item, unit: c.unit, quantity: null, meals: [] };
        if (c.quantity !== null) n.quantity = (n.quantity ?? 0) + c.quantity;
        n.meals.push(`${day.date === date ? "tonight's" : `${day.weekday}'s`} ${day.meal}`);
        needs.set(key, n);
      }
    }
    for (const n of needs.values()) {
      const short = this.pantry.shortfall(householdId, n.item, n.quantity, n.unit);
      if (!short) continue;
      // Buy at least the usual pack size when we know it (nobody sells 10 g of spinach).
      const pack = this.typicalPack(householdId, n.item, n.unit);
      const quantity = short.quantity !== null && pack !== null ? Math.max(short.quantity, pack) : short.quantity;
      add(n.item, quantity, n.unit, `for ${n.meals.join(", ")}`);
    }

    // 2. Staples predicted to run out (or already out).
    for (const p of this.predictRunouts(householdId, daysAhead).predictions) {
      const c = toCanonical(p.typical_purchase.quantity, p.typical_purchase.unit);
      add(p.item, c.quantity, c.unit, p.status === "out" ? "out of stock" : `predicted to run out ${p.predicted_runout_date === date ? "today" : p.predicted_runout_date}`);
    }

    // 3. Anything the household said ran out (in the last 2 weeks) and hasn't been restocked.
    const ranOut = this.ctx.db
      .prepare(
        `SELECT DISTINCT item FROM consumption_log WHERE household_id = ? AND reason = 'ran out' AND logged_at >= ?`,
      )
      .all(householdId, `${addDays(date, -14)}T00:00`) as Array<{ item: string }>;
    for (const { item } of ranOut) {
      if (this.pantry.row(householdId, item)) continue;
      const last = this.ctx.db
        .prepare("SELECT quantity, unit FROM purchases WHERE household_id = ? AND item = ? ORDER BY purchased_at DESC LIMIT 1")
        .get(householdId, item) as { quantity: number; unit: string } | undefined;
      add(item, last?.quantity ?? 1, last?.unit ?? "count", "out of stock");
    }

    const list: OrderItem[] = [...items.values()].map(({ canonical, ...rest }) => ({
      ...rest,
      ...(canonical.quantity === null ? { quantity: null, unit: null } : humanize(canonical.quantity, canonical.unit)),
    }));
    const data: OrderData = { days_ahead: daysAhead, items: list };
    const id = newId("ord");
    if (list.length > 0) {
      this.ctx.db
        .prepare("INSERT INTO orders (id, household_id, status, data, created_at) VALUES (?, ?, 'draft', ?, ?)")
        .run(id, householdId, JSON.stringify(data), this.ctx.clock.now());
      this.ctx.changed(householdId, "orders");
    }
    return {
      household_id: householdId,
      order_id: list.length > 0 ? id : null,
      status: "draft" as const,
      simulated: true,
      item_count: list.length,
      sections: groupBySection(list),
      read_back: readBack(list),
      note:
        list.length === 0
          ? "Nothing needed right now."
          : "Simulated store. Read this order back to the user and ask 'Shall I place the order?'. Only call place_order with confirmed=true after an explicit yes.",
    };
  }

  /** Median quantity of past purchases of an item in this unit, or null without history. */
  private typicalPack(householdId: string, item: string, unit: string): number | null {
    const rows = this.ctx.db
      .prepare("SELECT quantity FROM purchases WHERE household_id = ? AND item = ? AND unit = ? ORDER BY quantity")
      .all(householdId, item, unit) as Array<{ quantity: number }>;
    return rows.length ? rows[Math.floor(rows.length / 2)]!.quantity : null;
  }

  getOrder(householdId: string, orderId: string) {
    validateHousehold(householdId);
    const row = this.ctx.db.prepare("SELECT * FROM orders WHERE household_id = ? AND id = ?").get(householdId, orderId) as OrderRow | undefined;
    if (!row) throw new UnrushError(`No order "${orderId}" for this household. Call build_grocery_order first.`);
    return row;
  }

  /** One order by id, or the most recent one when no id is given (null if there are none). */
  findOrder(householdId: string, orderId?: string) {
    validateHousehold(householdId);
    const row = orderId
      ? this.getOrder(householdId, orderId)
      : (this.ctx.db
          .prepare("SELECT * FROM orders WHERE household_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
          .get(householdId) as OrderRow | undefined);
    return { household_id: householdId, order: row ? orderView(row) : null };
  }

  /** SIMULATED checkout. Refuses unless confirmed === true. Never touches payment data. */
  placeOrder(householdId: string, orderIdInput: string | undefined, confirmed: boolean) {
    // Default to the latest draft: the order that was just read back to the user.
    const latest = orderIdInput
      ? undefined
      : (this.ctx.db
          .prepare("SELECT id FROM orders WHERE household_id = ? AND status = 'draft' ORDER BY created_at DESC, rowid DESC LIMIT 1")
          .get(householdId) as { id: string } | undefined);
    const orderId = orderIdInput ?? latest?.id;
    if (!orderId) throw new UnrushError("There is no draft order to place. Call build_grocery_order and read it back first.");
    const row = this.getOrder(householdId, orderId);
    if (row.status === "placed") {
      throw new UnrushError(`Order ${orderId} was already placed (simulated confirmation ${row.confirmation}). Nothing was charged twice.`);
    }
    if (confirmed !== true) {
      throw new UnrushError(
        "Order NOT placed: confirmed must be true, and only after the user explicitly said yes. " +
          "Read the order back and ask 'Shall I place the order?' first.",
      );
    }
    const data = JSON.parse(row.data) as OrderData;
    const now = this.ctx.clock.now();
    const confirmation = `SIM-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const eta = addMinutes(now, DELIVERY_MINUTES);

    this.ctx.db.transaction(() => {
      for (const it of data.items) {
        const q = it.quantity === null ? { quantity: 1, unit: "count" } : toCanonical(it.quantity, it.unit);
        this.pantry.logPurchase(householdId, it.item, q, `order:${orderId}`, now);
        const have = this.pantry.row(householdId, it.item);
        this.pantry.write(householdId, it.item, (have && compatible(have.unit, q.unit) ? have.quantity : 0) + q.quantity, q.unit);
      }
      this.ctx.db
        .prepare("UPDATE orders SET status = 'placed', confirmation = ?, placed_at = ? WHERE id = ?")
        .run(confirmation, now, orderId);
    })();
    this.ctx.changed(householdId, "orders");
    this.ctx.changed(householdId, "pantry");

    return {
      household_id: householdId,
      order_id: orderId,
      status: "placed" as const,
      simulated: true,
      confirmation_number: confirmation,
      eta,
      eta_spoken: spokenTime(eta),
      item_count: data.items.length,
      sections: groupBySection(data.items),
      note: "SIMULATED checkout: no real store, no payment and no card data. Items were added to the pantry and recorded as a purchase so future predictions learn.",
    };
  }
}

type OrderRow = { id: string; household_id: string; status: "draft" | "placed"; data: string; confirmation: string | null; created_at: string; placed_at: string | null };

function orderView(row: OrderRow) {
  const data = JSON.parse(row.data) as OrderData;
  return {
    order_id: row.id,
    status: row.status,
    simulated: true,
    confirmation_number: row.confirmation,
    created_at: row.created_at,
    placed_at: row.placed_at,
    item_count: data.items.length,
    sections: groupBySection(data.items),
    read_back: readBack(data.items),
  };
}

function groupBySection(items: OrderItem[]) {
  return SECTIONS.map((section) => ({
    section,
    items: items.filter((i) => i.section === section).sort((a, b) => a.item.localeCompare(b.item)),
  })).filter((s) => s.items.length > 0);
}

function readBack(items: OrderItem[]): string {
  const ordered = groupBySection(items).flatMap((s) => s.items);
  const plural = (n: number, w: string) => (n === 1 || w.endsWith("s") ? w : `${w}s`);
  const parts = ordered.map((i) =>
    i.quantity === null ? i.item : i.unit === "count" ? `${i.quantity} ${plural(i.quantity, i.item)}` : `${i.quantity} ${i.unit} ${i.item}`,
  );
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
