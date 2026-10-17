/** ISO date helpers. All dates are plain calendar dates (YYYY-MM-DD) in UTC math. */

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function parseIsoDate(s: string): Date {
  if (!ISO.test(s)) throw new Error(`Invalid date "${s}". Use YYYY-MM-DD.`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || toIso(d) !== s) throw new Error(`Invalid date "${s}". Use YYYY-MM-DD.`);
  return d;
}

export function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(s: string): Weekday {
  return WEEKDAYS[parseIsoDate(s).getUTCDay()]!;
}

/** Monday of the week containing the given date. */
export function mondayOf(s: string): string {
  const d = parseIsoDate(s);
  const offset = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - offset);
  return toIso(d);
}

export function addDays(s: string, n: number): string {
  const d = parseIsoDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
}

export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}
