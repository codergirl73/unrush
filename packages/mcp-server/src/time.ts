/**
 * Household-local wall-clock time. Everything in Unrush (events, alerts, "tonight")
 * is a naive local timestamp "YYYY-MM-DDTHH:MM"; arithmetic is done in minutes so
 * there are no time-zone surprises inside the server.
 */
import { addDays, parseIsoDate } from "./dates.js";

const LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;
const HHMM = /^(\d{2}):(\d{2})$/;

export function isLocalDateTime(s: string): boolean {
  const m = LOCAL.exec(s);
  if (!m) return false;
  try {
    parseIsoDate(m[1]!);
  } catch {
    return false;
  }
  return Number(m[2]) < 24 && Number(m[3]) < 60;
}

/** Minutes since 1970-01-01T00:00 (local wall clock, no DST). */
export function toMinutes(s: string): number {
  const m = LOCAL.exec(s);
  if (!m) throw new Error(`Invalid local time "${s}". Use YYYY-MM-DDTHH:MM.`);
  return parseIsoDate(m[1]!).getTime() / 60_000 + Number(m[2]) * 60 + Number(m[3]);
}

export function fromMinutes(mins: number): string {
  return new Date(Math.round(mins) * 60_000).toISOString().slice(0, 16);
}

export function addMinutes(s: string, n: number): string {
  return fromMinutes(toMinutes(s) + n);
}

export function dateOf(s: string): string {
  return s.slice(0, 10);
}

export function at(date: string, hhmm: string): string {
  if (!HHMM.test(hhmm)) throw new Error(`Invalid time "${hhmm}". Use HH:MM (24h).`);
  return `${date}T${hhmm}`;
}

/** "19:05" → "7:05pm"; ":00" dropped ("7pm"). For text that will be spoken. */
export function spokenTime(s: string): string {
  const [h, m] = s.slice(-5).split(":").map(Number) as [number, number];
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

export { addDays };

// ---------- clock ----------

export interface Clock {
  /** Current local wall-clock time, "YYYY-MM-DDTHH:MM". */
  now(): string;
}

function localNow(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Real local time. */
export const systemClock: Clock = { now: () => localNow() };

/** A clock that starts at `start` and then ticks in real time (used by UNRUSH_NOW for recording at any hour). */
export function offsetClock(start: string): Clock {
  const offset = toMinutes(start) - toMinutes(localNow());
  return { now: () => fromMinutes(toMinutes(localNow()) + offset) };
}

/** A frozen clock for tests. */
export function fixedClock(at: string): Clock & { set(t: string): void } {
  let t = at;
  return { now: () => t, set: (v: string) => void (t = v) };
}

/** UNRUSH_NOW="15:00" (today) or "2026-10-17T15:00"; otherwise real time. */
export function clockFromEnv(v = process.env.UNRUSH_NOW): Clock {
  if (!v) return systemClock;
  const full = HHMM.test(v) ? `${localNow().slice(0, 10)}T${v}` : v;
  if (!isLocalDateTime(full)) throw new Error(`UNRUSH_NOW="${v}" is invalid. Use HH:MM or YYYY-MM-DDTHH:MM.`);
  return offsetClock(full);
}
