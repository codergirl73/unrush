/**
 * End to end over the wire: start the real Streamable HTTP server, connect with the
 * official SDK client, and run the hero flow with the agent's decisions scripted
 * (no LLM). Then reconnect (page reload) and restart the server (process restart)
 * to prove memory persists.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { openDb } from "../src/db.js";
import { startServer, TARGET_PROTOCOL_VERSION, type RunningServer } from "../src/index.js";
import { seedDemo } from "../src/seed.js";
import { fixedClock } from "../src/time.js";
import { H, NOW, TODAY } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "unrush-it-"));
const dbPath = join(dir, "unrush.db");
const clock = fixedClock(NOW);

let server: RunningServer;

async function connect(url: string) {
  const client = new Client({ name: "unrush-it", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: { household_id: H, ...args } })) as CallToolResult;
  const data = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args);
    if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.content)}`);
    return r.structuredContent as Record<string, any>;
  };
  return { client, transport, call, data };
}

beforeAll(async () => {
  const db = openDb(dbPath);
  seedDemo(db, H, { clock });
  db.close();
  server = await startServer({ port: 0, dbPath, proactiveIntervalMs: 0, unrush: { clock } });
});

afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP over Streamable HTTP", () => {
  it(`negotiates protocol ${TARGET_PROTOCOL_VERSION} and exposes every tool and resource`, async () => {
    const { client, transport } = await connect(server.url);
    expect(transport.sessionId).toBeTruthy();
    expect(transport.protocolVersion).toBe("2025-11-25");
    expect(server.negotiated.get(transport.sessionId!)).toBe("2025-11-25");
    expect(client.getServerVersion()).toMatchObject({ name: "unrush-mcp" });

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_or_update_event",
      "build_grocery_order",
      "compute_leave_by",
      "get_alerts",
      "get_meal_plan",
      "get_pantry",
      "get_preferences",
      "get_schedule",
      "mark_meal_cooked",
      "place_order",
      "predict_runouts",
      "save_meal_plan",
      "set_preferences",
      "suggest_quick_meal",
      "update_pantry",
    ]);
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(40);
      expect(t.outputSchema).toBeDefined();
    }
    const place = tools.find((t) => t.name === "place_order")!;
    expect(place.inputSchema.required).toEqual(expect.arrayContaining(["household_id", "order_id", "confirmed"]));
    const prefs = tools.find((t) => t.name === "set_preferences")!;
    expect((prefs.inputSchema.properties as Record<string, { required?: string[] }>).weekday_rules!.required ?? []).toEqual([]);

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([
      `unrush://households/${H}/pantry`,
      `unrush://households/${H}/schedule/today`,
    ]);
    const sched = await client.readResource({ uri: `unrush://households/${H}/schedule/today` });
    expect(JSON.parse((sched.contents[0] as { text: string }).text)).toMatchObject({ date: TODAY, simulated: true });
    await client.close();
  });

  it("returns schema-valid errors as tool errors", async () => {
    const { client, call } = await connect(server.url);
    const bad = await call("compute_leave_by", { event_id: "nope" });
    expect(bad.isError).toBe(true);
    expect((bad.content[0] as { text: string }).text).toMatch(/get_schedule/);
    await client.close();
  });

  it("runs the hero flow end to end (agent scripted)", async () => {
    const { client, data, call } = await connect(server.url);

    // 1. The late meeting lands.
    const sched = await data("get_schedule");
    expect(sched.events.find((e: any) => e.id === "evt-study-group").leave_by).toBe(`${TODAY}T19:05`);
    await data("add_or_update_event", {
      event: { id: "evt-project-sync", title: "Project sync", start: `${TODAY}T17:30`, end: `${TODAY}T19:00`, location: "Online" },
    });

    // 2. Unrush speaks first: the backend polls alerts.
    const { alerts } = await data("get_alerts", { mark_delivered: true });
    expect(alerts.map((a: any) => a.kind)).toEqual(["leave_by", "meal_fit"]);
    expect(alerts[0].message).toContain("you'll need to leave by 7:05pm");
    expect((await data("get_alerts")).count).toBe(0);

    // 3. Swap tonight's 45-minute dinner for a 15-minute pantry meal.
    const quick = await data("suggest_quick_meal", { max_minutes: 15 });
    expect(quick.suggestions[0]).toMatchObject({ recipe_id: "tomato-garlic-spaghetti", can_make_now: true });
    const plan = await data("save_meal_plan", { week_start: TODAY, days: [{ date: TODAY, recipe_id: quick.suggestions[0].recipe_id }] });
    expect(plan.days.find((d: any) => d.date === TODAY)).toMatchObject({ prep_minutes: 15, previous_meal: "Chicken curry with rice" });

    // 4. Eggs out; milk about to run out.
    const pred = await data("predict_runouts", { days_ahead: 2 });
    expect(pred.predictions.map((p: any) => [p.item, p.status])).toEqual([["egg", "out"], ["whole milk", "running_low"]]);

    // 5. Build, read back, refuse without yes, then place on yes.
    const order = await data("build_grocery_order");
    expect(order.read_back).toContain("12 eggs");
    const refused = await call("place_order", { order_id: order.order_id, confirmed: false });
    expect(refused.isError).toBe(true);
    expect((refused.content[0] as { text: string }).text).toMatch(/NOT placed/);
    const placed = await data("place_order", { order_id: order.order_id, confirmed: true });
    expect(placed).toMatchObject({ status: "placed", simulated: true });
    expect(placed.confirmation_number).toMatch(/^SIM-/);
    await client.close();
  });

  it("remembers everything in a new session (page reload)", async () => {
    const { client, data } = await connect(server.url);
    const plan = await data("get_meal_plan", { week_start: TODAY });
    expect(plan.days.find((d: any) => d.date === TODAY).meal).toBe("Tomato & garlic spaghetti");
    const pantry = await data("get_pantry");
    expect(pantry.items.find((i: any) => i.item === "egg")).toMatchObject({ quantity: 12 });
    await client.close();
  });

  it("remembers everything after a server restart", async () => {
    await server.close();
    server = await startServer({ port: 0, dbPath, proactiveIntervalMs: 0, unrush: { clock } });
    const { client, data } = await connect(server.url);
    const sched = await data("get_schedule");
    expect(sched.events.find((e: any) => e.id === "evt-project-sync").end).toBe(`${TODAY}T19:00`);
    const pantry = await data("get_pantry");
    expect(pantry.items.find((i: any) => i.item === "whole milk")).toMatchObject({ quantity: 2.6, unit: "l" });
    expect((await data("get_alerts")).count).toBe(0); // delivered alerts stay delivered
    await client.close();
  });

  it("rejects requests without a session", async () => {
    const res = await fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(400);
    const gone = await fetch(server.url, { method: "GET", headers: { "mcp-session-id": "nope", accept: "text/event-stream" } });
    expect(gone.status).toBe(404);
  });
});
