import { useCallback, useEffect, useRef, useState } from "react";
import { clock, fetchState, newSessionId, resetDemo, resetSession, runMeetingLate, startSession, streamChat } from "./api";
import { ActivityPanel, type ActivityItem, type ActivityTurn } from "./components/ActivityPanel";
import { DemoGuide, demoStep } from "./components/DemoGuide";
import { AlertBanner, DinnerCard, OrderCard, PantryCard, RunoutCard, TimelineCard } from "./components/Cards";
import { ChipIcon, Logo, MoonIcon, SunIcon } from "./components/icons";
import { McpAppFrame } from "./components/McpAppFrame";
import { VoicePanel, type ChatMessage } from "./components/VoicePanel";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { useSpeaker } from "./speech";
import type { AgentEvent, Alert, AppState, ServerEvent, Status } from "./types";

type Theme = "light" | "dark";
const CARD_FOR_TOOL: Record<string, string> = {
  add_or_update_event: "timeline",
  compute_leave_by: "timeline",
  save_meal_plan: "dinner",
  suggest_quick_meal: "dinner",
  build_grocery_order: "order",
  place_order: "order",
  predict_runouts: "runout",
  update_pantry: "pantry",
  mark_meal_cooked: "pantry",
};

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem("unrush.theme");
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* storage unavailable */
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Apply one AgentEvent to an activity turn. */
function reduceTurn(t: ActivityTurn, e: AgentEvent): ActivityTurn {
  switch (e.type) {
    case "thinking":
      return { ...t, items: [...t.items, { kind: "model", iteration: e.iteration }] };
    case "interim":
      return { ...t, items: [...t.items, { kind: "interim", text: e.text }] };
    case "memory":
      return { ...t, items: [...t.items, { kind: "memory", action: e.action, ok: e.ok, detail: e.detail }] };
    case "tool_call":
      return { ...t, items: [...t.items, { kind: "tool", id: e.id, name: e.name, input: e.input }] };
    case "tool_result":
      return {
        ...t,
        items: t.items.map((it): ActivityItem => (it.kind === "tool" && it.id === e.id ? { ...it, result: { ok: e.ok, ms: e.ms, data: e.data } } : it)),
      };
    case "reply":
      return { ...t, reply: e.text };
    case "usage":
      return { ...t, usage: e };
    case "error":
      return { ...t, error: e.message };
    default:
      return t;
  }
}

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [turns, setTurns] = useState<ActivityTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ alerts: Alert[]; text: string | null } | null>(null);
  const [flash, setFlash] = useState<Record<string, number>>({});
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [sessionId, setSessionId] = useState(newSessionId);
  const [view, setView] = useState<"cards" | "apps">("cards");
  /** The backend knows this browser (hosted demo: its own household). */
  const [ready, setReady] = useState(false);
  /** Unrush is speaking first (or about to, after the late meeting). */
  const [proactive, setProactive] = useState(false);
  const [appResults, setAppResults] = useState<{ schedule: CallToolResult | null; order: CallToolResult | null }>({ schedule: null, order: null });
  const speaker = useSpeaker();
  const speakRef = useRef(speaker.speak);
  speakRef.current = speaker.speak;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("unrush.theme", theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);

  const connect = useCallback(async () => {
    try {
      await startSession();
      setReady(true);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void connect();
  }, [connect]);

  const refresh = useCallback(async () => {
    try {
      const s = await fetchState();
      setState(s);
      setStatus(s.status);
      setError(null);
    } catch (err) {
      // The hosted demo forgot this browser (its household expired): start a new one.
      if ((err as { status?: number }).status === 401) {
        setReady(false);
        void connect();
      } else setError((err as Error).message);
    }
  }, [connect]);

  const pulse = useCallback((tool: string) => {
    const card = CARD_FOR_TOOL[tool];
    if (card) setFlash((f) => ({ ...f, [card]: Date.now() }));
  }, []);

  // Step 6 of the demo: after a reload, show that long-term memory came back from the MCP server.
  const greeted = useRef(false);
  useEffect(() => {
    if (!state || greeted.current) return;
    greeted.current = true;
    const bits = [
      state.tonight?.previous_meal ? `tonight's swap to ${state.tonight.meal}` : "",
      state.order?.status === "placed" ? `your order ${state.order.confirmation_number}` : state.order ? "your draft grocery order" : "",
      state.schedule.events.some((e) => e.previous_end) ? "the meeting that ran late" : "",
    ].filter(Boolean);
    if (bits.length) setMessages((m) => (m.length ? m : [{ role: "assistant", text: `Welcome back. I still remember ${bits.join(", ")}. It's all saved in the MCP server.` }]));
  }, [state]);

  /** Clear the conversation on screen (the demo was reset). */
  const clearScreen = useCallback(() => {
    setMessages([]);
    setTurns([]);
    setBanner(null);
    setProactive(false);
    greeted.current = true;
  }, []);

  // Initial load + a light poll so changes made outside this tab (e.g. demo:trigger) show up.
  useEffect(() => {
    if (!ready) return;
    void refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [ready, refresh]);

  // Proactive channel: Unrush speaks first.
  useEffect(() => {
    if (!ready) return;
    const onMessage = (msg: MessageEvent<string>) => {
      const e = JSON.parse(msg.data) as ServerEvent;
      if (e.type === "status") setStatus(e.status);
      else if (e.type === "proactive_start") {
        setProactive(true);
        setBanner({ alerts: e.alerts, text: null });
        setTurns((ts) => [...ts, { id: e.runId, user: `Unrush spoke first: ${e.alerts.map((a) => a.title).join(" · ")}`, proactive: true, items: [] }]);
        void refresh();
      } else if (e.type === "agent" && e.source === "proactive") {
        setTurns((ts) => ts.map((t) => (t.id === e.runId ? reduceTurn(t, e.event) : t)));
        if (e.event.type === "tool_result") pulse(e.event.name);
      } else if (e.type === "proactive_end") {
        setProactive(false);
        setBanner((b) => (b ? { ...b, text: e.reply } : b));
        setMessages((m) => [...m, { role: "assistant", text: e.reply }]);
        setTurns((ts) => ts.map((t) => (t.id === e.runId ? { ...t, reply: e.reply, error: e.fallback ? `Model unavailable, spoke the alert text instead. ${e.error ?? ""}` : t.error } : t)));
        speakRef.current(e.reply);
      } else if (e.type === "state_changed") void refresh();
      else if (e.type === "reset") clearScreen();
    };
    // A browser gives up on an EventSource after an error response (e.g. while the backend
    // restarts behind a proxy), so reopen it ourselves.
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const open = () => {
      es = new EventSource("/api/events");
      es.onmessage = onMessage;
      es.onerror = () => {
        if (es?.readyState === EventSource.CLOSED && !stopped) {
          retry = setTimeout(() => {
            open();
            void refresh();
          }, 2000);
        }
      };
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(retry);
      es?.close();
    };
  }, [ready, refresh, pulse, clearScreen]);

  const runLate = useCallback(async () => {
    setProactive(true);
    // If Unrush doesn't speak (lost connection, server error), don't leave the guide stuck on "working".
    setTimeout(() => setProactive((p) => (p ? false : p)), 45_000);
    try {
      await runMeetingLate();
      pulse("add_or_update_event");
      void refresh();
    } catch (err) {
      setProactive(false);
      setMessages((m) => [...m, { role: "error", text: (err as Error).message }]);
    }
  }, [pulse, refresh]);

  const startOver = useCallback(async () => {
    window.speechSynthesis?.cancel();
    try {
      await resetDemo();
      clearScreen();
      await resetSession(sessionId);
      setSessionId(newSessionId());
      void refresh();
    } catch (err) {
      setMessages((m) => [...m, { role: "error", text: (err as Error).message }]);
    }
  }, [clearScreen, sessionId, refresh]);

  const send = useCallback(
    async (text: string) => {
      if (busy) return;
      setBusy(true);
      window.speechSynthesis?.cancel();
      const id = crypto.randomUUID();
      setMessages((m) => [...m, { role: "user", text }]);
      setTurns((ts) => [...ts, { id, user: text, items: [] }]);
      let reply = "";
      await streamChat(sessionId, text, (e) => {
        setTurns((ts) => ts.map((t) => (t.id === id ? reduceTurn(t, e) : t)));
        if (e.type === "tool_result") {
          pulse(e.name);
          void refresh();
        }
        if (e.type === "reply") reply = e.text;
        if (e.type === "error") setMessages((m) => [...m, { role: "error", text: e.message }]);
      }).catch((err) => setMessages((m) => [...m, { role: "error", text: (err as Error).message }]));
      if (reply) {
        setMessages((m) => [...m, { role: "assistant", text: reply }]);
        speakRef.current(reply);
      }
      setBusy(false);
      void refresh();
    },
    [busy, sessionId, pulse, refresh],
  );

  const newSession = useCallback(async () => {
    await resetSession(sessionId);
    setSessionId(newSessionId());
    setMessages([]);
    setTurns([]);
    setBanner(null);
    void refresh();
  }, [sessionId, refresh]);

  // MCP Apps mode: fetch the linked tools' results whenever the household state changes.
  const stateKey = state ? JSON.stringify([state.schedule.events, state.order, state.tonight]) : "";
  useEffect(() => {
    if (view !== "apps" || !stateKey) return;
    const call = (name: string) =>
      fetch("/api/apps/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, arguments: {} }) }).then((r) => r.json() as Promise<CallToolResult>);
    void Promise.all([call("get_schedule"), call("get_order")]).then(([schedule, order]) => setAppResults({ schedule, order }));
  }, [view, stateKey]);

  const offline = status?.offline ?? false;
  const publicDemo = status?.publicDemo ?? false;
  const step = state ? demoStep(state) : null;
  const working = busy || proactive;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <div>
            <div className="brand-name">Unrush</div>
            <div className="brand-sub">Proactive household assistant · a simulated Alexa+ experience</div>
          </div>
        </div>
        <div className="status">
          <div className="tech" aria-label="What's running">
            <ChipIcon width={15} height={15} />
            <span title={`${status?.tools ?? 0} tools over Streamable HTTP`}>
              <i className={status?.protocolVersion ? "on" : "off"} /> MCP {status?.protocolVersion ?? "—"}
            </span>
            <span className={offline ? "warn" : ""} title={status?.model}>{offline ? "Offline rehearsal (not Bedrock)" : "Amazon Bedrock · Nova"}</span>
            {status?.memory?.startsWith("Amazon") && <span>AgentCore Memory</span>}
          </div>
          {state && (
            <span className="chip-status clock" title="The demo clock: every visit starts at 3pm">
              <span className="clock-day">{new Date(`${state.schedule.date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })}</span> {clock(state.schedule.now)}
            </span>
          )}
          <div className="view-toggle" role="group" aria-label="Card view">
            <button className={view === "cards" ? "on" : ""} onClick={() => setView("cards")}>Cards</button>
            <button className={view === "apps" ? "on" : ""} onClick={() => setView("apps")} title="The same cards, served by the MCP server as MCP Apps (ui:// resources)">MCP Apps</button>
          </div>
          <button className="icon-btn" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} aria-label="Toggle light/dark mode">
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </header>

      {step && <DemoGuide step={step} working={working} onLate={runLate} onSay={send} onReset={startOver} />}
      {/* The banner is the "speaks first" moment; once the story moves on, the guide takes over. */}
      {banner && (step?.index ?? 0) <= 1 && <AlertBanner alerts={banner.alerts} text={banner.text} onClose={() => setBanner(null)} />}
      {error && <div className="error-bar">{error}</div>}
      {status?.problems?.length ? <div className="error-bar">{status.problems.join(" ")}</div> : null}

      <main className="grid">
        <VoicePanel
          messages={messages}
          busy={busy}
          speaking={speaker.speaking}
          muted={speaker.muted}
          onToggleMute={speaker.toggleMute}
          onSend={send}
          onNewSession={newSession}
          suggestions={step?.suggestions ?? []}
          intro="Hi, I'm Unrush. It's 3pm: you have a 5:30 project sync, a study group across town at 7:30, and a 45-minute curry planned for dinner. Make the meeting run late (button above) and I'll speak up as soon as your evening stops adding up."
        />
        <div className="cards">
          {state && view === "apps" ? (
            <>
              <McpAppFrame uri="ui://unrush/evening.html" toolName="get_schedule" result={appResults.schedule} theme={theme} onMessage={send} />
              <McpAppFrame uri="ui://unrush/order.html" toolName="get_order" result={appResults.order} theme={theme} onMessage={send} />
            </>
          ) : state ? (
            <>
              <TimelineCard state={state} flash={!!flash.timeline} key={`t${flash.timeline ?? 0}`} />
              <div className="card-row">
                <DinnerCard tonight={state.tonight} alerts={state.alerts} flash={!!flash.dinner} key={`d${flash.dinner ?? 0}`} />
                <OrderCard order={state.order} busy={busy} onConfirm={() => send("Yes, place the order.")} onChoose={(item, title) => send(`For ${item}, I'll take the ${title}.`)} flash={!!flash.order} key={`o${flash.order ?? 0}`} />
              </div>
              <div className="card-row">
                <RunoutCard predictions={state.runouts.predictions} today={state.runouts.today} flash={!!flash.runout} key={`r${flash.runout ?? 0}`} />
                <PantryCard pantry={state.pantry} flash={!!flash.pantry} key={`p${flash.pantry ?? 0}`} />
              </div>
            </>
          ) : (
            <div className="card empty">{error ? "Can't reach Unrush right now." : publicDemo || !ready ? "Setting up your own demo household…" : "Connecting to the Unrush backend…"}</div>
          )}
        </div>
        <ActivityPanel turns={turns} offline={offline} />
      </main>
      <footer className="foot">
        Calendar, travel times and checkout are <b>simulated</b>; the AI, the MCP server and the Amazon product links are real. Nothing is bought without your explicit yes, and no card data is ever handled.
        {publicDemo ? " This browser has its own demo household, deleted after 24 hours." : " Data stays on this machine."}
      </footer>
    </div>
  );
}
