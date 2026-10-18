/**
 * Unrush web backend (Express). An MCP CLIENT of the Unrush MCP server and the
 * home of the Bedrock agent loop.
 *
 *   GET  /api/events   Server-Sent Events: proactive speech, live agent activity, state changes
 *   POST /api/chat     { sessionId, message } → text/event-stream of AgentEvents for this turn
 *   GET  /api/state    everything the cards need (schedule, tonight, order, run-outs, pantry, alerts)
 *   GET  /api/status   MCP protocol version, model, offline flag
 */
import { randomUUID } from "node:crypto";
import express, { type Response } from "express";
import { explainBedrockError, runAgent, type AgentEvent, type ConverseClient } from "./agent.js";
import { configProblems, createBedrockClient, type Config } from "./config.js";
import { allowsOrder } from "./consent.js";
import type { McpBridge } from "./mcpBridge.js";
import { ConversationMemory } from "./memory.js";
import { offlineModel } from "./offlineModel.js";
import { fallbackSpeech, proactiveInstruction, type AlertLike, type ServerEvent } from "./proactive.js";
import { systemPrompt } from "./prompt.js";
import { EVENING_RESCUE, activeSkillBlock, loadSkills, skillsCatalog, withSkills, type Skill } from "./skills.js";
import { AgentCoreMemory, createAgentCoreClient, recallBlock } from "./agentcore.js";

export interface AppOptions {
  config: Config;
  bridge: McpBridge;
  /** Override the model client (tests). */
  model?: ConverseClient;
  /** Agent Skills to load (default: the repo's skills/ folder). */
  skills?: Skill[];
  /** AgentCore Memory (default: on when AGENTCORE_MEMORY_ID is set and not offline; null disables). */
  longTerm?: AgentCoreMemory | null;
  log?: (msg: string) => void;
}

