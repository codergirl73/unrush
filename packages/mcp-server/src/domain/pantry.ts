/** Pantry: what's on hand. Adds count as purchases and removals as consumption, so predictions learn. */
import { UnrushError } from "../errors.js";
import { normalizeItemName } from "../names.js";
import { SECTIONS, sectionFor, type Section } from "../sections.js";
import { compatible, humanize, round, toCanonical } from "../units.js";
import { ensureHousehold, validateHousehold, type Ctx } from "./ctx.js";

export interface PantryItem {
  item: string;
  quantity: number;
  unit: string;
  section: Section;
  updated_at: string;
}

export interface PantryChange {
  item: string;
  quantity?: number;
  unit?: string;
  action: "add" | "remove" | "set";
}

type Qty = { quantity: number; unit: string };

export class Pantry {
  constructor(private readonly ctx: Ctx) {}

  get(householdId: string) {
    validateHousehold(householdId);
    const rows = this.ctx.db
      .prepare("SELECT item, quantity, unit, updated_at FROM pantry_items WHERE household_id = ? ORDER BY item")
      .all(householdId) as Array<{ item: string; quantity: number; unit: string; updated_at: string }>;
    const items: PantryItem[] = rows
      .map((r) => ({ ...r, ...humanize(r.quantity, r.unit), section: sectionFor(r.item) }))
      .sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section) || a.item.localeCompare(b.item));
    return { household_id: householdId, item_count: items.length, items };
  }

  /** Raw canonical row, or undefined when the item is absent (quantity 0 rows are deleted). */
  row(householdId: string, item: string): Qty | undefined {
    return this.ctx.db
      .prepare("SELECT quantity, unit FROM pantry_items WHERE household_id = ? AND item = ?")
      .get(householdId, item) as Qty | undefined;
  }

  write(householdId: string, item: string, quantity: number, unit: string) {
    if (quantity <= 0) {
      this.ctx.db.prepare("DELETE FROM pantry_items WHERE household_id = ? AND item = ?").run(householdId, item);
      return;
    }
    this.ctx.db
      .prepare(
        `INSERT INTO pantry_items (household_id, item, quantity, unit, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(household_id, item) DO UPDATE SET quantity = excluded.quantity, unit = excluded.unit, updated_at = excluded.updated_at`,
      )
      .run(householdId, item, round(quantity), unit, this.ctx.clock.now());
  }

  logPurchase(householdId: string, item: string, q: Qty, source: string, at = this.ctx.clock.now(), productId?: string) {
    this.ctx.db
      .prepare("INSERT INTO purchases (household_id, item, quantity, unit, purchased_at, source, product_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(householdId, item, q.quantity, q.unit, at, source, productId ?? null);
  }

  logConsumption(householdId: string, item: string, q: Qty | null, reason: string, at = this.ctx.clock.now()) {
    this.ctx.db
      .prepare("INSERT INTO consumption_log (household_id, item, quantity, unit, reason, logged_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(householdId, item, q?.quantity ?? null, q?.unit ?? null, reason, at);
  }

  /** How much of `need` is not covered by the pantry (null amount = "some"). Returns null when covered. */
  shortfall(householdId: string, item: string, quantity: number | null, unit: string): { quantity: number | null; unit: string } | null {
    const have = this.row(householdId, item);
    if (!have) return { quantity, unit };
    if (quantity === null || !compatible(have.unit, unit)) return null; // have some; can't compare precisely
    const short = round(quantity - have.quantity);
    return short > 0 ? { quantity: short, unit } : null;
  }

  /**
   * Apply changes in one transaction. Invalid changes are reported per change so the
   * caller can fix and resend just those.
   */
  update(householdId: string, changes: PantryChange[]) {
    ensureHousehold(this.ctx, householdId);
    if (!Array.isArray(changes) || changes.length === 0) {
      throw new UnrushError("changes must be a non-empty array of {item, quantity, unit, action}.");
    }
    const results: Array<{
      item: string;
      action: string;
      status: "ok" | "error" | "noop";
      before?: Qty | null;
      after?: Qty | null;
      message?: string;
    }> = [];
    const show = (r: Qty | null | undefined) => (r ? humanize(r.quantity, r.unit) : null);

    this.ctx.db.transaction(() => {
      for (const ch of changes) {
        const item = normalizeItemName(ch.item ?? "");
        if (!item) {
          results.push({ item: ch.item, action: ch.action, status: "error", message: "item name is empty" });
          continue;
        }
        const before = this.row(householdId, item) ?? null;

        // "We're out of eggs": remove with no quantity empties the item and records that it ran out.
        if (ch.action === "remove" && (ch.quantity === undefined || ch.quantity === null)) {
          if (before) this.write(householdId, item, 0, before.unit);
          this.logConsumption(householdId, item, null, "ran out");
          results.push({ item, action: ch.action, status: "ok", before: show(before), after: null, message: "marked as out" });
          continue;
        }

        if (typeof ch.quantity !== "number" || !Number.isFinite(ch.quantity) || ch.quantity < 0) {
          results.push({ item, action: ch.action, status: "error", message: `quantity must be a non-negative number for action "${ch.action}"` });
          continue;
        }
        const c = toCanonical(ch.quantity, ch.unit);

        if (ch.action === "set") {
          this.write(householdId, item, c.quantity, c.unit);
          if (c.quantity <= 0) this.logConsumption(householdId, item, null, "ran out");
          results.push({ item, action: ch.action, status: "ok", before: show(before), after: show(this.row(householdId, item)) });
          continue;
        }

        if (before && !compatible(before.unit, c.unit)) {
          results.push({
            item,
            action: ch.action,
            status: "error",
            before: show(before),
            message: `${item} is tracked in "${before.unit}" but the change used "${c.unit}". Convert to ${before.unit}, or use action "set".`,
          });
          continue;
        }

        if (ch.action === "add") {
          this.write(householdId, item, (before?.quantity ?? 0) + c.quantity, c.unit);
          this.logPurchase(householdId, item, c, "manual");
        } else if (ch.action === "remove") {
          if (!before) {
            results.push({ item, action: ch.action, status: "noop", before: null, after: null, message: `${item} was not in the pantry` });
            continue;
          }
          const used = Math.min(before.quantity, c.quantity);
          this.write(householdId, item, before.quantity - c.quantity, before.unit);
          this.logConsumption(householdId, item, { quantity: used, unit: before.unit }, before.quantity - c.quantity <= 0 ? "ran out" : "used");
        } else {
          results.push({ item, action: String(ch.action), status: "error", message: 'action must be "add", "remove" or "set"' });
          continue;
        }
        results.push({ item, action: ch.action, status: "ok", before: show(before), after: show(this.row(householdId, item)) });
      }
    })();

    if (results.some((r) => r.status === "ok")) this.ctx.changed(householdId, "pantry");
    return {
      household_id: householdId,
      applied: results.filter((r) => r.status === "ok").length,
      errors: results.filter((r) => r.status === "error").length,
      results,
      pantry: this.get(householdId).items,
    };
  }
}
