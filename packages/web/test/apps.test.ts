/** MCP Apps host routes: list views, serve ui:// HTML, and proxy only read-only tool calls from views. */
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../../mcp-server/src/db.js";
import { startServer, type RunningServer } from "../../mcp-server/src/index.js";
import { seedDemo } from "../../mcp-server/src/seed.js";
import { fixedClock } from "../../mcp-server/src/time.js";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { McpBridge } from "../server/mcpBridge.js";

const H = "demo-household";
const dir = mkdtempSync(join(tmpdir(), "unrush-apps-"));
let mcp: RunningServer;
let bridge: McpBridge;
let http: Server;
let base: string;

beforeAll(async () => {
  const clock = fixedClock("2026-10-23T15:00");
  const dbPath = join(dir, "u.db");
  const db = openDb(dbPath);
  seedDemo(db, H, { clock });
  db.close();
  mcp = await startServer({ port: 0, dbPath, proactiveIntervalMs: 0, unrush: { clock } });
  bridge = new McpBridge(mcp.url, H, () => {});
  await bridge.connect();
  const { app } = createApp({ config: { ...loadConfig({}), mcpUrl: mcp.url, householdId: H, offline: true }, bridge, log: () => {} });
  http = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const a = http.address();
  base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});

afterAll(async () => {
  http?.close();
  await bridge?.close();
  await mcp?.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (name: string, args: Record<string, unknown> = {}) =>
  fetch(`${base}/api/apps/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, arguments: args }) });

describe("MCP Apps host routes", () => {
  it("lists the tools that declare views", async () => {
    const { views } = await (await fetch(`${base}/api/apps`)).json();
    expect(views).toEqual(
      expect.arrayContaining([
        { tool: "get_schedule", resourceUri: "ui://unrush/evening.html", readOnly: true },
        { tool: "get_order", resourceUri: "ui://unrush/order.html", readOnly: true },
        { tool: "place_order", resourceUri: "ui://unrush/order.html", readOnly: false },
      ]),
    );
  });

  it("serves view HTML only for declared ui:// resources", async () => {
    const ok = await (await fetch(`${base}/api/apps/resource?uri=${encodeURIComponent("ui://unrush/evening.html")}`)).json();
    expect(ok.html).toContain("globalThis.McpApps=");
    const bad = await fetch(`${base}/api/apps/resource?uri=${encodeURIComponent("unrush://households/demo-household/pantry")}`);
    expect(bad.status).toBe(404);
  });

  it("proxies read-only tool calls from views with the household injected", async () => {
    const r = await (await post("get_schedule")).json();
    expect(r.structuredContent).toMatchObject({ household_id: H, date: "2026-10-23" });
  });

  it("refuses write tools from views, so a view can never place an order", async () => {
    const order = await bridge.read("build_grocery_order");
    const r = await post("place_order", { order_id: order.order_id, confirmed: true });
    expect(r.status).toBe(403);
    expect((await r.json()).content[0].text).toMatch(/read-only/);
    expect((await bridge.read("get_order")).order).toMatchObject({ status: "draft" });
  });
});
