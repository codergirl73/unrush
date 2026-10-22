/**
 * Phase 3 end to end: real MCP server + web backend + agent loop. The model is the
 * scripted offline stand-in (or a failing one), so no AWS is needed. Proves that
 * Unrush speaks first over SSE after the late meeting lands, and that the whole hero
 * flow (swap → order read-back → explicit yes → simulated confirmation) runs
 * through the agent.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../../mcp-server/src/db.js";
import { startServer, type RunningServer } from "../../mcp-server/src/index.js";
import { seedDemo } from "../../mcp-server/src/seed.js";
import { fixedClock } from "../../mcp-server/src/time.js";
import type { ConverseClient } from "../server/agent.js";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { McpBridge } from "../server/mcpBridge.js";
import { offlineModel } from "../server/offlineModel.js";
import { proactiveInstruction, type ServerEvent } from "../server/proactive.js";

const H = "demo-household";
const TODAY = "2026-10-23";
const clock = fixedClock(`${TODAY}T15:00`);
const dir = mkdtempSync(join(tmpdir(), "unrush-web-"));
const dbPath = join(dir, "u.db");

let mcp: RunningServer;
let bridge: McpBridge;
let http: Server;
let base: string;
let app: ReturnType<typeof createApp>;

async function listen(a: ReturnType<typeof createApp>) {
  const s = await new Promise<Server>((r) => {
    const srv = a.app.listen(0, "127.0.0.1", () => r(srv));
  });
  const addr = s.address();
  return { server: s, url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}` };
}

/** Collect SSE events from /api/events until `until` matches (or timeout). */
async function collectEvents(url: string, until: (e: ServerEvent) => boolean, ms = 5000): Promise<ServerEvent[]> {
  const ctrl = new AbortController();
  const res = await fetch(`${url}/api/events`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: ServerEvent[] = [];
  let buf = "";
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!chunk.startsWith("data: ")) continue;
        const e = JSON.parse(chunk.slice(6)) as ServerEvent;
        events.push(e);
        if (until(e)) return events;
      }
    }
  } catch {
    /* aborted */
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  return events;
}

async function chat(message: string) {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "s1", message }),
  });
  const text = await res.text();
  const events = text.split("\n\n").filter((c) => c.startsWith("data: ")).map((c) => JSON.parse(c.slice(6)));
  return { events, reply: events.find((e) => e.type === "reply")?.text as string, tools: events.filter((e) => e.type === "tool_call").map((e) => e.name) };
}

const lateMeeting = (end = "19:00") =>
  bridge.read("add_or_update_event", {
    event: { id: "evt-project-sync", title: "Project sync", start: `${TODAY}T17:30`, end: `${TODAY}T${end}`, location: "Online" },
  });

beforeAll(async () => {
  const db = openDb(dbPath);
  seedDemo(db, H, { clock });
  db.close();
  mcp = await startServer({ port: 0, dbPath, proactiveIntervalMs: 0, unrush: { clock } });
  bridge = new McpBridge(mcp.url, H, () => {});
  await bridge.connect();
  const config = { ...loadConfig({}), mcpUrl: mcp.url, householdId: H, offline: true };
  app = createApp({ config, bridge, log: () => {} });
  ({ server: http, url: base } = await listen(app));
});

