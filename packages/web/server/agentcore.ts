/**
 * Amazon Bedrock AgentCore Memory (optional; on when AGENTCORE_MEMORY_ID is set).
 *
 * - Short-term: every conversation turn is stored as an AgentCore *event*
 *   (USER + ASSISTANT conversational payloads) for actor = household and
 *   session = household + local date. A new browser session or a restarted
 *   backend reloads the day's turns, so the conversation survives both.
 * - Long-term: the memory's user-preference strategy (created by
 *   `npm run agentcore:setup`) extracts household preferences from those events;
 *   relevant records are retrieved into the system prompt each turn.
 *
 * Household *state* (pantry, plan, orders) stays in the MCP server; this is
 * conversational memory. All calls are best-effort: failures are logged and the
 * turn carries on with in-process memory.
 */
import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  DeleteEventCommand,
  ListEventsCommand,
  RetrieveMemoryRecordsCommand,
  type PayloadType,
} from "@aws-sdk/client-bedrock-agentcore";
import type { Turn } from "./agent.js";

export const PREFERENCES_NAMESPACE = (actorId: string) => `/households/${actorId}/preferences`;

export type AgentCoreSend = Pick<BedrockAgentCoreClient, "send">;

export function createAgentCoreClient(region: string): BedrockAgentCoreClient {
  return new BedrockAgentCoreClient({ region: region || undefined, maxAttempts: 2 });
}

export class AgentCoreMemory {
  readonly name = "Amazon Bedrock AgentCore Memory";

  constructor(
    private readonly client: AgentCoreSend,
    readonly memoryId: string,
    readonly actorId: string,
  ) {}

  /** One AgentCore session per household per local day (ids: letters, digits, - and _). */
  sessionFor(date: string): string {
    return `${this.actorId}-${date}`.replace(/[^A-Za-z0-9_-]/g, "-");
  }

  async saveTurn(date: string, turn: Turn, at = new Date()): Promise<void> {
    const payload: PayloadType[] = [
      { conversational: { role: "USER", content: { text: turn.user } } },
      { conversational: { role: "ASSISTANT", content: { text: turn.assistant } } },
    ];
    await this.client.send(
      new CreateEventCommand({ memoryId: this.memoryId, actorId: this.actorId, sessionId: this.sessionFor(date), eventTimestamp: at, payload }),
    );
  }

  /** The day's turns, oldest first, at most `max`. */
  async loadTurns(date: string, max: number): Promise<Turn[]> {
    const res = await this.client.send(
      new ListEventsCommand({ memoryId: this.memoryId, actorId: this.actorId, sessionId: this.sessionFor(date), includePayloads: true, maxResults: 100 }),
    );
    const events = [...(res.events ?? [])].sort((a, b) => (a.eventTimestamp?.getTime() ?? 0) - (b.eventTimestamp?.getTime() ?? 0));
    const turns: Turn[] = [];
    for (const e of events) {
      const text = (role: string) =>
        (e.payload ?? [])
          .map((p) => (p.conversational?.role === role ? (p.conversational.content?.text ?? "") : ""))
          .filter(Boolean)
          .join(" ");
      const user = text("USER");
      const assistant = text("ASSISTANT");
      if (user || assistant) turns.push({ user, assistant });
    }
    return turns.slice(-max);
  }

  /** Delete the day's conversation events (used by `npm run seed` so demo takes start fresh). Returns how many. */
  async clearDay(date: string): Promise<number> {
    const sessionId = this.sessionFor(date);
    let deleted = 0;
    let nextToken: string | undefined;
    do {
      const res = await this.client.send(
        new ListEventsCommand({ memoryId: this.memoryId, actorId: this.actorId, sessionId, includePayloads: false, maxResults: 100, nextToken }),
      );
      for (const e of res.events ?? []) {
        if (!e.eventId) continue;
        await this.client.send(new DeleteEventCommand({ memoryId: this.memoryId, actorId: this.actorId, sessionId, eventId: e.eventId }));
        deleted++;
      }
      nextToken = res.nextToken;
    } while (nextToken);
    return deleted;
  }

  /** Long-term household preferences relevant to the query (from the user-preference strategy). */
  async recall(query: string, topK = 3): Promise<string[]> {
    const res = await this.client.send(
      new RetrieveMemoryRecordsCommand({
        memoryId: this.memoryId,
        namespace: PREFERENCES_NAMESPACE(this.actorId),
        searchCriteria: { searchQuery: query.slice(0, 500), topK },
      }),
    );
    return (res.memoryRecordSummaries ?? []).map((r) => r.content?.text ?? "").filter(Boolean);
  }
}

/** System-prompt section for recalled long-term memories. */
export function recallBlock(records: string[]): string {
  return records.length ? `WHAT YOU REMEMBER ABOUT THIS HOUSEHOLD (AgentCore Memory)\n${records.map((r) => `- ${r}`).join("\n")}` : "";
}
