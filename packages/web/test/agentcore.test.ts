/**
 * AgentCore Memory: command shapes against an in-memory fake of the AgentCore data
 * plane, conversation continuity across a backend restart, recall into the system
 * prompt, and graceful degradation when AgentCore fails.
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreateEventCommand, DeleteEventCommand, ListEventsCommand, RetrieveMemoryRecordsCommand, type Event } from "@aws-sdk/client-bedrock-agentcore";
import type { ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { openDb } from "../../mcp-server/src/db.js";
import { startServer, type RunningServer } from "../../mcp-server/src/index.js";
import { seedDemo } from "../../mcp-server/src/seed.js";
import { fixedClock } from "../../mcp-server/src/time.js";
import type { ConverseClient } from "../server/agent.js";
import { AgentCoreMemory, PREFERENCES_NAMESPACE, recallBlock, type AgentCoreSend } from "../server/agentcore.js";
import { createApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";
import { McpBridge } from "../server/mcpBridge.js";

const H = "demo-household";
const TODAY = "2026-10-23";

/** In-memory AgentCore data plane: events per (actor, session) + canned preference records. */
function fakeAgentCore(opts: { fail?: boolean; records?: string[] } = {}) {
  const events: Event[] = [];
  const calls: Array<{ name: string; input: any }> = [];
  const client: AgentCoreSend = {
    send: (async (cmd: any) => {
      calls.push({ name: cmd.constructor.name, input: cmd.input });
      if (opts.fail) throw Object.assign(new Error("Memory not found"), { name: "ResourceNotFoundException" });
      if (cmd instanceof CreateEventCommand) {
        events.push({ ...cmd.input, eventId: `e${events.length}` } as Event);
        return { event: events.at(-1) };
      }
      if (cmd instanceof ListEventsCommand) {
        return { events: events.filter((e) => e.actorId === cmd.input.actorId && e.sessionId === cmd.input.sessionId) };
      }
      if (cmd instanceof DeleteEventCommand) {
        const i = events.findIndex((e) => e.eventId === cmd.input.eventId && e.sessionId === cmd.input.sessionId);
        if (i >= 0) events.splice(i, 1);
        return {};
      }
      if (cmd instanceof RetrieveMemoryRecordsCommand) {
        return { memoryRecordSummaries: (opts.records ?? []).map((text, i) => ({ memoryRecordId: `r${i}`, content: { text }, memoryStrategyId: "s", namespaces: [cmd.input.namespace] })) };
      }
      throw new Error(`unexpected ${cmd.constructor.name}`);
    }) as AgentCoreSend["send"],
  };
  return { client, events, calls };
}

