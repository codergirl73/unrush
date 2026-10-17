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

export interface AppOptions {
  config: Config;
  bridge: McpBridge;
  /** Override the model client (tests). */
  model?: ConverseClient;
  log?: (msg: string) => void;
}

export function createApp({ config, bridge, model, log = console.log }: AppOptions) {
  let today = "";
  const client: ConverseClient = model ?? (config.offline ? offlineModel(() => today) : createBedrockClient(config));
  const modelId = config.offline ? "offline-rehearsal (not Bedrock)" : config.modelId;
  const memory = new ConversationMemory(config.historyTurns);
  const subscribers = new Set<Response>();
  /** Active agent runs; proactive speech waits until no conversation turn is in flight. */
  let active = 0;

  const status = () => ({
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

  async function systemNow() {
    const now = await bridge.now();
    today = now.slice(0, 10);
    return systemPrompt(now);
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
          bridge,
          system: await systemNow(),
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
      memory.broadcast({ user: "(Unrush spoke first about: " + alerts.map((a) => a.message).join(" ") + ")", assistant: reply });
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
      const r = await runAgent({
        client,
        modelId,
        bridge,
        system: await systemNow(),
        history: memory.get(sessionId),
        userText,
        maxTokens: config.maxTokens,
        allowPlaceOrder: allowsOrder(memory.lastAssistant(sessionId), userText),
        onEvent: (event) => {
          send(event);
          if (event.type === "tool_call" || event.type === "tool_result") publish({ type: "agent", runId, source: "chat", event });
        },
      });
      memory.add(sessionId, { user: userText, assistant: r.reply });
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

  app.post("/api/reset-session", (req, res) => {
    memory.clear(String((req.body ?? {}).sessionId ?? ""));
    res.json({ ok: true });
  });

  return { app, pollAlerts, publish, memory };
}
