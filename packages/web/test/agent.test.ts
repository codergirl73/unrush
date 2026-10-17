/**
 * Agent loop tests: a scripted fake Bedrock Converse client + the REAL Unrush MCP
 * server over Streamable HTTP, so MCP→Bedrock tool conversion, household
 * injection, toolResult plumbing and the order-consent gate run end to end
 * without AWS.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContentBlock, ConverseCommand, ConverseCommandOutput, Message } from "@aws-sdk/client-bedrock-runtime";
import { openDb } from "../../mcp-server/src/db.js";
import { startServer, type RunningServer } from "../../mcp-server/src/index.js";
import { seedDemo } from "../../mcp-server/src/seed.js";
import { fixedClock } from "../../mcp-server/src/time.js";
import { MAX_ITERATIONS, ORDER_BLOCKED, explainBedrockError, runAgent, type AgentEvent, type ConverseClient } from "../server/agent.js";
import { allowsOrder, isExplicitYes } from "../server/consent.js";
import { McpBridge, toBedrockTool } from "../server/mcpBridge.js";
import { ConversationMemory } from "../server/memory.js";
import { systemPrompt } from "../server/prompt.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const H = "demo-household";
const TODAY = "2026-10-23";
const clock = fixedClock(`${TODAY}T15:00`);
const dir = mkdtempSync(join(tmpdir(), "unrush-agent-"));
let server: RunningServer;
let bridge: McpBridge;

beforeAll(async () => {
  const dbPath = join(dir, "u.db");
  const db = openDb(dbPath);
  seedDemo(db, H, { clock });
  db.close();
  server = await startServer({ port: 0, dbPath, proactiveIntervalMs: 0, unrush: { clock } });
  bridge = new McpBridge(server.url, H, () => {});
  await bridge.connect();
});

afterAll(async () => {
  await bridge?.close();
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Fake Bedrock: returns scripted assistant turns and records each request. */
function fakeBedrock(turns: Array<{ content: ContentBlock[]; stopReason: string }>) {
  const requests: Array<{ messages: Message[]; system: string; toolNames: string[]; maxTokens?: number; modelId?: string }> = [];
  let i = 0;
  const client: ConverseClient = {
    send: (async (cmd: ConverseCommand) => {
      requests.push({
        messages: structuredClone(cmd.input.messages ?? []),
        system: cmd.input.system?.[0]?.text ?? "",
        toolNames: (cmd.input.toolConfig?.tools ?? []).map((t) => t.toolSpec!.name!),
        maxTokens: cmd.input.inferenceConfig?.maxTokens,
        modelId: cmd.input.modelId,
      });
      const turn = turns[Math.min(i++, turns.length - 1)]!;
      return {
        output: { message: { role: "assistant", content: turn.content } },
        stopReason: turn.stopReason,
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        metrics: { latencyMs: 1 },
        $metadata: {},
      } as ConverseCommandOutput;
    }) as ConverseClient["send"],
  };
  return { client, requests };
}

const toolUse = (toolUseId: string, name: string, input: Record<string, unknown>): ContentBlock => ({
  toolUse: { toolUseId, name, input: input as never },
});
const toolResults = (m: Message) => m.content!.map((b) => b.toolResult!);

describe("MCP → Bedrock tool conversion", () => {
  it("negotiates MCP 2025-11-25 and exposes all 16 tools", () => {
    expect(bridge.protocolVersion).toBe("2025-11-25");
    expect(bridge.toolConfig().tools).toHaveLength(16);
  });

  it("hides household_id from the model and drops $schema", () => {
    const spec = toBedrockTool(bridge.listMcpTools().find((t) => t.name === "place_order")!).toolSpec!;
    const json = spec.inputSchema!.json as { properties: Record<string, unknown>; required: string[]; $schema?: string };
    expect(json.properties).not.toHaveProperty("household_id");
    expect(json.required.sort()).toEqual(["confirmed", "order_id"]);
    expect(json.$schema).toBeUndefined();
    expect(spec.description).toMatch(/explicitly said yes/);
  });
});

