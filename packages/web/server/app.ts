/**
 * Unrush web backend (Express). An MCP CLIENT of the Unrush MCP server and the
 * home of the Bedrock agent loop.
 *
 *   POST /api/session  start (or resume) this browser's household; public demo sets a cookie
 *   GET  /api/events   Server-Sent Events: proactive speech, live agent activity, state changes
 *   POST /api/chat     { sessionId, message } → text/event-stream of AgentEvents for this turn
 *   GET  /api/state    everything the cards need (schedule, tonight, order, run-outs, pantry, alerts)
 *   GET  /api/status   MCP protocol version, model, offline flag
 *   POST /api/demo/late-meeting   the demo's "late meeting", sent over MCP like `npm run demo:trigger`
 *   POST /api/demo/reset          re-seed this household at 3pm
 *
 * Locally there is one household (HOUSEHOLD_ID). With UNRUSH_PUBLIC=1 every browser
 * gets its own (cookie), with its own alerts, conversation and AgentCore actor,
 * and Bedrock use is rate-limited.
 */
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { explainBedrockError, runAgent, type AgentEvent, type ConverseClient } from "./agent.js";
import { configProblems, createBedrockClient, type Config } from "./config.js";
import { allowsOrder } from "./consent.js";
import { cookieValue, DailyCap, RateWindow } from "./limits.js";
import type { McpBridge } from "./mcpBridge.js";
import { ConversationMemory } from "./memory.js";
import { offlineModel } from "./offlineModel.js";
import { fallbackSpeech, proactiveInstruction, type AlertLike, type QuickMeal, type ServerEvent } from "./proactive.js";
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
  /** AgentCore Memory for the default household (default: on when AGENTCORE_MEMORY_ID is set and not offline; null disables). */
  longTerm?: AgentCoreMemory | null;
  log?: (msg: string) => void;
}

/** Everything that belongs to one household: its MCP view, conversation, live browsers and memory actor. */
interface Household {
  id: string;
  bridge: McpBridge;
  tools: ReturnType<typeof withSkills<McpBridge>>;
  agentcore: AgentCoreMemory | null;
  memory: ConversationMemory;
  subscribers: Set<Response>;
  /** Active agent runs; proactive speech waits until no conversation turn is in flight. */
  active: number;
  seen: number;
}

const COOKIE = "unrush_hh";
const VISITOR_ID = /^v-[0-9a-f]{16}$/;
/** Every demo day starts here, so the 5:30pm meeting is still ahead. */
const DEMO_START = "15:00";
const MEETING_ID = "evt-project-sync";

