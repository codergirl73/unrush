/**
 * Short-term conversation memory: the last N turns per browser session. Long-term
 * state lives in the MCP server. Proactive turns (Unrush speaking first) are
 * appended to every session and kept as a shared starting point, so a session
 * whose first words are "yes" still knows what it is agreeing to.
 */
import type { Turn } from "./agent.js";

export class ConversationMemory {
  private sessions = new Map<string, { turns: Turn[]; seen: number }>();
  private shared: Turn[] = [];

  constructor(
    private readonly maxTurns: number,
    private readonly maxSessions = 200,
  ) {}

  get(sessionId: string): Turn[] {
    const s = this.sessions.get(sessionId);
    if (s) s.seen = Date.now();
    return s ? [...s.turns] : [...this.shared];
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Start a session from turns loaded elsewhere (AgentCore Memory). */
  seed(sessionId: string, turns: Turn[]) {
    this.sessions.set(sessionId, { turns: turns.slice(-this.maxTurns), seen: Date.now() });
  }

  lastAssistant(sessionId: string): string | undefined {
    return this.get(sessionId).at(-1)?.assistant;
  }

  add(sessionId: string, turn: Turn) {
    const s = this.sessions.get(sessionId) ?? { turns: [...this.shared], seen: 0 };
    s.turns = [...s.turns, turn].slice(-this.maxTurns);
    s.seen = Date.now();
    this.sessions.set(sessionId, s);
    if (this.sessions.size > this.maxSessions) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].seen - b[1].seen)[0]![0];
      this.sessions.delete(oldest);
    }
  }

  /** Unrush spoke first: every session (and any new one) should know. */
  broadcast(turn: Turn) {
    this.shared = [...this.shared, turn].slice(-this.maxTurns);
    for (const id of this.sessions.keys()) this.add(id, turn);
  }

  clear(sessionId?: string) {
    if (sessionId) this.sessions.delete(sessionId);
    else {
      this.sessions.clear();
      this.shared = [];
    }
  }
}
