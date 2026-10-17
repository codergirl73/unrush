import { useCallback, useEffect, useRef, useState } from "react";
import { clock, fetchState, newSessionId, resetSession, streamChat } from "./api";
import { ActivityPanel, type ActivityItem, type ActivityTurn } from "./components/ActivityPanel";
import { AlertBanner, DinnerCard, OrderCard, PantryCard, RunoutCard, TimelineCard } from "./components/Cards";
import { Logo, MoonIcon, SunIcon } from "./components/icons";
import { VoicePanel, type ChatMessage } from "./components/VoicePanel";
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

  const refresh = useCallback(async () => {
    try {
      const s = await fetchState();
      setState(s);
      setStatus(s.status);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

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

  // Initial load + a light poll so changes made outside this tab (e.g. demo:trigger) show up.
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  // Proactive channel: Unrush speaks first.
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (msg) => {
      const e = JSON.parse(msg.data) as ServerEvent;
      if (e.type === "status") setStatus(e.status);
      else if (e.type === "proactive_start") {
        setBanner({ alerts: e.alerts, text: null });
        setTurns((ts) => [...ts, { id: e.runId, user: `Unrush spoke first: ${e.alerts.map((a) => a.title).join(" · ")}`, proactive: true, items: [] }]);
        void refresh();
      } else if (e.type === "agent" && e.source === "proactive") {
        setTurns((ts) => ts.map((t) => (t.id === e.runId ? reduceTurn(t, e.event) : t)));
        if (e.event.type === "tool_result") pulse(e.event.name);
      } else if (e.type === "proactive_end") {
        setBanner((b) => (b ? { ...b, text: e.reply } : b));
        setMessages((m) => [...m, { role: "assistant", text: e.reply }]);
        setTurns((ts) => ts.map((t) => (t.id === e.runId ? { ...t, reply: e.reply, error: e.fallback ? `Model unavailable, spoke the alert text instead. ${e.error ?? ""}` : t.error } : t)));
        speakRef.current(e.reply);
      } else if (e.type === "state_changed") void refresh();
    };
    return () => es.close();
  }, [refresh, pulse]);

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

  const offline = status?.offline ?? false;

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
          {state && <span className="chip-status clock">{new Date(`${state.schedule.date}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })} {clock(state.schedule.now)}</span>}
          <span className="chip-status">
            <i className={status?.protocolVersion ? "on" : "off"} /> MCP {status?.protocolVersion ?? "—"} · Streamable HTTP · {status?.tools ?? 0} tools
          </span>
          <span className={`chip-status ${offline ? "warn" : ""}`}>{offline ? "Offline rehearsal (not Bedrock)" : `Amazon Bedrock · ${status?.model ?? "…"}`}</span>
          <button className="icon-btn" onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))} aria-label="Toggle light/dark mode">
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </header>

      {banner && <AlertBanner alerts={banner.alerts} text={banner.text} onClose={() => setBanner(null)} />}
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
        />
        <div className="cards">
          {state ? (
            <>
              <TimelineCard state={state} flash={!!flash.timeline} key={`t${flash.timeline ?? 0}`} />
              <div className="card-row">
                <DinnerCard tonight={state.tonight} alerts={state.alerts} flash={!!flash.dinner} key={`d${flash.dinner ?? 0}`} />
                <OrderCard order={state.order} busy={busy} onConfirm={() => send("Yes, place the order.")} flash={!!flash.order} key={`o${flash.order ?? 0}`} />
              </div>
              <div className="card-row">
                <RunoutCard predictions={state.runouts.predictions} today={state.runouts.today} flash={!!flash.runout} key={`r${flash.runout ?? 0}`} />
                <PantryCard pantry={state.pantry} flash={!!flash.pantry} key={`p${flash.pantry ?? 0}`} />
              </div>
            </>
          ) : (
            <div className="card empty">Connecting to the Unrush backend…</div>
          )}
        </div>
        <ActivityPanel turns={turns} offline={offline} />
      </main>
      <footer className="foot">
        Calendar, travel times and checkout are <b>simulated</b>. Data stays on this machine; nothing is bought without your explicit yes and no card data is ever handled.
      </footer>
    </div>
  );
}