export function createApp({ config, bridge, model, skills = loadSkills(), longTerm, log = console.log }: AppOptions) {
  const agentcoreClient = longTerm === undefined && config.agentcoreMemoryId && !config.offline ? createAgentCoreClient(config.region) : null;
  const rescue = skills.find((s) => s.name === EVENING_RESCUE);
  /** Date of the latest run (the offline rehearsal model plans around it). */
  let today = "";
  const client: ConverseClient = model ?? (config.offline ? offlineModel(() => today) : createBedrockClient(config));
  const modelId = config.offline ? "offline-rehearsal (not Bedrock)" : config.modelId;
  const households = new Map<string, Household>();
  const turnsPerHousehold = new RateWindow(config.turnsPerHour, 60 * 60_000);
  const newPerIp = new RateWindow(config.householdsPerIpPerHour, 60 * 60_000);
  const daily = new DailyCap(config.turnsPerDay);

  function household(id: string): Household {
    let h = households.get(id);
    if (!h) {
      const b = bridge.forHousehold(id);
      const agentcore =
        id === config.householdId && longTerm !== undefined
          ? longTerm
          : agentcoreClient
            ? new AgentCoreMemory(agentcoreClient, config.agentcoreMemoryId, id)
            : null;
      h = { id, bridge: b, tools: withSkills(b, skills), agentcore, memory: new ConversationMemory(config.historyTurns), subscribers: new Set(), active: 0, seen: 0 };
      households.set(id, h);
      if (households.size > 1000) {
        const idle = [...households.values()].filter((x) => x.subscribers.size === 0 && x.active === 0).sort((a, b) => a.seen - b.seen)[0];
        if (idle) households.delete(idle.id);
      }
    }
    h.seen = Date.now();
    return h;
  }

  const status = (h?: Household) => ({
    skills: skills.map((s) => s.name),
    memory: (h?.agentcore ?? agentcoreClient ?? (longTerm || null)) ? "Amazon Bedrock AgentCore Memory" : "in-process (last N turns)",
    mcpUrl: config.mcpUrl,
    protocolVersion: bridge.protocolVersion ?? null,
    tools: bridge.listMcpTools().length,
    householdId: h?.id ?? config.householdId,
    model: modelId,
    region: config.region,
    offline: config.offline,
    publicDemo: config.publicDemo,
    problems: configProblems(config),
  });

  const publish = (h: Household, e: ServerEvent) => {
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of h.subscribers) res.write(line);
  };

  /** System prompt with the skills catalog; the evening-rescue skill is always active. */
  async function systemNow(h: Household, extra: string[] = []) {
    const now = await h.bridge.now();
    today = now.slice(0, 10);
    // The evening-rescue playbook is always active (saves a load_skill step); other skills load on demand.
    return systemPrompt(now, [skillsCatalog(skills.filter((s) => s !== rescue)), rescue ? activeSkillBlock(rescue) : "", ...extra]);
  }

  /** Run an AgentCore Memory call best-effort, reporting it as a "memory" event. */
  async function remember<T>(
    h: Household,
    action: "load" | "recall" | "save",
    fn: (m: AgentCoreMemory) => Promise<T>,
    describe: (r: T) => string,
    emit: (e: AgentEvent) => void,
  ): Promise<T | null> {
    if (!h.agentcore) return null;
    try {
      const r = await fn(h.agentcore);
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

  /** One poll for one household: claim new alerts and let Unrush speak first. Returns the spoken reply (or null). */
  async function pollHousehold(h: Household): Promise<string | null> {
    if (h.active > 0) return null;
    h.active++;
    try {
      const { alerts } = (await h.bridge.read("get_alerts", { mark_delivered: true })) as { alerts: AlertLike[] };
      if (!alerts.length) return null;
      const runId = randomUUID();
      log(`[proactive] ${h.id}: ${alerts.map((a) => a.kind).join(", ")}`);
      publish(h, { type: "proactive_start", runId, alerts });
      /** Tool facts the next turn needs (e.g. the suggested recipe_id), since history keeps only spoken text. */
      const facts: string[] = [];
      const suggestion = await quickMealFor(h, runId, alerts, facts);
      const instruction = proactiveInstruction(alerts, suggestion);
      let reply: string;
      let fallback = false;
      let error: string | undefined;
      try {
        if (config.publicDemo && !daily.take()) throw new Error("The demo's daily Bedrock budget is used up, so Unrush read the alert out instead.");
        const r = await runAgent({
          client,
          modelId,
          bridge: h.tools,
          system: await systemNow(h),
          history: [],
          userText: instruction,
          maxTokens: config.maxTokens,
          allowPlaceOrder: false,
          onEvent: (event) => {
            publish(h, { type: "agent", runId, source: "proactive", event });
            if (event.type === "tool_result" && event.ok) facts.push(...factsFrom(event.name, event.data));
          },
        });
        reply = r.reply;
      } catch (err) {
        // Model unavailable: still speak first, using the alert text the MCP server wrote.
        error = explainBedrockError(err);
        reply = fallbackSpeech(alerts);
        fallback = true;
        log(`[proactive] model failed, spoke alert text instead: ${error}`);
      }
      const turn = {
        user: "(Unrush spoke first about: " + alerts.map((a) => a.message).join(" ") + (facts.length ? ` Facts: ${facts.join("; ")}.` : "") + ")",
        assistant: reply,
      };
      h.memory.broadcast(turn);
      await remember(h, "save", (m) => m.saveTurn(today, turn), () => "proactive turn saved", (event) => publish(h, { type: "agent", runId, source: "proactive", event }));
      publish(h, { type: "proactive_end", runId, reply, fallback, error });
      publish(h, { type: "state_changed" });
      return reply;
    } finally {
      h.active--;
    }
  }

  /**
   * When dinner no longer fits, look up the quick meal over MCP before the model speaks, so the
   * offer is always a real recipe from the pantry (shown in the activity panel like any tool call).
   */
  async function quickMealFor(h: Household, runId: string, alerts: AlertLike[], facts: string[]): Promise<QuickMeal | undefined> {
    const meal = alerts.find((a) => a.kind === "meal_fit");
    if (!meal) return undefined;
    const id = randomUUID();
    const input = { max_minutes: Number(meal.data.suggested_max_minutes ?? 15) };
    const emit = (event: AgentEvent) => publish(h, { type: "agent", runId, source: "proactive", event });
    emit({ type: "tool_call", id, name: "suggest_quick_meal", input });
    const t0 = Date.now();
    try {
      const out = await h.bridge.callTool("suggest_quick_meal", input);
      emit({ type: "tool_result", id, name: "suggest_quick_meal", ok: out.ok, ms: Date.now() - t0, data: out.data });
      if (!out.ok) return undefined;
      facts.push(...factsFrom("suggest_quick_meal", out.data));
      return (out.data.suggestions as QuickMeal[] | undefined)?.[0];
    } catch (err) {
      emit({ type: "tool_result", id, name: "suggest_quick_meal", ok: false, ms: Date.now() - t0, data: { error: (err as Error).message } });
      return undefined;
    }
  }

  /** Poll the default household (local mode, tests) or a given one. */
  const pollAlerts = (id = config.householdId) => pollHousehold(household(id));

  /** The timer's poll: locally the one household; in the public demo, every household with a browser open. */
  async function pollAll(): Promise<void> {
    if (!config.publicDemo) {
      await pollAlerts();
      return;
    }
    const open = [...households.values()].filter((h) => h.subscribers.size > 0);
    await Promise.all(open.map((h) => pollHousehold(h).catch((err) => log(`[proactive] ${h.id}: ${(err as Error).message}`))));
  }

  // ---------- visitors ----------

  /** This request's household, or null when a public-demo browser has no (live) session yet. */
  async function visitor(req: Request): Promise<Household | null> {
    if (!config.publicDemo) return household(config.householdId);
    const id = cookieValue(req.headers.cookie, COOKIE);
    if (!id || !VISITOR_ID.test(id)) return null;
    if (households.has(id) || (await bridge.householdExists(id))) return household(id);
    return null;
  }

  // ---------- http ----------

  const app = express();
  app.set("trust proxy", "loopback"); // behind a local reverse proxy (Caddy): real client IP and https
  app.use(express.json({ limit: "64kb" }));

  app.get("/api/status", (_req, res) => res.json(status()));

  app.post("/api/session", async (req, res) => {
    try {
      let h = await visitor(req);
      if (!h) {
        if (!newPerIp.take(req.ip ?? "?")) {
          res.status(429).json({ error: "Too many new demo sessions from this address. Try again in a while." });
          return;
        }
        const { household_id } = await bridge.seedHousehold(undefined, DEMO_START);
        h = household(household_id);
        res.cookie(COOKIE, household_id, { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: 24 * 60 * 60_000 });
        log(`[demo] new visitor household ${household_id}`);
      }
      res.json({ householdId: h.id, publicDemo: config.publicDemo, status: status(h) });
    } catch (err) {
      const e = err as Error & { status?: number };
      res.status(e.status === 429 ? 429 : 502).json({ error: e.message });
    }
  });

  // Everything below acts for this browser's household.
  app.use("/api", async (req, res, next) => {
    try {
      const h = await visitor(req);
      if (!h) {
        res.status(401).json({ error: "No demo session yet. Reload the page." });
        return;
      }
      res.locals.h = h;
      next();
    } catch (err) {
      res.status(502).json({ error: `Could not reach the Unrush MCP server: ${(err as Error).message}` });
    }
  });
  const hh = (res: Response) => res.locals.h as Household;

  app.get("/api/events", (req, res) => {
    const h = hh(res);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(`data: ${JSON.stringify({ type: "status", status: status(h) } satisfies ServerEvent)}\n\n`);
    h.subscribers.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      h.subscribers.delete(res);
    });
  });

  app.post("/api/chat", async (req, res) => {
    const h = hh(res);
    const { sessionId, message } = (req.body ?? {}) as { sessionId?: string; message?: string };
    if (typeof sessionId !== "string" || typeof message !== "string" || !message.trim() || message.length > 2000) {
      res.status(400).json({ error: "Send { sessionId: string, message: string (1-2000 chars) }." });
      return;
    }
    const problems = configProblems(config);
    if (config.publicDemo && !turnsPerHousehold.take(h.id)) problems.push(`This demo allows ${config.turnsPerHour} messages an hour per visitor. Try again a bit later.`);
    else if (config.publicDemo && !daily.take()) problems.push("The demo has used today's Amazon Bedrock budget. Please try again tomorrow.");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = (e: AgentEvent | { type: "error"; message: string }) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    if (problems.length) {
      send({ type: "error", message: problems.join(" ") });
      res.end();
      return;
    }
    const userText = message.trim();
    h.active++; // don't interrupt a conversation turn with a proactive one
    try {
      const runId = randomUUID();
      today = (await h.bridge.now()).slice(0, 10);
      // A new browser session (or a restarted backend) picks up today's conversation from AgentCore Memory.
      if (h.agentcore && !h.memory.has(sessionId)) {
        const turns = await remember(h, "load", (m) => m.loadTurns(today, config.historyTurns), (t) => `${t.length} earlier turn(s) from today`, send);
        if (turns?.length) h.memory.seed(sessionId, turns);
      }
      const chatFacts: string[] = [];
      const recalled = await remember(h, "recall", (m) => m.recall(userText), (r) => (r.length ? `${r.length} household preference(s)` : "nothing relevant"), send);
      const r = await runAgent({
        client,
        modelId,
        bridge: h.tools,
        system: await systemNow(h, [recallBlock(recalled ?? [])]),
        history: h.memory.get(sessionId),
        userText,
        maxTokens: config.maxTokens,
        allowPlaceOrder: allowsOrder(h.memory.lastAssistant(sessionId), userText),
        onEvent: (event) => {
          send(event);
          if (event.type === "tool_result" && event.ok) chatFacts.push(...factsFrom(event.name, event.data));
          if (event.type === "tool_call" || event.type === "tool_result") publish(h, { type: "agent", runId, source: "chat", event });
        },
      });
      const turn = { user: chatFacts.length ? `${userText} (Facts: ${chatFacts.join("; ")}.)` : userText, assistant: r.reply };
      h.memory.add(sessionId, turn);
      await remember(h, "save", (m) => m.saveTurn(today, turn), () => "turn saved", send);
      publish(h, { type: "state_changed" });
    } catch (err) {
      const msg = explainBedrockError(err);
      log(`[chat] ${msg}`);
      send({ type: "error", message: msg });
    } finally {
      h.active--;
      res.end();
    }
  });

  app.get("/api/state", async (_req, res) => {
    const { bridge: b } = hh(res);
    try {
      const schedule = await b.read("get_schedule");
      const date = String(schedule.date);
      const [plan, pantry, runouts, order, alerts] = await Promise.all([
        b.read("get_meal_plan", { week_start: date }),
        b.read("get_pantry"),
        b.read("predict_runouts", { days_ahead: 3 }),
        b.read("get_order"),
        b.read("get_alerts", { include_delivered: true }),
      ]);
      const tonight = (plan.days as Array<{ date: string }>).find((d) => d.date === date) ?? null;
      const plans = (schedule.events as Array<{ id: string; leave_by: string | null }>).filter((e) => e.leave_by);
      const leave = plans.length ? await b.read("compute_leave_by", { event_id: plans.at(-1)!.id }) : null;
      res.json({ status: status(hh(res)), schedule, leave, tonight, plan, pantry, runouts, order: order.order, alerts: alerts.alerts });
    } catch (err) {
      res.status(502).json({ error: `Could not reach the Unrush MCP server: ${(err as Error).message}` });
    }
  });

  // ---------- demo controls ----------

  /** The late meeting: extend today's 5:30pm Project sync to 7pm over MCP. The checker reacts; Unrush speaks first. */
  app.post("/api/demo/late-meeting", async (_req, res) => {
    const h = hh(res);
    try {
      const schedule = await h.bridge.read("get_schedule");
      const date = String(schedule.date);
      const meeting = (schedule.events as Array<Record<string, string>>).find((e) => e.id === MEETING_ID);
      if (!meeting) {
        res.status(409).json({ error: "There's no 5:30pm meeting today. Reset the demo first." });
        return;
      }
      if (meeting.end! >= `${date}T19:00`) {
        res.status(409).json({ error: "The meeting is already running late. Reset the demo to play it again." });
        return;
      }
      if (String(schedule.now) >= meeting.start!) {
        res.status(409).json({ error: "It's already past 5:30pm in this demo. Reset to start again at 3pm." });
        return;
      }
      await h.bridge.read("add_or_update_event", {
        event: { id: MEETING_ID, title: meeting.title, start: meeting.start, end: `${date}T19:00`, location: meeting.location },
      });
      publish(h, { type: "state_changed" });
      res.json({ ok: true });
      // Speak first right away rather than on the next poll.
      setTimeout(() => void pollHousehold(h).catch((err) => log(`[proactive] ${(err as Error).message}`)), 300);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /** Start this household's day again at 3pm: state, alerts and conversation. */
  app.post("/api/demo/reset", async (_req, res) => {
    const h = hh(res);
    if (h.active > 0) {
      res.status(409).json({ error: "Unrush is still talking. Try again in a moment." });
      return;
    }
    if (config.publicDemo && !turnsPerHousehold.take(h.id)) {
      res.status(429).json({ error: "Too many resets. Try again a bit later." });
      return;
    }
    try {
      const { now } = await h.bridge.seedHousehold(h.id, DEMO_START);
      h.memory.clear();
      if (h.agentcore) await h.agentcore.clearDay(now.slice(0, 10)).catch((err) => log(`[agentcore] reset failed: ${(err as Error).message}`));
      publish(h, { type: "reset" });
      publish(h, { type: "state_changed" });
      res.json({ ok: true, now });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
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
      res.json(await hh(res).bridge.callToolRaw(name, args ?? {}));
    } catch (err) {
      res.status(502).json({ content: [{ type: "text", text: (err as Error).message }], isError: true });
    }
  });

  app.post("/api/reset-session", (req, res) => {
    hh(res).memory.clear(String((req.body ?? {}).sessionId ?? ""));
    res.json({ ok: true });
  });

  return {
    app,
    pollAlerts,
    pollAll,
    publish: (e: ServerEvent, id = config.householdId) => publish(household(id), e),
    memory: household(config.householdId).memory,
  };
}

/** Compact facts from tool results that a follow-up turn needs but spoken text drops. */
export function factsFrom(tool: string, data: Record<string, unknown>): string[] {
  if (tool === "suggest_quick_meal") {
    const top = (data.suggestions as Array<{ recipe_id: string; name: string; prep_minutes: number }> | undefined)?.[0];
    return top ? [`offered recipe "${top.name}" (recipe_id ${top.recipe_id}, ${top.prep_minutes} min)`] : [];
  }
  if (tool === "compute_leave_by" && typeof data.leave_by_spoken === "string") return [`leave by ${data.leave_by_spoken}`];
  if (tool === "save_meal_plan") return ["tonight's dinner swap saved"];
  if (tool === "build_grocery_order" || tool === "choose_product") {
    const pending = (data.needs_choice as Array<{ item: string; choices: Array<{ asin: string; title: string }> }> | undefined) ?? [];
    return [
      pending.length
        ? `draft order saved; still needs a product choice for ${pending.map((n) => `${n.item} (${n.choices.map((c) => `${c.title} = asin ${c.asin}`).join(" / ")})`).join("; ")}`
        : `draft order complete and read back: ${String(data.read_back ?? "")}`,
    ];
  }
  return [];
}