describe("runAgent", () => {
  it("loops tool_use → MCP → toolResult until end_turn (meal swap)", async () => {
    const { client, requests } = fakeBedrock([
      { stopReason: "tool_use", content: [{ text: "Let me look." }, toolUse("t1", "suggest_quick_meal", { max_minutes: 15 })] },
      { stopReason: "tool_use", content: [toolUse("t2", "save_meal_plan", { week_start: TODAY, days: [{ date: TODAY, recipe_id: "tomato-garlic-spaghetti" }] })] },
      { stopReason: "end_turn", content: [{ text: "Done — tomato and garlic spaghetti tonight, ready in 15 minutes." }] },
    ]);
    const events: AgentEvent[] = [];
    const r = await runAgent({
      client,
      modelId: "test-model",
      bridge,
      system: "sys",
      history: [{ user: "hi", assistant: "hello" }],
      userText: "Yes, swap it",
      maxTokens: 777,
      onEvent: (e) => events.push(e),
    });
    expect(r).toMatchObject({ iterations: 3, toolCalls: 2, stopReason: "end_turn" });
    expect(r.reply).toMatch(/spaghetti/);

    expect(requests[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(requests[0]).toMatchObject({ maxTokens: 777, modelId: "test-model" });
    expect(requests[0]!.toolNames).toContain("suggest_quick_meal");
    const firstResult = toolResults(requests[1]!.messages.at(-1)!)[0]!;
    expect(firstResult.toolUseId).toBe("t1");
    expect((firstResult.content![0]!.json as { suggestions: Array<{ recipe_id: string }> }).suggestions[0]!.recipe_id).toBe("tomato-garlic-spaghetti");

    expect(events.map((e) => e.type)).toEqual(["thinking", "interim", "tool_call", "tool_result", "thinking", "tool_call", "tool_result", "thinking", "reply", "usage"]);
    const plan = await bridge.read("get_meal_plan", { week_start: TODAY });
    expect((plan.days as Array<{ date: string; meal: string }>).find((d) => d.date === TODAY)!.meal).toBe("Tomato & garlic spaghetti");
  });

  it("passes tool errors back to the model as error toolResults", async () => {
    const { client, requests } = fakeBedrock([
      { stopReason: "tool_use", content: [toolUse("e1", "compute_leave_by", { event_id: "nope" })] },
      { stopReason: "end_turn", content: [{ text: "I couldn't find that event." }] },
    ]);
    await runAgent({ client, modelId: "m", bridge, system: "s", history: [], userText: "when do I leave?" });
    const res = toolResults(requests[1]!.messages.at(-1)!)[0]!;
    expect(res.status).toBe("error");
    expect(res.content![0]!.text).toMatch(/get_schedule/);
  });

  it("BLOCKS place_order without an explicit yes, even if the model sets confirmed=true", async () => {
    const order = await bridge.read("build_grocery_order");
    const { client, requests } = fakeBedrock([
      { stopReason: "tool_use", content: [toolUse("p1", "place_order", { order_id: order.order_id, confirmed: true })] },
      { stopReason: "end_turn", content: [{ text: "Shall I place the order?" }] },
    ]);
    const events: AgentEvent[] = [];
    await runAgent({ client, modelId: "m", bridge, system: "s", history: [], userText: "what do we need?", onEvent: (e) => events.push(e) });
    const res = toolResults(requests[1]!.messages.at(-1)!)[0]!;
    expect(res).toMatchObject({ status: "error", content: [{ text: ORDER_BLOCKED }] });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ ok: false, data: { blocked: true } });
    const latest = await bridge.read("build_grocery_order"); // a fresh draft: nothing was bought
    expect(latest.item_count).toBe(order.item_count);
  });

  it("places the order once the user said yes to the order question", async () => {
    const order = await bridge.read("build_grocery_order");
    const { client } = fakeBedrock([
      { stopReason: "tool_use", content: [toolUse("p2", "place_order", { order_id: order.order_id, confirmed: true })] },
      { stopReason: "end_turn", content: [{ text: "Ordered! Simulated confirmation is on screen." }] },
    ]);
    const events: AgentEvent[] = [];
    const lastAssistant = `That's ${order.read_back}. Shall I place the order?`;
    await runAgent({
      client,
      modelId: "m",
      bridge,
      system: "s",
      history: [{ user: "order groceries", assistant: lastAssistant }],
      userText: "Yes please",
      allowPlaceOrder: allowsOrder(lastAssistant, "Yes please"),
      onEvent: (e) => events.push(e),
    });
    const res = events.find((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>;
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ status: "placed", simulated: true });
    expect(String(res.data.confirmation_number)).toMatch(/^SIM-/);
  });

  it(`stops after ${MAX_ITERATIONS} model calls`, async () => {
    const { client, requests } = fakeBedrock([{ stopReason: "tool_use", content: [toolUse("x", "get_pantry", {})] }]);
    const r = await runAgent({ client, modelId: "m", bridge, system: "s", history: [], userText: "loop" });
    expect(requests).toHaveLength(MAX_ITERATIONS);
    expect(r.reply).toMatch(/more steps/);
  });
});