export function createApp({ config, bridge, model, skills = loadSkills(), longTerm, log = console.log }: AppOptions) {
  const agentcore =
    longTerm !== undefined
      ? longTerm
      : config.agentcoreMemoryId && !config.offline
        ? new AgentCoreMemory(createAgentCoreClient(config.region), config.agentcoreMemoryId, config.householdId)
        : null;
  const tools = withSkills(bridge, skills);
  const rescue = skills.find((s) => s.name === EVENING_RESCUE);
  let today = "";
  const client: ConverseClient = model ?? (config.offline ? offlineModel(() => today) : createBedrockClient(config));
  const modelId = config.offline ? "offline-rehearsal (not Bedrock)" : config.modelId;
  const memory = new ConversationMemory(config.historyTurns);
  const subscribers = new Set<Response>();
  /** Active agent runs; proactive speech waits until no conversation turn is in flight. */
  let active = 0;

  const status = () => ({
    skills: skills.map((s) => s.name),
    memory: agentcore ? agentcore.name : "in-process (last N turns)",
    mcpUrl: config.mcpUrl,
    protocolVersion: bridge.protocolVersion ?? null,
    tools: bridge.listMcpTools().length,
    householdId: config.householdId,
    model: modelId,
    region: config.region,
    offline: config.offline,
    problems: configProblems(config),
  });

  const publish = (e: ServerEvent) => {
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of subscribers) res.write(line);
  };

  /** System prompt with the skills catalog; proactive turns also activate the evening-rescue skill. */
  async function systemNow(proactive = false, extra: string[] = []) {
    const now = await bridge.now();
    today = now.slice(0, 10);
    return systemPrompt(now, [skillsCatalog(skills), proactive && rescue ? activeSkillBlock(rescue) : "", ...extra]);
  }

  /** Run an AgentCore Memory call best-effort, reporting it as a "memory" event. */
  async function remember<T>(
    action: "load" | "recall" | "save",
    fn: (m: AgentCoreMemory) => Promise<T>,
    describe: (r: T) => string,
    emit: (e: AgentEvent) => void,
  ): Promise<T | null> {
    if (!agentcore) return null;
    try {
      const r = await fn(agentcore);
      emit({ type: "memory", action, ok: true, detail: describe(r) });
      return r;
    } catch (err) {
      const e = err as { name?: string; message?: string };
      const detail = `${e.name ?? "Error"}: ${e.message ?? String(err)}`;
      log(`[agentcore] ${action} failed: ${detail}`);
      emit({ type: "memory", action, ok: false, detail });
      return null;
    }
  }

  // ---------- proactive ----------

  /** One poll: claim new alerts and let Unrush speak first. Returns the spoken reply (or null). */
  async function pollAlerts(): Promise<string | null> {
    if (active > 0) return null;
    active++;
    try {
      const { alerts } = (await bridge.read("get_alerts", { mark_delivered: true })) as { alerts: AlertLike[] };
      if (!alerts.length) return null;
      const runId = randomUUID();
      log(`[proactive] ${alerts.map((a) => a.kind).join(", ")}`);
      publish({ type: "proactive_start", runId, alerts });
      const instruction = proactiveInstruction(alerts);
      let reply: string;
      let fallback = false;
      let error: string | undefined;
      try {
        const r = await runAgent({
          client,
          modelId,
          bridge: tools,
          system: await systemNow(true),
          history: [],
          userText: instruction,
          maxTokens: config.maxTokens,
          allowPlaceOrder: false,
          onEvent: (event) => publish({ type: "agent", runId, source: "proactive", event }),
        });
        reply = r.reply;
      } catch (err) {
        // Model unavailable: still speak first, using the alert text the MCP server wrote.
        error = explainBedrockError(err);
        reply = fallbackSpeech(alerts);
        fallback = true;
        log(`[proactive] model failed, spoke alert text instead: ${error}`);
      }
      const turn = { user: "(Unrush spoke first about: " + alerts.map((a) => a.message).join(" ") + ")", assistant: reply };
      memory.broadcast(turn);
      await remember("save", (m) => m.saveTurn(today, turn), () => "proactive turn saved", (event) => publish({ type: "agent", runId, source: "proactive", event }));
      publish({ type: "proactive_end", runId, reply, fallback, error });
      publish({ type: "state_changed" });
      return reply;
    } finally {
      active--;
    }
  }

  // ---------- http ----------

  const app = express();
  app.use(express.json({ limit: "64kb" }));

  app.get("/api/status", (_req, res) => res.json(status()));

  app.get("/api/events", (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "status", status: status() } satisfies ServerEvent)}\n\n`);
    subscribers.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      subscribers.delete(res);
    });
  });

  app.post("/api/chat", async (req, res) => {
    const { sessionId, message } = (req.body ?? {}) as { sessionId?: string; message?: string };
    if (typeof sessionId !== "string" || typeof message !== "string" || !message.trim() || message.length > 2000) {
      res.status(400).json({ error: "Send { sessionId: string, message: string (1-2000 chars) }." });
      return;
    }
    const problems = configProblems(config);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const send = (e: AgentEvent | { type: "error"; message: string }) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    if (problems.length) {
      send({ type: "error", message: problems.join(" ") });
      res.end();
      return;
    }
    const userText = message.trim();
    active++; // don't interrupt a conversation turn with a proactive one
    try {
      const runId = randomUUID();
      today = (await bridge.now()).slice(0, 10);
      // A new browser session (or a restarted backend) picks up today's conversation from AgentCore Memory.
      if (agentcore && !memory.has(sessionId)) {
        const turns = await remember("load", (m) => m.loadTurns(today, config.historyTurns), (t) => `${t.length} earlier turn(s) from today`, send);
        if (turns?.length) memory.seed(sessionId, turns);
      }
      const recalled = await remember("recall", (m) => m.recall(userText), (r) => (r.length ? `${r.length} household preference(s)` : "nothing relevant"), send);
      const r = await runAgent({
        client,
        modelId,
        bridge: tools,
        system: await systemNow(false, [recallBlock(recalled ?? [])]),
        history: memory.get(sessionId),
        userText,
        maxTokens: config.maxTokens,
        allowPlaceOrder: allowsOrder(memory.lastAssistant(sessionId), userText),
        onEvent: (event) => {
          send(event);
          if (event.type === "tool_call" || event.type === "tool_result") publish({ type: "agent", runId, source: "chat", event });
        },
      });
      const turn = { user: userText, assistant: r.reply };
      memory.add(sessionId, turn);
      await remember("save", (m) => m.saveTurn(today, turn), () => "turn saved", send);
      publish({ type: "state_changed" });
    } catch (err) {
      const msg = explainBedrockError(err);
      log(`[chat] ${msg}`);
      send({ type: "error", message: msg });
    } finally {
      active--;
      res.end();
    }
  });

  app.get("/api/state", async (_req, res) => {
    try {
      const schedule = await bridge.read("get_schedule");
      const date = String(schedule.date);
      const [plan, pantry, runouts, order, alerts] = await Promise.all([
        bridge.read("get_meal_plan", { week_start: date }),
        bridge.read("get_pantry"),
        bridge.read("predict_runouts", { days_ahead: 3 }),
        bridge.read("get_order"),
        bridge.read("get_alerts", { include_delivered: true }),
      ]);
      const tonight = (plan.days as Array<{ date: string }>).find((d) => d.date === date) ?? null;
      const plans = (schedule.events as Array<{ id: string; leave_by: string | null }>).filter((e) => e.leave_by);
      const leave = plans.length ? await bridge.read("compute_leave_by", { event_id: plans.at(-1)!.id }) : null;
      res.json({ status: status(), schedule, leave, tonight, plan, pantry, runouts, order: order.order, alerts: alerts.alerts });
    } catch (err) {
      res.status(502).json({ error: `Could not reach the Unrush MCP server: ${(err as Error).message}` });
    }
  });

  // ---------- MCP Apps host support ----------

  app.get("/api/apps", (_req, res) => res.json({ views: bridge.appViews() }));

  app.get("/api/apps/resource", async (req, res) => {
    const uri = String(req.query.uri ?? "");
    if (!bridge.appViews().some((v) => v.resourceUri === uri)) {
      res.status(404).json({ error: `Unknown MCP Apps view ${uri}` });
      return;
    }
    try {
      res.json({ uri, html: await bridge.readResource(uri) });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** Tool calls from inside a view. Read-only tools only: views can show things, never change them. */
  app.post("/api/apps/call", async (req, res) => {
    const { name, arguments: args } = (req.body ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    if (typeof name !== "string" || !bridge.isReadOnly(name)) {
      res.status(403).json({ content: [{ type: "text", text: `Views may only call read-only tools; "${name}" is not one.` }], isError: true });
      return;
    }
    try {
      res.json(await bridge.callToolRaw(name, args ?? {}));
    } catch (err) {
      res.status(502).json({ content: [{ type: "text", text: (err as Error).message }], isError: true });
    }
  });

  app.post("/api/reset-session", (req, res) => {
    memory.clear(String((req.body ?? {}).sessionId ?? ""));
    res.json({ ok: true });
  });

  return { app, pollAlerts, publish, memory };
}
