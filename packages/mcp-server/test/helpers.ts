import { openDb } from "../src/db.js";
import { seedDemo, DEMO_HOUSEHOLD } from "../src/seed.js";
import { Unrush } from "../src/service.js";
import { fixedClock } from "../src/time.js";

export const H = DEMO_HOUSEHOLD;
/** A Friday afternoon, before the evening starts. */
export const TODAY = "2026-10-23";
export const NOW = `${TODAY}T15:00`;

/** Fresh in-memory DB seeded with the demo household; alerts re-check synchronously after writes. */
export function seeded(now = NOW) {
  const db = openDb(":memory:");
  const clock = fixedClock(now);
  seedDemo(db, H, { clock });
  const app = new Unrush(db, { clock, proactiveOnChange: "sync" });
  return { db, clock, app };
}

/** Fresh empty DB. */
export function empty(now = NOW) {
  const db = openDb(":memory:");
  const clock = fixedClock(now);
  return { db, clock, app: new Unrush(db, { clock, proactiveOnChange: "sync" }) };
}

export function lateMeeting(app: Unrush, end = "19:00") {
  return app.schedule.addOrUpdate(H, {
    id: "evt-project-sync",
    title: "Project sync",
    start: `${TODAY}T17:30`,
    end: `${TODAY}T${end}`,
    location: "Online",
  });
}
