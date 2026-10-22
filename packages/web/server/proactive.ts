/**
 * Unrush speaks first. The backend polls the MCP server's get_alerts; when new
 * alerts appear it claims them (mark_delivered) and runs the agent with a
 * proactive instruction, streaming everything to the browser over SSE.
 */
import type { AgentEvent } from "./agent.js";

export interface AlertLike {
  id: string;
  kind: "leave_by" | "meal_fit" | "runout";
  title: string;
  message: string;
  data: Record<string, unknown>;
}

export const PROACTIVE_MARKER = "[PROACTIVE]";

/** The instruction the agent receives in place of a user message when Unrush speaks first. */
export function proactiveInstruction(alerts: AlertLike[]): string {
  const lines = alerts.map((a) => `- ${a.kind}: ${a.message}`);
  const meal = alerts.find((a) => a.kind === "meal_fit");
  const runoutOnly = alerts.every((a) => a.kind === "runout");
  const steps = [
    "Speak first: the user has not said anything. In two or three short sentences:",
    alerts.some((a) => a.kind === "leave_by") ? "1. Say what changed and exactly when they need to leave." : "",
    meal
      ? `2. Tonight's dinner no longer fits: call suggest_quick_meal with max_minutes ${Number(meal.data.suggested_max_minutes ?? 15)}, and offer the top suggestion using its exact name and prep time from the tool result.`
      : "",
    runoutOnly ? "Mention what is out or running low and offer to put a grocery order together." : "",
    "End with ONE yes/no question. Do not change the plan, and do not build or place any order yet.",
  ].filter(Boolean);
  return `${PROACTIVE_MARKER} These alerts just fired:\n${lines.join("\n")}\n\n${steps.join("\n")}`;
}

/** Spoken fallback when the model is unavailable: the alert texts themselves (built by the MCP server). */
export function fallbackSpeech(alerts: AlertLike[]): string {
  return alerts.map((a) => a.message).join(" ");
}

export type ServerEvent =
  | { type: "status"; status: Record<string, unknown> }
  | { type: "proactive_start"; runId: string; alerts: AlertLike[] }
  | { type: "agent"; runId: string; source: "proactive" | "chat"; event: AgentEvent }
  | { type: "proactive_end"; runId: string; reply: string; fallback: boolean; error?: string }
  | { type: "state_changed" }
  /** The demo household was re-seeded: clear the conversation on screen. */
  | { type: "reset" };
