import type { AgentEvent, AppState } from "./types";

export async function fetchState(): Promise<AppState> {
  const res = await fetch("/api/state");
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Backend unavailable");
  return body as AppState;
}

/** POST a message and stream back AgentEvents (server-sent events over a fetch body). */
export async function streamChat(sessionId: string, message: string, onEvent: (e: AgentEvent) => void): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    onEvent({ type: "error", message: body.error ?? `Request failed (${res.status})` });
    return;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) onEvent(JSON.parse(line.slice(6)) as AgentEvent);
    }
  }
}

export async function resetSession(sessionId: string) {
  await fetch("/api/reset-session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId }) });
}

export function newSessionId(): string {
  return crypto.randomUUID();
}

/** "2026-10-23T19:05" → "7:05pm" */
export function clock(t: string | null | undefined): string {
  if (!t) return "";
  const [h, m] = t.slice(-5).split(":").map(Number) as [number, number];
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h >= 12 ? "pm" : "am"}`;
}

export function minutesOf(t: string): number {
  const [h, m] = t.slice(-5).split(":").map(Number) as [number, number];
  return h * 60 + m;
}
