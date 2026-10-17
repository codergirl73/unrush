/** Short-term conversation memory: the last N turns per browser session. Long-term state lives in the MCP server. */
import type { Turn } from "./agent.js";

export class ConversationMemory {
  private sessions = new Map<string, { turns: Turn[]; seen: number }>();

  constructor(
    private readonly maxTurns: number,
    private readonly maxSessions = 200,
  ) {}

  get(sessionId: string): Turn[] {
    const s = this.sessions.get(sessionId);
    if (s) s.seen = Date.now();
    return s ? [...s.turns] : [];
  }

  lastAssistant(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.turns.at(-1)?.assistant;
  }

  add(sessionId: string, turn: Turn) {
    const s = this.sessions.get(sessionId) ?? { turns: [], seen: 0 };
    s.turns = [...s.turns, turn].slice(-this.maxTurns);
    s.seen = Date.now();
    this.sessions.set(sessionId, s);
    if (this.sessions.size > this.maxSessions) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].seen - b[1].seen)[0]![0];
      this.sessions.delete(oldest);
    }
  }

  /** Append to every session (used when Unrush speaks first, so later "yes" has context). */
  broadcast(turn: Turn) {
    for (const id of this.sessions.keys()) this.add(id, turn);
  }

  clear(sessionId?: string) {
    if (sessionId) this.sessions.delete(sessionId);
    else this.sessions.clear();
  }
}