describe("consent", () => {
  it("needs an order question followed by an unambiguous yes", () => {
    expect(isExplicitYes("Yes please")).toBe(true);
    expect(isExplicitYes("yeah go ahead")).toBe(true);
    expect(isExplicitYes("no, not yet")).toBe(false);
    expect(isExplicitYes("what's in it?")).toBe(false);
    expect(allowsOrder("Shall I place the order?", "yes")).toBe(true);
    expect(allowsOrder("Want me to swap dinner?", "yes")).toBe(false);
    expect(allowsOrder("I placed nothing.", "yes")).toBe(false);
    expect(allowsOrder(undefined, "yes")).toBe(false);
    expect(allowsOrder("Shall I place the order?", "yes but wait")).toBe(false);
  });
});

describe("conversation memory", () => {
  it("keeps the last N turns per session and can broadcast proactive turns", () => {
    const m = new ConversationMemory(2);
    m.add("a", { user: "1", assistant: "1" });
    m.add("a", { user: "2", assistant: "2" });
    m.add("a", { user: "3", assistant: "3" });
    expect(m.get("a").map((t) => t.user)).toEqual(["2", "3"]);
    expect(m.get("b")).toEqual([]);
    m.add("b", { user: "x", assistant: "x" });
    m.broadcast({ user: "[proactive]", assistant: "Leave by 7:05?" });
    expect(m.lastAssistant("a")).toBe("Leave by 7:05?");
    expect(m.lastAssistant("b")).toBe("Leave by 7:05?");
    expect(m.get("new-tab")).toEqual([{ user: "[proactive]", assistant: "Leave by 7:05?" }]);
  });
});

describe("prompt + errors", () => {
  it("anchors the model to the Unrush clock and the consent rule", () => {
    const p = systemPrompt(`${TODAY}T15:00`);
    expect(p).toContain("Friday 2026-10-23, 3pm");
    expect(p).toMatch(/NEVER call place_order/);
    expect(p).toMatch(/action "remove" and NO quantity/);
  });

  it("maps AWS errors to actionable messages without suggesting non-chain credentials", () => {
    expect(explainBedrockError({ name: "CredentialsProviderError", message: "Could not load credentials" })).toMatch(/default AWS credential chain/);
    expect(explainBedrockError({ name: "ValidationException", message: "on-demand throughput isn't supported" })).toMatch(/inference profile/);
    expect(explainBedrockError({ name: "AccessDeniedException", message: "no" })).toMatch(/model access/);
  });
});