afterAll(async () => {
  http?.close();
  await bridge?.close();
  await mcp?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("proactive wiring", () => {
  it("builds an instruction that asks the model to speak first without acting", () => {
    const text = proactiveInstruction([
      { id: "a", kind: "leave_by", title: "", message: "Leave by 7:05pm.", data: {} },
      { id: "b", kind: "meal_fit", title: "", message: "Curry won't fit.", data: { suggested_max_minutes: 15 } },
    ]);
    expect(text).toMatch(/^\[PROACTIVE\]/);
    expect(text).toContain("suggest_quick_meal with max_minutes 15");
    expect(text).toMatch(/do not build or place any order/i);
  });

  it("stays quiet when nothing is pending", async () => {
    expect(await app.pollAlerts()).toBeNull();
  });

  it("speaks first over SSE when the late meeting lands, then runs the hero flow through the agent", async () => {
    const listening = collectEvents(base, (e) => e.type === "proactive_end");
    await new Promise((r) => setTimeout(r, 100)); // let the SSE subscription register
    await lateMeeting();
    const spoken = await app.pollAlerts();
    const events = await listening;

    const start = events.find((e) => e.type === "proactive_start") as Extract<ServerEvent, { type: "proactive_start" }>;
    expect(start.alerts.map((a) => a.kind)).toEqual(["leave_by", "meal_fit"]);
    const tools = events.flatMap((e) => (e.type === "agent" && e.event.type === "tool_call" ? [e.event.name] : []));
    expect(tools).toEqual(["compute_leave_by", "suggest_quick_meal"]);
    const end = events.find((e) => e.type === "proactive_end") as Extract<ServerEvent, { type: "proactive_end" }>;
    expect(end.fallback).toBe(false);
    expect(end.reply).toBe(spoken);
    expect(spoken).toContain("leave by 7:05pm");
    expect(spoken).toMatch(/swap in tomato & garlic spaghetti\? It takes 15 minutes/);

    // Alerts were claimed: polling again says nothing.
    expect(await app.pollAlerts()).toBeNull();

    // "Yes" to the swap → plan saved, run-outs predicted, order drafted with usual products;
    // pesto has no purchase history, so Unrush asks which one.
    const swap = await chat("Yes please");
    expect(swap.tools).toEqual(["save_meal_plan", "predict_runouts", "build_grocery_order"]);
    expect(swap.reply).toMatch(/eggs are out and whole milk runs out tomorrow/);
    expect(swap.reply).toMatch(/your usual products\. Which pesto would you like: Amazon Grocery Basil Pesto, 8 oz for \$3\.5/);

    // The user picks one → choose_product, read-back, and the order question.
    const pick = await chat("The first one");
    expect(pick.tools).toEqual(["get_order", "choose_product"]);
    expect(pick.reply).toMatch(/12 eggs, 2 l whole milk and 100 g pesto, about \$\d+(\.\d+)?\. Shall I place the order\?$/);

    // Explicit "yes" to the order question → simulated checkout.
    const placed = await chat("Yes, go ahead");
    expect(placed.tools).toEqual(["get_order", "place_order"]);
    const result = placed.events.find((e) => e.type === "tool_result" && e.name === "place_order");
    expect(result).toMatchObject({ ok: true, data: { status: "placed", simulated: true } });
    expect(placed.reply).toMatch(/Simulated confirmation SIM-[A-Z0-9]{6}, arriving around 5pm\. Each product is linked on screen/);
    expect((result.data.product_links as Array<{ url: string }>).map((l) => l.url)).toContain("https://www.amazon.com/dp/B0CS56H5HL");

    // The cards' state endpoint reflects it (and would after a reload).
    const state = await (await fetch(`${base}/api/state`)).json();
    expect(state.tonight).toMatchObject({ meal: "Tomato & garlic spaghetti", previous_meal: "Chicken curry with rice" });
    expect(state.order).toMatchObject({ status: "placed" });
    expect(state.leave).toMatchObject({ leave_by: `${TODAY}T19:05` });
    expect(state.status).toMatchObject({ protocolVersion: "2025-11-25", tools: 17, offline: true });
  });

  it("still speaks first, using the alert text, when the model is unavailable", async () => {
    const failing: ConverseClient = { send: (async () => { throw Object.assign(new Error("Could not load credentials"), { name: "CredentialsProviderError" }); }) as never };
    const config = { ...loadConfig({}), mcpUrl: mcp.url, householdId: H, offline: false, region: "us-east-1", modelId: "x" };
    const app2 = createApp({ config, bridge, model: failing, log: () => {} });
    const { server, url } = await listen(app2);
    try {
      const listening = collectEvents(url, (e) => e.type === "proactive_end");
      await new Promise((r) => setTimeout(r, 100));
      await lateMeeting("19:10");
      await app2.pollAlerts();
      const end = (await listening).find((e) => e.type === "proactive_end") as Extract<ServerEvent, { type: "proactive_end" }>;
      expect(end.fallback).toBe(true);
      expect(end.error).toMatch(/credential chain/);
      expect(end.reply).toBe(
        "Your 5:30pm Project sync now runs to 7:10pm. To reach your 7:30pm Study group you'll need to leave by 7:05pm. That's 5 minutes before Project sync ends.",
      );
    } finally {
      server.close();
    }
  });

  it("refuses to place an order when the user never said yes", async () => {
    const draft = await chat("what do we need from the store?");
    expect(draft.tools).toEqual(["predict_runouts", "build_grocery_order"]);
    const off = await chat("hmm, not yet");
    expect(off.tools).toEqual([]);
  });
});
