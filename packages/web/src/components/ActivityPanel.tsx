import { useEffect, useRef, useState } from "react";
import { BoltIcon, ChevronIcon } from "./icons";

export type ActivityItem =
  | { kind: "model"; iteration: number }
  | { kind: "interim"; text: string }
  | { kind: "memory"; action: string; ok: boolean; detail: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; result?: { ok: boolean; ms: number; data: Record<string, unknown> } };

export interface ActivityTurn {
  id: string;
  user: string;
  /** Unrush spoke first (no user message). */
  proactive?: boolean;
  items: ActivityItem[];
  reply?: string;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number; modelCalls: number; toolCalls: number; ms: number };
}

const WRITE_TOOLS = new Set(["update_pantry", "set_preferences", "save_meal_plan", "mark_meal_cooked", "add_or_update_event", "build_grocery_order", "place_order"]);

export function ActivityPanel({ turns, offline }: { turns: ActivityTurn[]; offline: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  return (
    <section className="panel activity" aria-label="Agent activity">
      <header className="panel-head">
        <div className="panel-title">
          <BoltIcon /> Agent activity
        </div>
        <div className="legend">
          <span className="dot read" /> read
          <span className="dot write" /> write
        </div>
      </header>
      <div className="activity-scroll">
        {turns.length === 0 && (
          <div className="empty">
            Every step shows up here live: each {offline ? "scripted rehearsal model" : "Amazon Bedrock Converse"} call and each MCP tool call, with inputs and results. Proactive runs start with a bolt.
          </div>
        )}
        {turns.map((t) => (
          <div key={t.id} className={`turn ${t.proactive ? "is-proactive" : ""}`}>
            {t.proactive ? (
              <div className="turn-user proactive"><BoltIcon width={14} height={14} /> {t.user}</div>
            ) : (
              <div className="turn-user">“{t.user}”</div>
            )}
            <ol className="steps">
              {t.items.map((it, i) =>
                it.kind === "model" ? (
                  <li key={i} className="step model">
                    <span className="step-dot" />
                    {offline ? "Scripted model" : "Bedrock Converse"} · step {it.iteration}
                  </li>
                ) : it.kind === "memory" ? (
                  <li key={i} className={`step memory ${it.ok ? "" : "fail"}`}>
                    <span className="step-dot" />
                    AgentCore Memory · {it.action} · {it.detail}
                  </li>
                ) : it.kind === "interim" ? (
                  <li key={i} className="step interim">
                    <span className="step-dot" />
                    {it.text}
                  </li>
                ) : (
                  <ToolStep key={it.id} item={it} />
                ),
              )}
              {!t.reply && !t.error && (
                <li className="step pending">
                  <span className="spinner" /> working…
                </li>
              )}
            </ol>
            {t.error && <div className="turn-error">{t.error}</div>}
            {t.usage && (
              <div className="usage">
                {t.usage.modelCalls} model {t.usage.modelCalls === 1 ? "call" : "calls"} · {t.usage.toolCalls} MCP tool{" "}
                {t.usage.toolCalls === 1 ? "call" : "calls"} · {(t.usage.inputTokens + t.usage.outputTokens).toLocaleString()} tokens ·{" "}
                {(t.usage.ms / 1000).toFixed(1)}s
              </div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
    </section>
  );
}

function ToolStep({ item }: { item: Extract<ActivityItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const write = WRITE_TOOLS.has(item.name);
  const r = item.result;
  return (
    <li className={`step tool ${write ? "write" : "read"} ${r ? (r.ok ? "ok" : "fail") : "running"}`}>
      <button className="tool-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="step-dot" />
        <code className="tool-name">{item.name}</code>
        <span className="tool-args">{summarizeInput(item.input)}</span>
        <span className="tool-meta">
          {r ? (
            <>
              <span className={`pill ${r.ok ? "ok" : "fail"}`}>{r.ok ? "ok" : "error"}</span>
              <span className="ms">{r.ms}ms</span>
            </>
          ) : (
            <span className="spinner" />
          )}
          <ChevronIcon className={`chev ${open ? "open" : ""}`} width={14} height={14} />
        </span>
      </button>
      {r && <div className="tool-summary">{summarizeResult(item.name, r)}</div>}
      {open && (
        <div className="tool-detail">
          <div className="detail-label">input</div>
          <pre>{JSON.stringify(item.input, null, 2)}</pre>
          {r && (
            <>
              <div className="detail-label">result</div>
              <pre>{truncate(JSON.stringify(r.data, null, 2), 4000)}</pre>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function summarizeInput(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (Array.isArray(v)) {
      if (k === "changes") parts.push(v.map((c: { action?: string; item?: string }) => `${c.action} ${c.item}`).join(", "));
      else if (k === "days") parts.push(`${v.length} days`);
      else parts.push(`${k}[${v.length}]`);
    } else if (v && typeof v === "object") parts.push(`${k}: ${Object.entries(v).map(([a, b]) => `${a}=${b}`).join(", ")}`);
    else parts.push(`${k === "week_start" || k === "date" ? "" : k + ": "}${v}`);
  }
  return truncate(parts.join(" · "), 70);
}

function summarizeResult(name: string, r: { ok: boolean; data: Record<string, unknown> }): string {
  const d = r.data as Record<string, any>;
  if (!r.ok) return truncate(String(d.text ?? d.error ?? "error").replace(/^Error: /, ""), 160);
  switch (name) {
    case "get_schedule":
      return `${d.events?.length ?? 0} events · now ${String(d.now ?? "").slice(11)}`;
    case "add_or_update_event":
      return `${d.event?.title}: ${String(d.event?.start).slice(11)}–${String(d.event?.end).slice(11)}${d.event?.previous_end ? ` (was until ${String(d.event.previous_end).slice(11)})` : ""}`;
    case "compute_leave_by":
      return `leave by ${d.leave_by_spoken} · ${d.travel_minutes} min travel + ${d.buffer_minutes} buffer`;
    case "get_pantry":
      return `${d.item_count} items on hand`;
    case "update_pantry": {
      const noop = (d.results ?? []).filter((r: { status: string }) => r.status === "noop").length;
      return `${d.applied} applied${noop ? `, ${noop} not in pantry` : ""}${d.errors ? `, ${d.errors} error(s)` : ""} → ${d.pantry?.length} items`;
    }
    case "get_preferences": {
      const p = d.preferences ?? {};
      return `${p.household_size} people · dinner by ${p.latest_dinner_time}`;
    }
    case "set_preferences":
      return "preferences saved";
    case "save_meal_plan":
      return `${d.days?.length} meals saved${d.warnings?.length ? ` · ⚠ ${d.warnings.length} warning(s)` : " · no rule conflicts"}`;
    case "get_meal_plan":
      return `${d.days?.length ?? 0} meals planned`;
    case "suggest_quick_meal": {
      const s = d.suggestions?.[0];
      return s ? `best: ${s.name} (${s.prep_minutes} min, ${s.missing.length ? `${s.missing.length} missing` : "all in pantry"})` : "no match";
    }
    case "mark_meal_cooked":
      return d.already_cooked ? "already cooked, no change" : `${d.meal}: ${d.pantry_changes?.length} pantry items updated`;
    case "predict_runouts":
      return (d.predictions ?? []).map((p: { item: string; status: string; predicted_runout_date: string }) => `${p.item}: ${p.status === "out" ? "out" : p.predicted_runout_date}`).join(" · ") || "nothing running low";
    case "build_grocery_order":
      return `draft · ${d.item_count} items (simulated store)`;
    case "get_order":
      return d.order ? `${d.order.status} · ${d.order.item_count} items` : "no orders";
    case "place_order":
      return `placed · ${d.confirmation_number} (simulated)`;
    case "get_alerts":
      return `${d.count} alert(s)`;
    default:
      return "";
  }
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