describe("AgentCoreMemory", () => {
  it("stores turns as USER/ASSISTANT conversational events per household-day and reads them back in order", async () => {
    const { client, calls } = fakeAgentCore();
    const m = new AgentCoreMemory(client, "mem-1", H);
    await m.saveTurn(TODAY, { user: "we're out of eggs", assistant: "Got it." }, new Date("2026-10-23T08:00:00Z"));
    await m.saveTurn(TODAY, { user: "what's tonight?", assistant: "Curry." }, new Date("2026-10-23T09:00:00Z"));
    expect(calls[0]).toMatchObject({
      name: "CreateEventCommand",
      input: {
        memoryId: "mem-1",
        actorId: H,
        sessionId: `${H}-${TODAY}`,
        payload: [
          { conversational: { role: "USER", content: { text: "we're out of eggs" } } },
          { conversational: { role: "ASSISTANT", content: { text: "Got it." } } },
        ],
      },
    });
    expect(await m.loadTurns(TODAY, 1)).toEqual([{ user: "what's tonight?", assistant: "Curry." }]);
    expect(await m.loadTurns("2026-10-24", 5)).toEqual([]);
  });

  it("clears one day's conversation (used by npm run seed) without touching other days", async () => {
    const { client, events } = fakeAgentCore();
    const m = new AgentCoreMemory(client, "mem-1", H);
    await m.saveTurn(TODAY, { user: "a", assistant: "b" });
    await m.saveTurn(TODAY, { user: "c", assistant: "d" });
    await m.saveTurn("2026-10-22", { user: "old", assistant: "day" });
    expect(await m.clearDay(TODAY)).toBe(2);
    expect(await m.loadTurns(TODAY, 5)).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it("recalls preferences from the household namespace", async () => {
    const { client, calls } = fakeAgentCore({ records: ["Prefers meals under 20 minutes on weeknights"] });
    const m = new AgentCoreMemory(client, "mem-1", H);
    expect(await m.recall("what's for dinner")).toEqual(["Prefers meals under 20 minutes on weeknights"]);
    expect(calls[0]!.input).toMatchObject({ namespace: PREFERENCES_NAMESPACE(H), searchCriteria: { searchQuery: "what's for dinner", topK: 3 } });
    expect(recallBlock([])).toBe("");
  });
});

describe("AgentCore Memory in the backend", () => {
  const dir = mkdtempSync(join(tmpdir(), "unrush-ac-"));
  let mcp: RunningServer;
  let bridge: McpBridge;

  beforeAll(async () => {
    const clock = fixedClock(`${TODAY}T15:00`);
    const dbPath = join(dir, "u.db");
    const db = openDb(dbPath);
    seedDemo(db, H, { clock });
    db.close();
    mcp = await startServer({ port: 0, dbPath, proactiveIntervalMs: 0, unrush: { clock } });
    bridge = new McpBridge(mcp.url, H, () => {});
    await bridge.connect();
  });

  afterAll(async () => {
    await bridge?.close();
    await mcp?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function echoModel() {
    const requests: Array<{ system: string; history: string[] }> = [];
    const client: ConverseClient = {
      send: (async (cmd: ConverseCommand) => {
        const msgs = cmd.input.messages ?? [];
        requests.push({ system: cmd.input.system?.[0]?.text ?? "", history: msgs.map((m) => m.content?.[0]?.text ?? "") });
        const last = msgs.at(-1)?.content?.[0]?.text ?? "";
        return { output: { message: { role: "assistant", content: [{ text: `You said: ${last}` }] } }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, metrics: { latencyMs: 1 }, $metadata: {} } as ConverseCommandOutput;
      }) as ConverseClient["send"],
    };
    return { client, requests };
  }

  async function chat(app: ReturnType<typeof createApp>, sessionId: string, message: string) {
    const http = await new Promise<Server>((r) => {
      const s = app.app.listen(0, "127.0.0.1", () => r(s));
    });
    const a = http.address();
    const url = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    const text = await (await fetch(`${url}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, message }) })).text();
    http.close();
    return text.split("\n\n").filter((c) => c.startsWith("data: ")).map((c) => JSON.parse(c.slice(6)));
  }

  const config = () => ({ ...loadConfig({}), mcpUrl: mcp.url, householdId: H, region: "us-east-1", modelId: "m" });

  it("keeps the conversation across a backend restart and recalls preferences into the prompt", async () => {
    const ac = fakeAgentCore({ records: ["Likes quick pasta dinners"] });
    const m1 = echoModel();
    const app1 = createApp({ config: config(), bridge, model: m1.client, longTerm: new AgentCoreMemory(ac.client, "mem-1", H), skills: [], log: () => {} });
    const ev1 = await chat(app1, "tab-1", "we're out of eggs");
    expect(ev1.filter((e) => e.type === "memory").map((e) => [e.action, e.ok])).toEqual([["load", true], ["recall", true], ["save", true]]);
    expect(m1.requests[0]!.system).toContain("WHAT YOU REMEMBER ABOUT THIS HOUSEHOLD (AgentCore Memory)\n- Likes quick pasta dinners");
    expect(ac.events).toHaveLength(1);

    // "Restart": a brand-new backend (empty in-process memory), new browser session.
    const m2 = echoModel();
    const app2 = createApp({ config: config(), bridge, model: m2.client, longTerm: new AgentCoreMemory(ac.client, "mem-1", H), skills: [], log: () => {} });
    const ev2 = await chat(app2, "tab-2", "what did I just tell you?");
    expect(ev2.find((e) => e.type === "memory" && e.action === "load")).toMatchObject({ ok: true, detail: "1 earlier turn(s) from today" });
    expect(m2.requests[0]!.history).toEqual(["we're out of eggs", "You said: we're out of eggs", "what did I just tell you?"]);
  });

  it("never breaks a turn when AgentCore fails", async () => {
    const ac = fakeAgentCore({ fail: true });
    const m = echoModel();
    const app = createApp({ config: config(), bridge, model: m.client, longTerm: new AgentCoreMemory(ac.client, "mem-x", H), skills: [], log: () => {} });
    const ev = await chat(app, "tab-3", "hello");
    expect(ev.find((e) => e.type === "reply")).toMatchObject({ text: "You said: hello" });
    expect(ev.filter((e) => e.type === "memory").every((e) => e.ok === false && /ResourceNotFoundException/.test(e.detail))).toBe(true);
  });

  it("is off unless AGENTCORE_MEMORY_ID is set", async () => {
    const app = createApp({ config: { ...config(), agentcoreMemoryId: "" }, bridge, model: echoModel().client, skills: [], log: () => {} });
    const ev = await chat(app, "tab-4", "hi");
    expect(ev.some((e) => e.type === "memory")).toBe(false);
  });
});
