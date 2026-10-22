/**
 * Hosted demo (UNRUSH_PUBLIC=1): each browser gets its own household by cookie,
 * starting at 3pm whatever the real time is. Visitors never see each other's
 * state or speech, the demo buttons work over MCP, and Bedrock use is capped.
 */
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../mcp-server/src/index.js";
import { fixedClock } from "../../mcp-server/src/time.js";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { McpBridge } from "../server/mcpBridge.js";
import type { ServerEvent } from "../server/proactive.js";

const clock = fixedClock("2026-10-23T21:40"); // a late-night visitor: the demo must still start at 3pm

let mcp: RunningServer;
let bridge: McpBridge;
let http: Server;
let base: string;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  mcp = await startServer({ port: 0, dbPath: ":memory:", proactiveIntervalMs: 0, demoApi: true, unrush: { clock } });
  bridge = new McpBridge(mcp.url, "demo-household", () => {});
  await bridge.connect();
  const config = { ...loadConfig({}), mcpUrl: mcp.url, offline: true, publicDemo: true, turnsPerHour: 3, householdsPerIpPerHour: 4 };
  app = createApp({ config, bridge, skills: [], log: () => {} });
  http = await new Promise<Server>((r) => {
    const s = app.app.listen(0, "127.0.0.1", () => r(s));
  });
  const addr = http.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  http?.close();
  await bridge?.close();
  await mcp?.close();
});

async function newVisitor() {
  const res = await fetch(`${base}/api/session`, { method: "POST" });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const body = (await res.json()) as { householdId: string; publicDemo: boolean };
  const get = (path: string) => fetch(`${base}${path}`, { headers: { cookie } });
  const post = (path: string, json: unknown = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(json) });
  return { cookie, id: body.householdId, body, get, post };
}

/** Read this visitor's SSE stream until `until` matches. */
async function events(cookie: string, until: (e: ServerEvent) => boolean, ms = 5000) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { cookie }, signal: ctrl.signal });
  const reader = res.body!.getReader();
  const out: ServerEvent[] = [];
  let buf = "";
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!chunk.startsWith("data: ")) continue;
        const e = JSON.parse(chunk.slice(6)) as ServerEvent;
        out.push(e);
        if (until(e)) return out;
      }
    }
  } catch {
    /* aborted */
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  return out;
}

describe("public demo", () => {
  it("needs a session, then gives each browser its own household starting at 3pm", async () => {
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    const a = await newVisitor();
    const b = await newVisitor();
    expect(a.id).toMatch(/^v-/);
    expect(a.id).not.toBe(b.id);
    expect(a.body.publicDemo).toBe(true);
    const state = await (await a.get("/api/state")).json();
    expect(state.schedule.now).toBe("2026-10-23T15:00");
    expect(state.status.householdId).toBe(a.id);
    // The same cookie resumes the same household.
    expect((await (await a.post("/api/session")).json()).householdId).toBe(a.id);
  });

  it("plays the late meeting for one visitor only, then resets it", async () => {
    const a = await newVisitor();
    const b = await newVisitor();
    const aStream = events(a.cookie, (e) => e.type === "proactive_end");
    const bStream = events(b.cookie, (e) => e.type === "proactive_end", 1500);
    await new Promise((r) => setTimeout(r, 100)); // let both streams subscribe

    expect((await a.post("/api/demo/late-meeting")).status).toBe(200);
    const spoken = (await aStream).find((e) => e.type === "proactive_end") as Extract<ServerEvent, { type: "proactive_end" }>;
    expect(spoken.reply).toMatch(/7:05/);
    expect((await bStream).some((e) => e.type === "proactive_start")).toBe(false);

    const bState = await (await b.get("/api/state")).json();
    expect(bState.schedule.events.find((e: { id: string }) => e.id === "evt-project-sync").end).toBe("2026-10-23T18:00");
    expect((await a.post("/api/demo/late-meeting")).status).toBe(409); // already late

    expect((await a.post("/api/demo/reset")).status).toBe(200);
    const aState = await (await a.get("/api/state")).json();
    expect(aState.schedule.events.find((e: { id: string }) => e.id === "evt-project-sync").end).toBe("2026-10-23T18:00");
    expect(aState.alerts.map((x: { kind: string }) => x.kind)).not.toContain("leave_by");
  });

  it("caps chat turns per visitor and new sessions per address", async () => {
    const v = await newVisitor().catch(() => null);
    // householdsPerIpPerHour: 4, and the tests above already made 4 → this address is now refused.
    expect(v).toBeNull();
    expect((await fetch(`${base}/api/session`, { method: "POST" })).status).toBe(429);
  });
});

describe("turn limits", () => {
  it("refuses chat once a visitor has used the hour's turns", async () => {
    // A separate app so the per-IP cap above doesn't interfere.
    const config = { ...loadConfig({}), mcpUrl: mcp.url, offline: true, publicDemo: true, turnsPerHour: 2 };
    const a2 = createApp({ config, bridge, skills: [], log: () => {} });
    const srv = await new Promise<Server>((r) => {
      const s = a2.app.listen(0, "127.0.0.1", () => r(s));
    });
    const addr = srv.address();
    const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    try {
      const cookie = (await fetch(`${url}/api/session`, { method: "POST" })).headers.get("set-cookie")!.split(";")[0]!;
      const say = async (message: string) =>
        (await (await fetch(`${url}/api/chat`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ sessionId: "s", message }) })).text());
      expect(await say("hi")).not.toMatch(/messages an hour/);
      expect(await say("hi again")).not.toMatch(/messages an hour/);
      expect(await say("one more")).toMatch(/2 messages an hour/);
    } finally {
      srv.close();
    }
  });
});
