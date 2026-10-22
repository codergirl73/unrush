/**
 * Public demo: every visitor gets their own household whose day starts at 3pm,
 * whatever the server's real time is, and households never see each other.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { startServer, type RunningServer } from "../src/index.js";
import { countVisitors, pruneVisitors, seedDemo } from "../src/seed.js";
import { Unrush } from "../src/service.js";
import { fixedClock } from "../src/time.js";

describe("per-household clock", () => {
  it("starts a household's day at start_at and ticks with the real clock", () => {
    const db = openDb(":memory:");
    const clock = fixedClock("2026-10-23T21:40"); // a late-night visitor
    seedDemo(db, "v-late", { clock, startAt: "15:00" });
    seedDemo(db, "plain", { clock });
    const app = new Unrush(db, { clock, proactiveOnChange: "sync" });

    expect(app.ctx.now("v-late")).toBe("2026-10-23T15:00");
    expect(app.ctx.now("plain")).toBe("2026-10-23T21:40");
    clock.set("2026-10-23T21:55");
    expect(app.ctx.now("v-late")).toBe("2026-10-23T15:15");

    // The story plays as scripted: the meeting hasn't started, so the late-meeting alert fires.
    app.schedule.addOrUpdate("v-late", { id: "evt-project-sync", title: "Project sync", start: "2026-10-23T17:30", end: "2026-10-23T19:00", location: "Online" });
    const kinds = app.proactive.getAlerts("v-late", {}).alerts.map((a) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(["leave_by", "meal_fit"]));
    expect(app.proactive.getAlerts("plain", {}).alerts).toHaveLength(0);
  });

  it("prunes only old visitor households", () => {
    const db = openDb(":memory:");
    const clock = fixedClock("2026-10-23T15:00");
    seedDemo(db, "v-old", { clock });
    seedDemo(db, "v-new", { clock });
    seedDemo(db, "demo-household", { clock });
    db.prepare("UPDATE households SET created_at = datetime('now', '-2 days') WHERE id IN ('v-old', 'demo-household')").run();
    expect(pruneVisitors(db)).toBe(1);
    expect(countVisitors(db)).toBe(1);
    expect(db.prepare("SELECT id FROM households ORDER BY id").pluck().all()).toEqual(["demo-household", "v-new"]);
  });
});

describe("demo endpoints", () => {
  let server: RunningServer;
  const base = () => server.url.replace(/\/mcp$/, "");
  const post = (body: unknown) =>
    fetch(`${base()}/demo/households`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeAll(async () => {
    server = await startServer({ port: 0, dbPath: ":memory:", proactiveIntervalMs: 0, demoApi: true, maxVisitors: 2, unrush: { clock: fixedClock("2026-10-23T09:00") } });
  });
  afterAll(async () => server?.close());

  it("creates visitor households at 3pm, checks them, and caps how many exist", async () => {
    const a = await (await post({ start_at: "15:00" })).json();
    expect(a.household_id).toMatch(/^v-[0-9a-f]{16}$/);
    expect(a.now).toBe("2026-10-23T15:00");
    expect((await fetch(`${base()}/demo/households/${a.household_id}`)).status).toBe(200);
    expect((await fetch(`${base()}/demo/households/v-nope`)).status).toBe(404);

    expect((await post({})).status).toBe(200);
    expect((await post({})).status).toBe(429); // maxVisitors: 2
    expect((await post({ household_id: a.household_id, start_at: "15:00" })).status).toBe(200); // resetting your own is fine
  });

  it("rejects bad input", async () => {
    expect((await post({ household_id: "../etc" })).status).toBe(400);
    expect((await post({ household_id: "x", start_at: "3pm" })).status).toBe(400);
  });
});
