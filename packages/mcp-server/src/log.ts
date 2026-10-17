/** Tiny structured logger. One line per event; JSON details trimmed for readability. */
const MAX = 400;

export function log(event: string, details?: Record<string, unknown>) {
  if (process.env.UNRUSH_QUIET === "1") return;
  const d = new Date();
  const time = `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  let extra = "";
  if (details) {
    extra = " " + JSON.stringify(details);
    if (extra.length > MAX) extra = extra.slice(0, MAX) + "…";
  }
  console.log(`[${time}] ${event}${extra}`);
}
